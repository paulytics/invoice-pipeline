// Format an n8n error event as a Telegram alert.
const TELEGRAM_CHAT_ID = 'PASTE_TELEGRAM_CHAT_ID';
const e = $input.first().json;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const wfName = e.workflow?.name || 'Unknown workflow';
const err = e.execution?.error || e.trigger?.error || {};
const node = e.execution?.lastNodeExecuted || err.node?.name || 'unknown';
const url = e.execution?.url;

const lines = [
  '🔥 <b>Automation failed</b>',
  `Workflow: <b>${esc(wfName)}</b>`,
  `Node: ${esc(node)}`,
  `Error: <code>${esc(String(err.message || 'No message').slice(0, 500))}</code>`,
];
if (err.description) lines.push(esc(String(err.description).slice(0, 500)));
if (url) lines.push(`<a href="${esc(url)}">Open the failed execution</a>`);
lines.push('', 'Files that failed stay where they are. Fix the problem, then use Retry on the execution page.');

return [{ json: { chat_id: TELEGRAM_CHAT_ID, alert_text: lines.join('\n') } }];
