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

// --- Pacing engine (mirrors the logic in index.html) ---
const STAGE_SETS = {
  application: ['Not started', 'In progress', 'Submitted'],
  essays: ['Not started', 'Drafting', 'Revising', 'Final'],
  testscores: ['N/A', 'Scheduled', 'Taken', 'Sent'],
  transcript: ['Not requested', 'Requested', 'Sent'],
};
const ITEM_LABELS = { application: 'Application', essays: 'Essays / supplements', testscores: 'Test scores', transcript: 'Transcript' };
const ITEM_TIMING = {
  application: [{ days: 30, stage: 1 }, { days: 5, stage: 2 }],
  essays: [{ days: 35, stage: 1 }, { days: 21, stage: 2 }, { days: 7, stage: 3 }],
  testscores: [{ days: 60, stage: 1 }, { days: 30, stage: 2 }, { days: 14, stage: 3 }],
  transcript: [{ days: 21, stage: 1 }, { days: 7, stage: 2 }],
};
const REC_ASK_BY_DAYS = 42;
const REC_FOLLOWUP_AFTER_DAYS = 14;

function itemPacing(deadline, key, currentStage) {
  const stages = STAGE_SETS[key];
  if (currentStage >= stages.length - 1) return { status: 'done' };
  const d = daysUntil(deadline);
  const timing = ITEM_TIMING[key];
  let target = 0;
  timing.forEach(t => { if (d <= t.days) target = Math.max(target, t.stage); });
  if (currentStage < target) return { status: 'behind', nextStage: currentStage + 1 };
  const next = timing.find(t => t.stage === currentStage + 1);
  if (next && d > next.days && d <= next.days + 7) return { status: 'upcoming', nextStage: currentStage + 1 };
  return { status: 'ontrack' };
}

function priorityActions(schools, gettingStarted) {
  const actions = [];
  (schools || []).forEach(s => {
    if (s.submitted) return;
    if (!s.deadline) return;
    const d = daysUntil(s.deadline);
    const items = s.items || {};

    Object.keys(STAGE_SETS).forEach(key => {
      const cur = (items[key] && items[key].stage) || 0;
      const stages = STAGE_SETS[key];
      const p = itemPacing(s.deadline, key, cur);
      if (p.status === 'behind' || p.status === 'upcoming') {
        const nextLabel = stages[p.nextStage];
        actions.push({
          urgency: p.status, days: d,
          text: p.status === 'behind'
            ? `${s.name}: ${ITEM_LABELS[key]} — aim to reach "${nextLabel}" now`
            : `${s.name}: ${ITEM_LABELS[key]} — start moving toward "${nextLabel}" soon`
        });
      }
    });

    (s.customItems || []).forEach(ci => {
      if (ci.stage >= 2) return;
      if (d <= 14) actions.push({ urgency: 'behind', days: d, text: `${s.name}: ${ci.label} — deadline is close, get this started` });
      else if (d <= 30) actions.push({ urgency: 'upcoming', days: d, text: `${s.name}: ${ci.label} — worth starting soon` });
    });

    (s.recLetters || []).forEach(rec => {
      if (rec.stage === 'received') return;
      if (rec.stage === 'not_asked') {
        if (d <= REC_ASK_BY_DAYS) actions.push({ urgency: 'behind', days: d, text: `${s.name}: Ask ${rec.name} for a rec letter — recommended by now` });
        else if (d <= REC_ASK_BY_DAYS + 14) actions.push({ urgency: 'upcoming', days: d, text: `${s.name}: Plan to ask ${rec.name} for a rec letter soon` });
      } else if (rec.stage === 'asked' && rec.askedDate) {
        const since = Math.floor((new Date() - new Date(rec.askedDate + 'T00:00:00')) / 86400000);
        if (since >= REC_FOLLOWUP_AFTER_DAYS) actions.push({ urgency: 'behind', days: d, text: `${s.name}: Follow up with ${rec.name} about the rec letter — it's been ${since} days` });
      }
    });
  });

  (gettingStarted || []).forEach(item => {
    if (item.stage >= 2) return; // Done or Not needed
    actions.push({ urgency: 'general', days: 0, text: item.label });
  });

  const URGENCY_RANK = { behind: 0, upcoming: 1, general: 2 };
  actions.sort((a, b) => {
    const r = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    return r !== 0 ? r : (a.days || 0) - (b.days || 0);
  });
  return actions;
}

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
  const scholarships = appData?.scholarships || [];
  const gettingStarted = appData?.gettingStarted || [];

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
  for (const sc of scholarships) {
    if (sc.stage >= 2) continue;
    if (!sc.deadline) continue;
    items.push({ title: `${sc.name} — scholarship due`, category: 'scholarship', date: sc.deadline, notes: sc.amount || '' });
  }

  const dueThisWeek = items
    .filter(i => { const d = daysUntil(i.date); return d >= 0 && d <= 7; })
    .sort((a, b) => a.date.localeCompare(b.date));

  const priActions = priorityActions(schools, gettingStarted);
  const actionsBlock = priActions.length
    ? 'Focus this week:\n' + priActions.slice(0, 6).map(a => `- ${a.text}`).join('\n')
    : 'Focus this week: nothing urgent — good pace.';
  const deadlinesBlock = dueThisWeek.length
    ? 'Deadlines this week:\n' + dueThisWeek.map(i => `- ${fmtDate(i.date)} — ${i.title} (${catLabel[i.category] || i.category})`).join('\n')
    : 'Deadlines this week: nothing due.';
  const summary = `${actionsBlock}\n\n${deadlinesBlock}`;

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
