/**
 * Sends Web Prep's weekly summary email without a browser.
 * Run by a scheduled GitHub Action (see .github/workflows/weekly-email.yml).
 *
 * Requires the FIREBASE_PROJECT_ID environment variable to be set
 * (not a secret — it's the same project ID from your Firebase config).
 */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('Missing FIREBASE_PROJECT_ID environment variable.');
  process.exit(1);
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// --- Firestore REST responses wrap every value in a type tag. Unwrap it. ---
function unwrapValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrapValue);
  if ('mapValue' in v) return unwrapFields(v.mapValue.fields || {});
  return null;
}
function unwrapFields(fields) {
  const out = {};
  for (const key in fields) out[key] = unwrapValue(fields[key]);
  return out;
}

async function getDoc(path) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Firestore fetch failed for ${path}: ${res.status}`);
  }
  const json = await res.json();
  return unwrapFields(json.fields || {});
}

function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}
function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
const catLabel = { school: 'School', testing: 'Testing', recs: 'Rec letters', essays: 'Essays', scholarship: 'Scholarship', custom: 'Other' };

async function main() {
  const [emailConfig, appData] = await Promise.all([
    getDoc('config/emailjs'),
    getDoc('appdata/webprep'),
  ]);

  if (!emailConfig || !emailConfig.service || !emailConfig.template || !emailConfig.key) {
    console.log('EmailJS is not fully configured in Firestore yet (config/emailjs). Skipping send.');
    return;
  }
  const recipients = (emailConfig.recipients || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) {
    console.log('No recipients configured. Skipping send.');
    return;
  }

  const tasks = appData?.tasks || [];
  const schools = appData?.schools || [];

  const items = [];
  for (const t of tasks) {
    if (t.done) continue;
    if (!t.date) continue;
    items.push({ title: t.title, category: t.category, date: t.date, notes: t.notes });
  }
  for (const s of schools) {
    if (s.submitted) continue;
    if (!s.deadline) continue;
    items.push({ title: `${s.name} — application due`, category: 'school', date: s.deadline, notes: s.type });
  }

  const dueThisWeek = items
    .filter(i => { const d = daysUntil(i.date); return d >= 0 && d <= 7; })
    .sort((a, b) => a.date.localeCompare(b.date));

  const summary = dueThisWeek.length
    ? dueThisWeek.map(i => `${fmtDate(i.date)} — ${i.title} (${catLabel[i.category] || i.category})`).join('\n')
    : 'Nothing due this week.';

  console.log(`Sending weekly summary to ${recipients.length} recipient(s):\n${summary}`);

  for (const to of recipients) {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: emailConfig.service,
        template_id: emailConfig.template,
        user_id: emailConfig.key,
        template_params: { to_email: to, week_summary: summary },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed to send to ${to}: ${res.status} ${text}`);
    } else {
      console.log(`Sent to ${to}`);
    }
  }
}

main().catch(err => {
  console.error('Weekly email job failed:', err);
  process.exit(1);
});
