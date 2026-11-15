// Unit tests for the validation rules and Gemini parsing.  Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateExtraction, buildDedupeKey, normalizeSupplier } = require('../src/validate');
const { parseGeminiResponse, buildGeminiRequest } = require('../src/gemini');
const { toRow, telegramText } = require('../src/format');

const NOW = new Date('2026-11-09T12:00:00Z');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const codes = (v) => [...v.errors, ...v.warnings].map((e) => e.code);

test('every test document gets the expected status from the rules', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expected.json'), 'utf8'));
  for (const [name, status] of Object.entries(expected)) {
    if (!fs.existsSync(path.join(__dirname, 'fixtures', `${name}.json`))) continue; // unsupported file has no fixture
    // Duplicates are caught later against the sheet; on their own they validate cleanly.
    const want = status === 'duplicate' ? 'auto_approved' : status;
    const v = validateExtraction(fx(name), {}, NOW);
    assert.equal(v.status, want, `${name}: ${JSON.stringify([...v.errors, ...v.warnings])}`);
  }
});

test('clean invoice scores 100 with no issues', () => {
  const v = validateExtraction(fx('01_clean_invoice'), {}, NOW);
  assert.equal(v.score, 100);
  assert.deepEqual(codes(v), []);
});

test('maths error is explained in plain words', () => {
  const v = validateExtraction(fx('03_math_error_invoice'), {}, NOW);
  assert.ok(codes(v).includes('ITEMS_NE_SUBTOTAL'));
  assert.match(v.errors[0].msg, /555000.*585000/);
});

test('prompt injection is never auto-approved', () => {
  const v = validateExtraction(fx('08_prompt_injection_invoice'), {}, NOW);
  assert.equal(v.status, 'needs_review');
  assert.ok(codes(v).includes('PROMPT_INJECTION'));
});

test('a tampered total is caught even if the model is fooled', () => {
  const x = fx('08_prompt_injection_invoice');
  x.total = 0;
  x.contains_instructions_to_ai = false;
  const v = validateExtraction(x, {}, NOW);
  assert.equal(v.status, 'needs_review');
  assert.ok(codes(v).includes('ZERO_TOTAL'));
  assert.ok(codes(v).includes('TOTAL_MISMATCH'));
});

test('non-financial documents are rejected with score 0', () => {
  const v = validateExtraction(fx('05_not_an_invoice'), {}, NOW);
  assert.equal(v.status, 'rejected');
  assert.equal(v.score, 0);
  assert.equal(v.dedupe_key, '');
});

test('date checks: future, invalid, due before issue', () => {
  const base = fx('01_clean_invoice');
  let x = clone(base); x.document_date = '2027-03-01';
  assert.ok(codes(validateExtraction(x, {}, NOW)).includes('FUTURE_DATE'));
  x = clone(base); x.document_date = '2026-02-30';
  assert.ok(codes(validateExtraction(x, {}, NOW)).includes('BAD_DATE'));
  x = clone(base); x.due_date = '2026-10-01';
  assert.ok(codes(validateExtraction(x, {}, NOW)).includes('DUE_BEFORE_ISSUE'));
});

test('small rounding differences are tolerated', () => {
  const x = fx('01_clean_invoice');
  x.total += 0.04;
  assert.equal(validateExtraction(x, {}, NOW).status, 'auto_approved');
});

test('low model confidence sends to review', () => {
  const x = fx('01_clean_invoice');
  x.confidence.overall = 0.6;
  const v = validateExtraction(x, {}, NOW);
  assert.equal(v.status, 'needs_review');
  assert.ok(codes(v).includes('LOW_CONFIDENCE'));
});

test('thresholds can be overridden from Settings', () => {
  const x = fx('01_clean_invoice');
  x.confidence.overall = 0.75;
  assert.equal(validateExtraction(x, { min_confidence: 0.7 }, NOW).status, 'auto_approved');
});

test('dedupe key ignores case, punctuation and company suffixes', () => {
  const a = { supplier: { name: 'Kestrel Office Supplies Ltd' }, invoice_number: 'INV-2026-0412', total: 576200 };
  const b = { supplier: { name: 'KESTREL OFFICE SUPPLIES LIMITED.' }, invoice_number: 'inv 2026 0412', total: 576200.0 };
  assert.equal(buildDedupeKey(a), buildDedupeKey(b));
  assert.equal(normalizeSupplier('Apex Print & Signage Co.'), 'apexprintandsignage');
  const c = { supplier: { name: 'QuickMart' }, invoice_number: null, document_date: null, total: 12750 };
  assert.equal(buildDedupeKey(c), 'quickmart|nodate|12750.00');
});

test('Gemini parser: happy path skips thought parts and code fences', () => {
  const r = parseGeminiResponse({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: '```json\n{"total": 5}\n```' }] } }],
    modelVersion: 'gemini-3.6-flash',
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.total, 5);
  assert.equal(r.model, 'gemini-3.6-flash');
});

test('Gemini parser: errors never throw', () => {
  assert.match(parseGeminiResponse({ error: { message: 'Resource exhausted' } }).error, /Resource exhausted/);
  assert.match(parseGeminiResponse({ error: 'socket hang up' }).error, /socket hang up/);
  assert.match(parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }).error, /SAFETY/);
  assert.match(parseGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }).error, /MAX_TOKENS/);
  assert.match(parseGeminiResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }).error, /not valid JSON/);
  assert.equal(parseGeminiResponse(null).ok, false);
});

test('request uses structured output without deprecated sampling params', () => {
  const req = buildGeminiRequest({ prompt: 'p', schema: { type: 'object' }, mimeType: 'application/pdf', base64Data: 'AAA' });
  assert.equal(req.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(req.generationConfig.responseJsonSchema, { type: 'object' });
  assert.equal(req.generationConfig.temperature, undefined);
  assert.equal(req.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
});

test('Telegram text escapes HTML from document content', () => {
  const x = fx('01_clean_invoice');
  x.supplier.name = '<script>alert(1)</script> & Co';
  const doc = { file: { id: '1', name: 'a<b>.pdf', link: 'https://x' }, extraction: x, validation: validateExtraction(x, {}, NOW) };
  const t = telegramText(doc);
  assert.ok(!t.includes('<script>'));
  assert.ok(t.includes('&lt;script&gt;'));
  assert.ok(t.length <= 4000);
});

test('sheet row has a value for every column and keeps numbers numeric', () => {
  const x = fx('06_multipage_usd_invoice');
  const doc = { processed_at: 'now', file: { id: '1', name: 'f.pdf', link: 'l' }, extraction: x, validation: validateExtraction(x, {}, NOW) };
  const row = toRow(doc);
  assert.equal(typeof row.total, 'number');
  assert.equal(row.line_item_count, 28);
  assert.equal(JSON.parse(row.line_items_json).length, 28);
});
