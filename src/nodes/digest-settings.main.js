// ⚙️ SETTINGS for the daily summary.
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID',
  TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID',
  TIMEZONE: 'Africa/Lagos',      // IANA time zone used to decide what "today" means
  MINUTES_PER_DOCUMENT: 4,       // how long manual data entry takes per document
  SEND_WHEN_EMPTY: false,        // send a message even on days with no documents
};
return [{ json: { cfg: CONFIG } }];
