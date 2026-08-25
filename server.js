// Kar le yaar — push notification server
// Watches your reminders and sends a real push notification at the right
// time, even if the app isn't open. Deployed separately from the app itself.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const { isDue, advanceRepeat, applySnooze } = require('./reminderLogic');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ''; // optional shared secret — set this in production
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. See .env.example.');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------------- tiny JSON file "database" ----------------
   Fine for a single-user personal app. Not meant for concurrent multi-user use. */
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { subscription: null, reminders: [] };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DATA_FILE)) saveData({ subscription: null, reminders: [] });

/* ---------------- app setup ---------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured — open access (fine for quick testing only)
  const sent = req.header('x-api-key');
  if (sent !== API_KEY) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', requireApiKey, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }
  const data = loadData();
  data.subscription = subscription;
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/reminders', requireApiKey, (req, res) => {
  const data = loadData();
  res.json({ reminders: data.reminders });
});

app.post('/api/reminders', requireApiKey, (req, res) => {
  const { reminders } = req.body || {};
  if (!Array.isArray(reminders)) return res.status(400).json({ error: 'reminders must be an array' });
  const data = loadData();
  data.reminders = reminders;
  saveData(data);
  res.json({ ok: true, count: reminders.length });
});

app.post('/api/notification-action', requireApiKey, (req, res) => {
  const { id, action } = req.body || {};
  const data = loadData();
  const r = data.reminders.find(x => x.id === id);
  if (!r) return res.status(404).json({ error: 'Reminder not found' });
  if (action === 'done') {
    r.completed = true;
    r.snoozedUntil = null;
  } else if (action === 'snooze10') {
    applySnooze(r, '10m', new Date());
  }
  saveData(data);
  res.json({ ok: true });
});

// Checks for due reminders and pushes notifications. Safe to call repeatedly —
// once a reminder is advanced or completed it won't fire again until actually due.
async function checkAndSend() {
  const data = loadData();
  if (!data.subscription) return { checked: data.reminders.length, sent: 0, reason: 'no subscription yet' };

  const now = new Date();
  let sent = 0;
  let subscriptionGone = false;

  for (const r of data.reminders) {
    if (!isDue(r, now)) continue;

    const payload = JSON.stringify({
      id: r.id,
      title: r.title,
      body: r.notes || '',
      category: r.category,
    });

    try {
      await webpush.sendNotification(data.subscription, payload);
      sent++;
    } catch (err) {
      // 404/410 means the browser unsubscribed (e.g. app uninstalled) — stop trying.
      if (err.statusCode === 404 || err.statusCode === 410) {
        subscriptionGone = true;
      } else {
        console.error('Push send failed for', r.id, err.statusCode || err.message);
      }
    }

    const repeated = advanceRepeat(r, now);
    if (!repeated) r.completed = true;
    r.snoozedUntil = null;
  }

  if (subscriptionGone) data.subscription = null;
  saveData(data);
  return { checked: data.reminders.length, sent };
}

// External cron pingers (e.g. cron-job.org) can hit this to trigger a check —
// useful on free hosts that sleep and don't reliably run node-cron in the background.
app.get('/api/tick', async (req, res) => {
  const result = await checkAndSend();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Kar le yaar push server running on port ${PORT}`);
});

// Primary mechanism: check every minute while the process is actually running.
cron.schedule('* * * * *', () => {
  checkAndSend().catch(err => console.error('checkAndSend error:', err));
});
