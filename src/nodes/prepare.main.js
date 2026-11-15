// Download -> base64 -> Gemini request. Flags unsupported/oversized files.
const cfg = $('Settings').first().json.cfg;
const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const meta = $('Settings').itemMatching(i).json; // Google Drive file metadata
  const binKey = Object.keys(item.binary || {})[0];
  const bin = binKey ? item.binary[binKey] : null;
  const name = meta.name || bin?.fileName || 'unknown file';
  const mime = bin?.mimeType && bin.mimeType !== 'application/octet-stream'
    ? bin.mimeType
    : guessMimeType(name, meta.mimeType);

  const base = {
    file: {
      id: meta.id,
      name,
      mime_type: mime,
      link: meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`,
    },
    received_at: new Date().toISOString(),
    started_ms: Date.now(),
  };
  const skip = (reason) => out.push({ json: { ...base, supported: false, skip_reason: reason }, pairedItem: { item: i } });

  if (!bin) { skip('The file could not be downloaded from Google Drive'); continue; }
  if (!SUPPORTED_MIME_TYPES.has(mime)) { skip(`Unsupported file type (${mime}). Upload a PDF, JPG, PNG, WEBP or HEIC.`); continue; }

  const buffer = await this.helpers.getBinaryDataBuffer(i, binKey);
  if (buffer.length > cfg.MAX_FILE_MB * 1024 * 1024) {
    skip(`File is ${(buffer.length / 1048576).toFixed(1)} MB; the limit is ${cfg.MAX_FILE_MB} MB`);
    continue;
  }

  out.push({
    json: {
      ...base,
      supported: true,
      size_bytes: buffer.length,
      gemini_url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent`,
      gemini_request: buildGeminiRequest({
        prompt: EXTRACTION_PROMPT,
        schema: EXTRACTION_SCHEMA,
        mimeType: mime,
        base64Data: buffer.toString('base64'),
      }),
    },
    pairedItem: { item: i },
  });
}
return out;
