// Request builder and response parser for the Gemini generateContent REST API.

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

function guessMimeType(fileName, fallback) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  const map = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  return map[ext] || fallback || 'application/octet-stream';
}

function buildGeminiRequest({ prompt, schema, mimeType, base64Data }) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    },
  };
}

/** Returns { ok, data, error, usage, model } and never throws. */
function parseGeminiResponse(resp) {
  if (!resp || typeof resp !== 'object') return { ok: false, error: 'Empty response from Gemini' };
  if (resp.error) {
    const e = resp.error;
    const msg = typeof e === 'string' ? e : (e.message || e.description || JSON.stringify(e)).slice(0, 300);
    return { ok: false, error: `Gemini request failed: ${msg}` };
  }
  if (resp.promptFeedback?.blockReason) {
    return { ok: false, error: `Gemini blocked the request: ${resp.promptFeedback.blockReason}` };
  }
  const cand = resp.candidates?.[0];
  if (!cand) return { ok: false, error: 'Gemini returned no candidates' };
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    return { ok: false, error: `Gemini stopped early (${cand.finishReason})` };
  }
  // Thinking models can return "thought" parts first; take the answer text.
  const text = (cand.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!text.trim()) return { ok: false, error: 'Gemini returned an empty answer' };
  let data;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    return { ok: false, error: 'Gemini answer was not valid JSON' };
  }
  return { ok: true, data, usage: resp.usageMetadata || null, model: resp.modelVersion || null };
}

if (typeof module !== 'undefined') {
  module.exports = { SUPPORTED_MIME_TYPES, guessMimeType, buildGeminiRequest, parseGeminiResponse };
}
