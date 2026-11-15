// Find Review Queue rows where a person set decision = APPROVE or REJECT
// and that have not been handled yet. Uses the reviewer's corrected values.
const cfg = $('Settings').first().json.cfg;
const now = new Date().toISOString();
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

const out = [];
for (const { json: r } of $input.all()) {
  if (!r.row_number || str(r.resolved_at)) continue;
  const decision = str(r.decision).toUpperCase();
  if (decision !== 'APPROVE' && decision !== 'REJECT') continue;

  const file = { id: str(r.file_id), name: str(r.file_name), link: str(r.file_link) };
  const base = { row_number: r.row_number, decision, file, resolved_at: now };

  if (decision === 'REJECT') {
    out.push({ json: { ...base, action: 'reject', new_decision: 'REJECT', resolution: 'Rejected by reviewer' } });
    continue;
  }

  let lineItems = [];
  try { lineItems = JSON.parse(str(r.line_items_json) || '[]'); } catch (e) { lineItems = []; }

  const x = {
    document_type: str(r.document_type) || 'invoice',
    supplier: { name: str(r.supplier_name) || null, tax_id: str(r.supplier_tax_id) || null },
    customer: { name: str(r.customer_name) || null },
    invoice_number: str(r.invoice_number) || null,
    document_date: str(r.document_date) || null,
    due_date: str(r.due_date) || null,
    currency: str(r.currency).toUpperCase() || null,
    subtotal: num(r.subtotal), discount: num(r.discount), shipping: num(r.shipping),
    tax_amount: num(r.tax_amount), total: num(r.total), amount_paid: num(r.amount_paid),
    payment_method: str(r.payment_method) || null,
    line_items: lineItems,
  };

  const missing = [];
  if (!x.supplier.name) missing.push('supplier_name');
  if (x.total === null) missing.push('total');
  if (!x.currency) missing.push('currency');
  if (!x.document_date) missing.push('document_date');
  if (missing.length) {
    out.push({ json: {
      ...base, action: 'blocked', new_decision: '', resolved_at: '',
      resolution: `Not posted: please fill in ${missing.join(', ')} and set decision again`,
      alert_text: `⛔ <b>Approval blocked</b>\n📄 <a href="${esc(file.link)}">${esc(file.name)}</a>\nMissing: ${esc(missing.join(', '))}`,
    } });
    continue;
  }

  // Re-check the corrected values. Reviewers can still approve with errors,
  // but the result is recorded so it is visible in the Invoices tab.
  const v = validateExtraction({ ...x, confidence: {}, is_legible: true }, cfg.RULES);
  const remaining = issuesText(v).replace(/\n/g, ' | ');
  out.push({ json: {
    ...base, action: 'post', new_decision: 'APPROVE',
    resolution: remaining ? `Posted with notes: ${remaining}` : 'Posted to Invoices',
    invoice_row: {
      processed_at: now,
      source: 'reviewed',
      document_type: x.document_type,
      supplier_name: x.supplier.name,
      supplier_tax_id: x.supplier.tax_id || '',
      customer_name: x.customer.name || '',
      invoice_number: x.invoice_number || '',
      document_date: x.document_date,
      due_date: x.due_date || '',
      currency: x.currency,
      subtotal: x.subtotal ?? '', discount: x.discount ?? '', shipping: x.shipping ?? '',
      tax_amount: x.tax_amount ?? '', total: x.total, amount_paid: x.amount_paid ?? '',
      payment_method: x.payment_method || '',
      line_item_count: lineItems.length,
      line_items_json: JSON.stringify(lineItems),
      score: v.score,
      confidence: num(r.confidence) ?? '',
      file_name: file.name, file_link: file.link, file_id: file.id,
      dedupe_key: buildDedupeKey(x),
    },
  } });
}
return out;
