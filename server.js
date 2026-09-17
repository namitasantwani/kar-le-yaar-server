// Kar le yaar — backend server
// Handles: email OTP sign-in, user profiles, per-account reminder storage
// and sync, and scheduled push notifications for every signed-in user.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const jwt = require('./jwt');
const { requestOtp, verifyOtp } = require('./otp');
const { sendOtpEmail } = require('./emailService');
const { isDue, advanceRepeat, applySnooze } = require('./reminderLogic');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
const JWT_SECRET = process.env.JWT_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Kar le yaar <onboarding@resend.dev>';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days — re-verify by email after this

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. See .env.example.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET env var. See .env.example.');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------------- tiny JSON file "database" ----------------
   Fine for personal/small-scale use. Not built for high concurrent write
   volume — each request reads the whole file, edits it, writes it back. */
function freshData() {
  return { users: {}, otps: {} };
}
function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.users) throw new Error('old format');
    return parsed;
  } catch (e) {
    return freshData();
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DATA_FILE)) {
  saveData(freshData());
} else {
  // If an old single-user data.json is sitting here from before accounts
  // existed, keep it as a backup rather than silently discarding it.
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.users) {
      fs.writeFileSync(path.join(__dirname, 'data.legacy-backup.json'), JSON.stringify(parsed, null, 2));
      saveData(freshData());
      console.log('Found pre-account data.json — backed it up to data.legacy-backup.json and started fresh.');
    }
  } catch (e) { /* unreadable/corrupt — freshData() already used below */ }
}

function findUserByEmail(data, email) {
  return Object.values(data.users).find(u => u.email === email);
}

/* ---------------- app setup ---------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function requireAuth(req, res, next) {
  const authHeader = req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token && jwt.verify(token, JWT_SECRET);
  if (!payload || !payload.userId) return res.status(401).json({ error: 'Not signed in' });
  const data = loadData();
  const user = data.users[payload.userId];
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  req.userId = payload.userId;
  req.data = data;
  req.user = user;
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

/* ---------------- auth: request + verify OTP ---------------- */

app.post('/api/auth/request-otp', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const data = loadData();
  const result = requestOtp(data.otps, email);
  if (!result.ok) {
    if (result.reason === 'cooldown') {
      return res.status(429).json({ error: 'Please wait a moment before requesting another code', retryAfterMs: result.retryAfterMs });
    }
    return res.status(400).json({ error: 'Could not send code' });
  }
  saveData(data);

  try {
    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured on the server');
    await sendOtpEmail({ apiKey: RESEND_API_KEY, from: EMAIL_FROM, to: email, code: result.code });
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return res.status(502).json({ error: "Could not send the email — check the server's email configuration" });
  }
  res.json({ ok: true });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  const data = loadData();
  const result = verifyOtp(data.otps, email, code);
  if (!result.ok) {
    const messages = {
      not_requested: 'Request a new code first',
      expired: 'That code expired — request a new one',
      wrong_code: 'Incorrect code',
      too_many_attempts: 'Too many wrong attempts — request a new code',
    };
    saveData(data); // persist attempt count / cleanup even on failure
    return res.status(400).json({ error: messages[result.reason] || 'Could not verify code' });
  }

  let user = findUserByEmail(data, email);
  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    const id = crypto.randomBytes(12).toString('hex');
    user = { id, email, profile: null, reminders: [], subscription: null, createdAt: Date.now() };
    data.users[id] = user;
  }
  saveData(data);

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, TOKEN_TTL_SECONDS);
  res.json({ token, isNewUser, user: { id: user.id, email: user.email, profile: user.profile } });
});

/* ---------------- profile ---------------- */

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email, profile: req.user.profile },
    reminders: req.user.reminders,
  });
});

app.post('/api/profile', requireAuth, (req, res) => {
  const { name, dob, gender, ...rest } = req.body || {};
  const data = req.data;
  data.users[req.userId].profile = { name, dob, gender, ...rest, updatedAt: Date.now() };
  saveData(data);
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email, profile: data.users[req.userId].profile } });
});

/* ---------------- reminders (per account) ---------------- */

app.post('/api/reminders', requireAuth, (req, res) => {
  const { reminders } = req.body || {};
  if (!Array.isArray(reminders)) return res.status(400).json({ error: 'reminders must be an array' });
  const data = req.data;
  data.users[req.userId].reminders = reminders;
  saveData(data);
  res.json({ ok: true, count: reminders.length });
});

app.post('/api/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
  const data = req.data;
  data.users[req.userId].subscription = subscription;
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/notification-action', requireAuth, (req, res) => {
  const { id, action } = req.body || {};
  const data = req.data;
  const r = data.users[req.userId].reminders.find(x => x.id === id);
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

/* ---------------- scheduled push check (all users) ---------------- */

async function checkAndSend() {
  const data = loadData();
  const now = new Date();
  let usersChecked = 0;
  let sent = 0;

  for (const user of Object.values(data.users)) {
    usersChecked++;
    if (!user.subscription) continue;
    let subscriptionGone = false;

    for (const r of user.reminders) {
      if (!isDue(r, now)) continue;

      const payload = JSON.stringify({
        id: r.id,
        title: r.title,
        body: r.notes || '',
        category: r.category,
      });

      try {
        await webpush.sendNotification(user.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          subscriptionGone = true;
        } else {
          console.error('Push send failed for user', user.id, r.id, err.statusCode || err.message);
        }
      }

      const repeated = advanceRepeat(r, now);
      if (!repeated) r.completed = true;
      r.snoozedUntil = null;
    }

    if (subscriptionGone) user.subscription = null;
  }

  saveData(data);
  return { usersChecked, sent };
}

app.get('/api/tick', async (req, res) => {
  const result = await checkAndSend();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Kar le yaar server running on port ${PORT}`);
});

cron.schedule('* * * * *', () => {
  checkAndSend().catch(err => console.error('checkAndSend error:', err));
});
