// End-to-end simulation: runs the exact JavaScript embedded in the generated
// workflow JSON with a mock n8n runtime, feeding all nine test documents through
// Settings -> Prepare -> (mock Gemini) -> Merge -> Validate -> Check duplicates.
// Catches broken builds, typos in node names, and wiring mistakes before you import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const wf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));
const fixture = (stem) => {
  const p = path.join(__dirname, 'fixtures', `${stem}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expected.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// ---------------------------------------------------------------- mock runtime
class Run {
  constructor(workflow) {
    this.wf = workflow;
    this.out = {}; // node name -> items [{json, binary, __src:{node, i}}]
  }
  node(name) {
    const n = this.wf.nodes.find((x) => x.name === name);
    assert.ok(n, `node "${name}" missing from ${this.wf.name}`);
    return n;
  }
  set(name, items) { this.out[name] = items; return items; }
  ref(name) {
    const items = this.out[name];
    assert.ok(items, `node "${name}" referenced before it ran`);
    const self = this;
    return {
      first: () => items[0],
      all: () => items,
      itemMatching: (i) => self.walk(self.current[i], name),
      get item() { return self.walk(self.current[0], name); },
    };
  }
  walk(item, target) {
    let cur = item;
    while (cur) {
      if (cur.__node === target) return cur;
      cur = cur.__src ? this.out[cur.__src.node][cur.__src.i] : null;
    }
    throw new Error(`no paired item in ${target}`);
  }
  // Execute a Code node exactly as n8n would (runOnceForAllItems).
  async code(name, inputItems, inputNode, binaries = {}) {
    const n = this.node(name);
    assert.equal(n.type, 'n8n-nodes-base.code');
    this.current = inputItems;
    const fn = new AsyncFunction('$input', '$', '$execution', n.parameters.jsCode);
    const ctx = { helpers: { getBinaryDataBuffer: async (i) => binaries[i] } };
    const res = await fn.call(ctx, { all: () => inputItems, first: () => inputItems[0] }, (x) => this.ref(x), { id: 'sim-1' });
    assert.ok(Array.isArray(res), `${name} must return an array`);
    return this.set(name, res.map((r, k) => ({
      ...r,
      __node: name,
      __src: r.pairedItem ? { node: inputNode, i: r.pairedItem.item } : (inputItems[k] ? { node: inputNode, i: k } : null),
    })));
  }
  conn(from, out = 0) {
    return (this.wf.connections[from]?.main?.[out] || []).map((c) => c.node);
  }
}

const mime = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain' };
const files = fs.readdirSync(path.join(ROOT, 'test-documents')).filter((f) => !f.endsWith('.md')).sort();

async function runPipeline(existingInvoiceKeys = []) {
  const r = new Run(wf('1-invoice-pipeline.json'));
  // Google Drive trigger output
  const trigger = r.set('New file in Inbox', files.map((f, i) => ({
    json: { id: `drive-${i}`, name: f, mimeType: mime[f.split('.').pop()], webViewLink: `https://drive.google.com/file/d/drive-${i}/view` },
    __node: 'New file in Inbox',
  })));
  assert.deepEqual(r.conn('New file in Inbox'), ['Settings']);
  const settings = await r.code('Settings', trigger, 'New file in Inbox');

  // Google Drive download: same json, adds binary
  assert.deepEqual(r.conn('Settings'), ['Download file']);
  const buffers = files.map((f) => fs.readFileSync(path.join(ROOT, 'test-documents', f)));
  const downloaded = r.set('Download file', settings.map((s, i) => ({
    json: { id: s.json.id },
    binary: { data: { mimeType: mime[files[i].split('.').pop()], fileName: files[i] } },
    __node: 'Download file', __src: { node: 'Settings', i },
  })));
  const prepared = await r.code('Prepare file', downloaded, 'Download file', buffers);

  // IF node: true -> Gemini, false -> Merge input 2
  assert.deepEqual(r.conn('Supported file?', 0), ['Gemini: extract data']);
  assert.deepEqual(r.conn('Supported file?', 1), ['Merge']);
  const ifTrue = prepared.map((p, i) => ({ ...p, __node: 'Supported file?', __src: { node: 'Prepare file', i } })).filter((p) => p.json.supported);
  const ifFalse = prepared.map((p, i) => ({ ...p, __node: 'Supported file?', __src: { node: 'Prepare file', i } })).filter((p) => !p.json.supported);
  r.set('Supported file?', [...ifTrue, ...ifFalse]);

  // Mock Gemini: return the ground-truth extraction for each file
  const gemini = r.set('Gemini: extract data', ifTrue.map((p) => {
    const req = p.json.gemini_request;
    assert.ok(req.contents[0].parts[0].inline_data.data.length > 100, 'base64 payload present');
    assert.ok(req.generationConfig.responseJsonSchema.properties.total, 'schema attached');
    assert.match(p.json.gemini_url, /models\/gemini-[\w.-]+:generateContent$/);
    const fx = fixture(p.json.file.name.replace(/\.[^.]+$/, ''));
    return {
      json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(fx) }] } }], modelVersion: 'gemini-3.6-flash' },
      __node: 'Gemini: extract data', __src: { node: 'Supported file?', i: r.out['Supported file?'].indexOf(p) },
    };
  }));
  const merged = r.set('Merge', [...gemini, ...ifFalse].map((it) => ({ ...it, __node: 'Merge', __src: { node: it.__node, i: r.out[it.__node].indexOf(it) } })));

  const validated = await r.code('Validate & score', merged, 'Merge');
  r.set('Read Invoices keys', existingInvoiceKeys.length ? existingInvoiceKeys.map((k) => ({ json: { dedupe_key: k } })) : [{ json: {} }]);
  r.set('Read Review Queue keys', [{ json: {} }]);
  assert.deepEqual(r.conn('Validate & score'), ['Read Invoices keys']);
  const final = await r.code('Check duplicates', r.out['Read Review Queue keys'], 'Read Review Queue keys');
  return { r, validated, final };
}

test('all nine documents end up with the expected status', async () => {
  const { final } = await runPipeline();
  const got = Object.fromEntries(final.map((d) => [d.json.file.name.replace(/\.[^.]+$/, ''), d.json.validation.status]));
  assert.deepEqual(got, expected);
});

test('unsupported file never reaches Gemini', async () => {
  const { r } = await runPipeline();
  const sent = r.out['Gemini: extract data'].length;
  assert.equal(sent, files.length - 1);
  const txt = r.out['Check duplicates'].find((d) => d.json.file.name.endsWith('.txt'));
  assert.match(txt.json.validation.reason, /Unsupported file type/);
});

test('documents already in the sheet are caught as duplicates', async () => {
  const { final } = await runPipeline(['kestrelofficesupplies|INV20260412|576200.00']);
  const status = (n) => final.find((d) => d.json.file.name.startsWith(n)).json.validation.status;
  assert.equal(status('01_'), 'duplicate');
  assert.equal(status('04_'), 'duplicate');
});

test('rows and alerts are ready for the Sheets and Telegram nodes', async () => {
  const { r, final } = await runPipeline();
  const main = r.wf;
  for (const d of final) {
    assert.ok(d.json.row.file_name, 'row present');
    assert.ok(d.json.alert_text.length > 10, 'alert present');
  }
  // Every column mapped in the sheet nodes must exist on the row object
  const rowKeys = new Set(Object.keys(final[0].json.row));
  for (const n of main.nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets' && x.parameters.operation === 'append')) {
    for (const [col, expr] of Object.entries(n.parameters.columns.value)) {
      const m = /\$json\.row\.(\w+)/.exec(expr);
      if (m) assert.ok(rowKeys.has(m[1]), `${n.name}: column ${col} maps to missing field ${m[1]}`);
    }
  }
});

test('Switch outputs are wired to the right destinations', () => {
  const main = wf('1-invoice-pipeline.json');
  const outs = main.connections['Route by status'].main.map((o) => o.map((c) => c.node).sort());
  assert.deepEqual(outs[0], ['Add to Invoices', 'Move to Processed', 'Write to Log']);
  assert.deepEqual(outs[1], ['Add to Review Queue', 'Alert: needs review', 'Move to Needs Review', 'Write to Log']);
  assert.deepEqual(outs[2], ['Alert: duplicate', 'Move to Duplicates', 'Write to Log']);
  assert.deepEqual(outs[3], ['Alert: rejected', 'Move to Rejected', 'Write to Log']);
});

test('every node referenced in an expression or code exists', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'workflows'))) {
    const w = wf(f);
    const names = new Set(w.nodes.map((n) => n.name));
    const text = JSON.stringify(w.nodes.map((n) => n.parameters));
    for (const m of text.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) {
      assert.ok(names.has(m[1]), `${f}: reference to unknown node "${m[1]}"`);
    }
    for (const [from, c] of Object.entries(w.connections)) {
      assert.ok(names.has(from), `${f}: connection from unknown node ${from}`);
      for (const out of c.main) for (const t of out) assert.ok(names.has(t.node), `${f}: connection to unknown node ${t.node}`);
    }
  }
});

test('review workflow: approve, reject and blocked rows', async () => {
  const r = new Run(wf('2-review-approvals.json'));
  const settings = await r.code('Settings', [{ json: {}, __node: 'Every 5 minutes' }], 'Every 5 minutes');
  const fx = fixture('03_math_error_invoice');
  const rows = [
    // reviewer fixed the subtotal and approved
    { row_number: 2, decision: 'approve ', processed_at: 'x', supplier_name: fx.supplier.name, invoice_number: fx.invoice_number,
      document_date: fx.document_date, currency: 'NGN', subtotal: '555,000', tax_amount: '41625', total: '596625',
      line_items_json: JSON.stringify(fx.line_items), file_id: 'f1', file_name: '03.pdf', file_link: 'l1', confidence: 0.97 },
    { row_number: 3, decision: 'REJECT', processed_at: 'x', file_id: 'f2', file_name: '08.pdf', file_link: 'l2' },
    { row_number: 4, decision: 'APPROVE', processed_at: 'x', supplier_name: 'QuickMart', total: '12750', currency: 'NGN', file_id: 'f3', file_name: '07.png', file_link: 'l3' },
    { row_number: 5, decision: '', processed_at: 'x' },                       // not decided yet
    { row_number: 6, decision: 'APPROVE', resolved_at: '2026-11-01', processed_at: 'x' }, // already handled
  ];
  const read = r.set('Read Review Queue', rows.map((json, i) => ({ json, __node: 'Read Review Queue', __src: { node: 'Settings', i: 0 } })));
  const picked = await r.code('Pick decided rows', read, 'Read Review Queue');
  assert.deepEqual(picked.map((p) => [p.json.row_number, p.json.action]), [[2, 'post'], [3, 'reject'], [4, 'blocked']]);
  const post = picked[0].json;
  assert.equal(post.invoice_row.subtotal, 555000);
  assert.equal(post.invoice_row.source, 'reviewed');
  assert.equal(post.resolution, 'Posted to Invoices');
  assert.match(picked[2].json.resolution, /document_date/);
  assert.equal(picked[2].json.new_decision, '');
  void settings;
});

test('daily summary counts today only', async () => {
  const r = new Run(wf('3-daily-summary.json'));
  await r.code('Settings', [{ json: {}, __node: 'Every day at 18:00' }], 'Every day at 18:00');
  const now = new Date().toISOString();
  r.set('Read Log', [
    { json: { processed_at: now, status: 'auto_approved', currency: 'NGN', total: 576200, duration_ms: 4200 } },
    { json: { processed_at: now, status: 'needs_review', currency: 'NGN', total: 628875, duration_ms: 5100 } },
    { json: { processed_at: now, status: 'duplicate', duration_ms: 3000 } },
    { json: { processed_at: '2020-01-01T10:00:00Z', status: 'auto_approved', currency: 'NGN', total: 999 } },
  ]);
  r.set('Read Review Queue', [{ json: { row_number: 2, processed_at: now, resolved_at: '' } }]);
  const out = await r.code('Build summary', r.out['Read Review Queue'], 'Read Review Queue');
  const t = out[0].json.alert_text;
  assert.match(t, /Documents processed: <b>3<\/b>/);
  assert.match(t, /NGN 576,200\.00 recorded/);
  assert.match(t, /<b>1<\/b> document\(s\) waiting/);
});

test('error workflow formats a readable alert', async () => {
  const r = new Run(wf('0-error-alerts.json'));
  const out = await r.code('Format alert', [{ json: {
    workflow: { name: 'Invoice Pipeline · 1' },
    execution: { url: 'https://n8n.example/execution/9', lastNodeExecuted: 'Add to Invoices', error: { message: 'The caller does not have <permission>' } },
  }, __node: 'On workflow error' }], 'On workflow error');
  assert.match(out[0].json.alert_text, /Add to Invoices/);
  assert.match(out[0].json.alert_text, /&lt;permission&gt;/);
});
