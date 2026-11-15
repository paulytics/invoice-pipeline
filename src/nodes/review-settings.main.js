// ⚙️ SETTINGS — use the same values as the main pipeline.
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID',
  FOLDERS: {
    PROCESSED: 'PASTE_PROCESSED_FOLDER_ID',
    REJECTED: 'PASTE_REJECTED_FOLDER_ID',
  },
  TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID',
  RULES: {},
};
return [{ json: { cfg: CONFIG } }];
