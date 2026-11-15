// Turns a validated document into sheet rows and Telegram messages.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function money(n, currency) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${formatted}` : formatted;
}

function issuesText(v) {
  return [...(v.errors || []).map((e) => `❌ ${e.msg}`), ...(v.warnings || []).map((w) => `⚠️ ${w.msg}`)].join('\n');
}

/** Flat object whose keys match the sheet headers exactly. */
function toRow(doc) {
  const x = doc.extraction || {};
  const v = doc.validation || {};
  return {
    processed_at: doc.processed_at,
    status: v.status,
    score: v.score,
    confidence: typeof x.confidence?.overall === 'number' ? x.confidence.overall : '',
    document_type: x.document_type || '',
    supplier_name: x.supplier?.name || '',
    supplier_tax_id: x.supplier?.tax_id || '',
    customer_name: x.customer?.name || '',
    invoice_number: x.invoice_number || '',
    document_date: x.document_date || '',
    due_date: x.due_date || '',
    currency: x.currency || '',
    subtotal: x.subtotal ?? '',
    discount: x.discount ?? '',
    shipping: x.shipping ?? '',
    tax_amount: x.tax_amount ?? '',
    total: x.total ?? '',
    amount_paid: x.amount_paid ?? '',
    payment_method: x.payment_method || '',
    line_item_count: Array.isArray(x.line_items) ? x.line_items.length : 0,
    line_items_json: JSON.stringify(x.line_items || []),
    issues: issuesText(v).replace(/\n/g, ' | '),
    extraction_notes: x.extraction_notes || '',
    file_name: doc.file.name,
    file_id: doc.file.id,
    file_link: doc.file.link,
    dedupe_key: v.dedupe_key || '',
    model: doc.model || '',
    execution_id: doc.execution_id || '',
    duration_ms: doc.duration_ms ?? '',
  };
}

function telegramText(doc, sheetUrl) {
  const x = doc.extraction || {};
  const v = doc.validation || {};
  const head = {
    needs_review: '🟡 <b>Invoice needs review</b>',
    duplicate: '🔁 <b>Duplicate document skipped</b>',
    rejected: '🚫 <b>Document rejected</b>',
    auto_approved: '✅ <b>Invoice processed</b>',
  }[v.status] || '<b>Document processed</b>';

  const lines = [
    head,
    `📄 <a href="${esc(doc.file.link)}">${esc(doc.file.name)}</a>`,
  ];
  if (x.supplier?.name) lines.push(`🏢 ${esc(x.supplier.name)}${x.invoice_number ? ` · #${esc(x.invoice_number)}` : ''}`);
  if (typeof x.total === 'number') lines.push(`💰 ${esc(money(x.total, x.currency))}${x.document_date ? ` · ${esc(x.document_date)}` : ''}`);
  if (v.status !== 'rejected' && v.status !== 'duplicate') lines.push(`📊 Score ${v.score}/100`);
  if (v.reason) lines.push(`ℹ️ ${esc(v.reason)}`);
  const issues = issuesText(v);
  if (issues) lines.push('', esc(issues));
  if (v.status === 'needs_review' && sheetUrl) {
    lines.push('', `👉 Fix any wrong values in the <a href="${esc(sheetUrl)}">Review Queue</a>, then set <b>decision</b> to APPROVE or REJECT.`);
  }
  return lines.join('\n').slice(0, 4000); // Telegram limit is 4096
}

if (typeof module !== 'undefined') module.exports = { toRow, telegramText, money, esc, issuesText };
