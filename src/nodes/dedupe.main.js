// Mark documents already in the Invoices / Review Queue tabs (or repeated
// in this same batch) as duplicates, then build sheet rows and alert text.
const cfg = $('Settings').first().json.cfg;
const sheetUrl = `https://docs.google.com/spreadsheets/d/${cfg.SPREADSHEET_ID}/edit`;
const known = new Map();

for (const r of $('Read Invoices keys').all()) {
  if (r.json.dedupe_key) known.set(String(r.json.dedupe_key), 'the Invoices tab');
}
for (const r of $('Read Review Queue keys').all()) {
  const decided = String(r.json.decision || '').trim().toUpperCase();
  if (r.json.dedupe_key && decided !== 'REJECT' && !known.has(String(r.json.dedupe_key))) {
    known.set(String(r.json.dedupe_key), 'the Review Queue');
  }
}

const seenInBatch = new Set();
return $('Validate & score').all().map((d) => {
  const doc = JSON.parse(JSON.stringify(d.json));
  const key = doc.validation && doc.validation.dedupe_key;
  if (key && doc.validation.status !== 'rejected') {
    if (known.has(key)) {
      doc.validation.status = 'duplicate';
      doc.validation.reason = `Already recorded in ${known.get(key)}`;
    } else if (seenInBatch.has(key)) {
      doc.validation.status = 'duplicate';
      doc.validation.reason = 'The same document was uploaded twice in this batch';
    }
    seenInBatch.add(key);
  }
  doc.row = toRow(doc);
  doc.alert_text = telegramText(doc, sheetUrl);
  return { json: doc };
});
