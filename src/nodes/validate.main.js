// Parse Gemini's answer, run the business rules, decide a status.
const cfg = $('Settings').first().json.cfg;
const items = $input.all();
const supportedPreps = $('Prepare file').all().filter((p) => p.json.supported);
let apiIndex = 0;
const out = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const isSkipped = item.json && item.json.file && item.json.supported === false;

  let prep;
  if (isSkipped) {
    prep = item.json;
  } else {
    try { prep = $('Prepare file').itemMatching(i).json; } catch (e) { prep = null; }
    if (!prep || !prep.file || prep.supported !== true) prep = supportedPreps[apiIndex]?.json;
    apiIndex++;
  }
  if (!prep) throw new Error('Could not match a Gemini response to its file. Check the Merge node wiring.');

  const doc = {
    file: prep.file,
    processed_at: new Date().toISOString(),
    execution_id: $execution.id,
    model: cfg.GEMINI_MODEL,
    duration_ms: Date.now() - (prep.started_ms || Date.now()),
    extraction: null,
  };

  if (isSkipped) {
    doc.validation = { status: 'rejected', score: 0, errors: [], warnings: [], reason: prep.skip_reason, dedupe_key: '' };
  } else {
    const parsed = parseGeminiResponse(item.json);
    if (!parsed.ok) {
      doc.validation = {
        status: 'needs_review', score: 0, warnings: [], dedupe_key: '',
        errors: [{ code: 'EXTRACTION_FAILED', msg: parsed.error }],
        reason: 'AI extraction failed. Enter the values by hand in the Review Queue, or re-upload the file.',
      };
    } else {
      doc.extraction = parsed.data;
      doc.model = parsed.model || doc.model;
      doc.usage = parsed.usage;
      doc.validation = validateExtraction(parsed.data, cfg.RULES);
    }
  }
  out.push({ json: doc, pairedItem: { item: i } });
}
return out;
