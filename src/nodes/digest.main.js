// Build today's summary from the Log and Review Queue tabs.
const cfg = $('Settings').first().json.cfg;
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : fmtDay.format(d); };
const today = fmtDay.format(new Date());

const logs = $('Read Log').all().map((r) => r.json).filter((r) => r.processed_at && dayOf(r.processed_at) === today);
const pending = $('Read Review Queue').all().map((r) => r.json)
  .filter((r) => r.row_number && r.processed_at && !String(r.resolved_at || '').trim()).length;

const count = (s) => logs.filter((r) => r.status === s).length;
const auto = count('auto_approved');
const review = count('needs_review');
const dupes = count('duplicate');
const rejected = count('rejected');

if (!logs.length && !pending && !cfg.SEND_WHEN_EMPTY) return [];

const totals = {};
for (const r of logs.filter((x) => x.status === 'auto_approved')) {
  const t = Number(r.total);
  if (r.currency && Number.isFinite(t)) totals[r.currency] = (totals[r.currency] || 0) + t;
}
const durations = logs.map((r) => Number(r.duration_ms)).filter((n) => Number.isFinite(n) && n > 0);
const avgSec = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(1) : '—';
const minutesSaved = Math.round(auto * cfg.MINUTES_PER_DOCUMENT + review * cfg.MINUTES_PER_DOCUMENT * 0.5);
const autoRate = logs.length ? Math.round((auto / logs.length) * 100) : 0;

const lines = [
  `📊 <b>Invoice pipeline: ${today}</b>`,
  '',
  `📥 Documents processed: <b>${logs.length}</b>`,
  `✅ Auto-approved: ${auto} (${autoRate}%)`,
  `🟡 Sent to review: ${review}`,
  `🔁 Duplicates caught: ${dupes}`,
  `🚫 Rejected: ${rejected}`,
  '',
  ...Object.entries(totals).map(([c, t]) => `💰 ${c} ${t.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} recorded`),
  `⏱️ Avg processing time: ${avgSec}s per document`,
  `🕒 Estimated time saved: ~${minutesSaved} min`,
  '',
  pending ? `👀 <b>${pending}</b> document(s) waiting in the Review Queue` : '🎉 Review Queue is empty',
];
return [{ json: { alert_text: lines.join('\n') } }];
