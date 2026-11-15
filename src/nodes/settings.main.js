// ⚙️ SETTINGS — the only node you need to edit after import.
// Every other node reads its values from here.
const CONFIG = {
  // Google Sheet created from templates/invoice-pipeline-template.xlsx
  // (the long ID in its URL: docs.google.com/spreadsheets/d/<THIS_PART>/edit)
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID',

  // Google Drive folder IDs (the last part of each folder's URL)
  FOLDERS: {
    PROCESSED: 'PASTE_PROCESSED_FOLDER_ID',
    NEEDS_REVIEW: 'PASTE_NEEDS_REVIEW_FOLDER_ID',
    DUPLICATES: 'PASTE_DUPLICATES_FOLDER_ID',
    REJECTED: 'PASTE_REJECTED_FOLDER_ID',
  },

  // Telegram chat that receives alerts (get it from @userinfobot)
  TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID',

  // Any Gemini model that accepts PDFs/images and structured output
  GEMINI_MODEL: 'gemini-3.6-flash',

  // Inline uploads are limited to ~20 MB per request after base64 encoding
  MAX_FILE_MB: 14,

  // Validation thresholds (see src/validate.js for every option)
  RULES: {
    min_confidence: 0.80,
    auto_approve_min_score: 80,
    high_value_threshold: 5000000,
  },
};

return $input.all().map((item, i) => ({ json: { ...item.json, cfg: CONFIG }, pairedItem: { item: i } }));
