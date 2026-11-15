// Validation and scoring for extracted invoices/receipts.
// Pure functions: no n8n globals, so they are unit-tested in tests/.

const KNOWN_CURRENCIES = new Set([
  'NGN', 'USD', 'EUR', 'GBP', 'GHS', 'KES', 'ZAR', 'XOF', 'XAF', 'EGP', 'MAD', 'CAD', 'AUD',
  'JPY', 'CNY', 'INR', 'AED', 'SAR', 'CHF', 'SEK', 'NOK', 'DKK', 'BRL', 'MXN', 'SGD', 'HKD',
]);

const COMPANY_SUFFIXES = /\b(ltd|limited|plc|inc|incorporated|llc|llp|co|company|corp|corporation|enterprises?|ventures?|nig|nigeria|gmbh|sa|bv)\b/g;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

function normalizeSupplier(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeInvoiceNumber(num) {
  return String(num || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildDedupeKey(x) {
  const supplier = normalizeSupplier(x?.supplier?.name);
  const total = isNum(x?.total) ? round2(x.total).toFixed(2) : '';
  const inv = normalizeInvoiceNumber(x?.invoice_number);
  if (!supplier || !total) return '';
  // Invoice number is the strongest key; fall back to date + total for receipts.
  return inv ? `${supplier}|${inv}|${total}` : `${supplier}|${x?.document_date || 'nodate'}|${total}`;
}

/**
 * @param {object} x      Extraction returned by the model (matches EXTRACTION_SCHEMA)
 * @param {object} cfg    Thresholds (see DEFAULT_RULES)
 * @param {Date}   now    Injected for testability
 */
function validateExtraction(x, cfg = {}, now = new Date()) {
  const rules = { ...DEFAULT_RULES, ...cfg };
  const errors = [];   // must be fixed by a human before posting
  const warnings = []; // worth a look, but not blocking on their own
  const err = (code, msg) => errors.push({ code, msg });
  const warn = (code, msg) => warnings.push({ code, msg });

  if (!x || typeof x !== 'object') {
    err('NO_DATA', 'The model returned no usable data');
    return finish();
  }

  if (x.document_type === 'not_financial_document') {
    return finish('rejected', 'Not an invoice or receipt');
  }

  if (x.is_legible === false) err('ILLEGIBLE', 'Document is hard to read (blurry, cropped or damaged)');

  // ---- Required fields -------------------------------------------------
  if (!x.supplier?.name) err('MISSING_SUPPLIER', 'Supplier name is missing');
  if (!isNum(x.total)) err('MISSING_TOTAL', 'Total amount is missing');
  if (!x.currency) err('MISSING_CURRENCY', 'Currency is missing');
  if (!x.document_date) err('MISSING_DATE', 'Document date is missing');
  if (x.document_type === 'invoice' && !x.invoice_number) err('MISSING_INVOICE_NO', 'Invoice number is missing');

  // ---- Currency ----------------------------------------------------------
  if (x.currency) {
    if (!/^[A-Z]{3}$/.test(x.currency)) err('BAD_CURRENCY', `Currency "${x.currency}" is not a 3-letter ISO code`);
    else if (!KNOWN_CURRENCIES.has(x.currency)) warn('UNUSUAL_CURRENCY', `Unusual currency ${x.currency}`);
  }

  // ---- Dates -------------------------------------------------------------
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const docDate = x.document_date ? parseIsoDate(x.document_date) : null;
  if (x.document_date && !docDate) err('BAD_DATE', `Date "${x.document_date}" is not a valid YYYY-MM-DD date`);
  if (docDate) {
    const ageDays = (today - docDate) / 86400000;
    if (ageDays < -1) err('FUTURE_DATE', `Document date ${x.document_date} is in the future`);
    else if (ageDays > rules.max_age_days) warn('OLD_DOCUMENT', `Document is ${Math.round(ageDays)} days old`);
  }
  if (x.due_date) {
    const due = parseIsoDate(x.due_date);
    if (!due) warn('BAD_DUE_DATE', `Due date "${x.due_date}" is not a valid date`);
    else if (docDate && due < docDate) err('DUE_BEFORE_ISSUE', 'Due date is before the issue date');
  }

  // ---- Arithmetic --------------------------------------------------------
  const total = isNum(x.total) ? x.total : null;
  const tol = (ref) => Math.max(rules.abs_tolerance, Math.abs(ref || 0) * rules.pct_tolerance);
  const near = (a, b) => Math.abs(a - b) <= tol(b);

  if (total !== null) {
    if (total === 0) err('ZERO_TOTAL', 'Total is zero');
    if (total < 0 && x.document_type !== 'credit_note') err('NEGATIVE_TOTAL', 'Negative total on a non-credit-note');
  }

  const items = Array.isArray(x.line_items) ? x.line_items : [];
  items.forEach((li, i) => {
    if (isNum(li.quantity) && isNum(li.unit_price) && isNum(li.amount)) {
      const expected = round2(li.quantity * li.unit_price);
      if (!near(li.amount, expected)) {
        warn('LINE_MATH', `Line ${i + 1} (${li.description}): ${li.quantity} × ${li.unit_price} = ${expected}, but shows ${li.amount}`);
      }
    }
  });

  const itemAmounts = items.map((li) => li.amount).filter(isNum);
  const itemsSum = itemAmounts.length ? round2(itemAmounts.reduce((a, b) => a + b, 0)) : null;
  const subtotal = isNum(x.subtotal) ? x.subtotal : null;

  if (itemsSum !== null && itemAmounts.length === items.length && subtotal !== null && !near(itemsSum, subtotal)) {
    err('ITEMS_NE_SUBTOTAL', `Line items add up to ${itemsSum} but subtotal shows ${subtotal}`);
  }

  const base = subtotal !== null ? subtotal : (itemsSum !== null && itemAmounts.length === items.length ? itemsSum : null);
  if (base !== null && total !== null) {
    const expectedTotal = round2(
      base + (isNum(x.tax_amount) ? x.tax_amount : 0) - (isNum(x.discount) ? Math.abs(x.discount) : 0) + (isNum(x.shipping) ? x.shipping : 0),
    );
    if (!near(total, expectedTotal)) {
      err('TOTAL_MISMATCH', `Subtotal + tax − discount + charges = ${expectedTotal}, but total shows ${total}`);
    }
  }

  if (isNum(x.tax_rate_percent) && isNum(x.tax_amount) && base !== null && x.tax_rate_percent > 0) {
    const taxable = base - (isNum(x.discount) ? Math.abs(x.discount) : 0);
    const expectedTax = round2(taxable * x.tax_rate_percent / 100);
    const expectedTaxNoDiscount = round2(base * x.tax_rate_percent / 100);
    if (!near(x.tax_amount, expectedTax) && !near(x.tax_amount, expectedTaxNoDiscount)) {
      warn('TAX_MATH', `${x.tax_rate_percent}% tax should be about ${expectedTax}, but shows ${x.tax_amount}`);
    }
  }
  if (isNum(x.tax_amount) && base !== null && base > 0 && x.tax_amount / base > rules.max_tax_ratio) {
    warn('HIGH_TAX', `Tax is ${Math.round((x.tax_amount / base) * 100)}% of subtotal`);
  }
  if (isNum(x.amount_paid) && total !== null && x.amount_paid > total + tol(total)) {
    warn('OVERPAID', `Amount paid (${x.amount_paid}) is more than the total (${total})`);
  }
  if (total !== null && total >= rules.high_value_threshold) {
    warn('HIGH_VALUE', `High-value document (${total}); please double-check`);
  }

  // ---- Model confidence --------------------------------------------------
  const conf = x.confidence || {};
  if (isNum(conf.overall) && conf.overall < rules.min_confidence) {
    err('LOW_CONFIDENCE', `Model confidence is ${Math.round(conf.overall * 100)}%`);
  }
  ['supplier_name', 'invoice_number', 'document_date', 'total'].forEach((f) => {
    if (isNum(conf[f]) && conf[f] < rules.min_field_confidence) {
      warn('LOW_FIELD_CONFIDENCE', `Low confidence on ${f.replace('_', ' ')} (${Math.round(conf[f] * 100)}%)`);
    }
  });

  // ---- Prompt injection --------------------------------------------------
  // A document that tries to instruct the AI is never auto-approved.
  if (x.contains_instructions_to_ai === true) {
    err('PROMPT_INJECTION', 'Document contains hidden instructions aimed at the AI; check it was not tampered with');
  }

  return finish();

  function finish(forcedStatus, reason) {
    const score = Math.max(0, 100 - errors.length * rules.error_penalty - warnings.length * rules.warning_penalty);
    let status = forcedStatus;
    if (!status) {
      status = errors.length === 0 && score >= rules.auto_approve_min_score ? 'auto_approved' : 'needs_review';
    }
    // A forced reject (non-financial document) gets score 0 so it never looks "good" in reports.
    return {
      status,
      score: forcedStatus === 'rejected' ? 0 : score,
      errors,
      warnings,
      reason: reason || null,
      dedupe_key: status === 'rejected' ? '' : buildDedupeKey(x),
      items_sum: x ? (() => { const a = (x.line_items || []).map((l) => l.amount).filter(isNum); return a.length ? round2(a.reduce((p, c) => p + c, 0)) : null; })() : null,
    };
  }
}

const DEFAULT_RULES = {
  abs_tolerance: 0.05,          // currency units of rounding slack
  pct_tolerance: 0.005,         // 0.5% relative slack
  min_confidence: 0.80,         // below this overall confidence -> review
  min_field_confidence: 0.70,   // below this on a key field -> warning
  auto_approve_min_score: 80,   // with zero errors, score must be >= this
  error_penalty: 25,
  warning_penalty: 8,
  max_age_days: 730,
  max_tax_ratio: 0.30,
  high_value_threshold: 5000000, // in document currency; set per business
};

if (typeof module !== 'undefined') {
  module.exports = { validateExtraction, buildDedupeKey, normalizeSupplier, normalizeInvoiceNumber, parseIsoDate, DEFAULT_RULES };
}
