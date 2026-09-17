// One-time-code generation and verification for email login.
// Codes are hashed before storage — even if the data file leaked, a stored
// code can't be read back out and reused.

const crypto = require('crypto');

const OTP_TTL_MS = 10 * 60 * 1000; // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 45 * 1000; // don't let the same email request a new code more than once per 45s
const MAX_ATTEMPTS = 5; // wrong-code guesses allowed before the code is invalidated

function generateCode() {
  // 6-digit numeric code, zero-padded (e.g. "042819")
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// Returns { ok:true, code } to send, or { ok:false, reason, retryAfterMs }.
function requestOtp(otpStore, email) {
  const existing = otpStore[email];
  const now = Date.now();
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryAfterMs: RESEND_COOLDOWN_MS - (now - existing.lastSentAt) };
  }
  const code = generateCode();
  otpStore[email] = {
    codeHash: hashCode(code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  };
  return { ok: true, code };
}

// Returns { ok:true } or { ok:false, reason }.
function verifyOtp(otpStore, email, code) {
  const entry = otpStore[email];
  if (!entry) return { ok: false, reason: 'not_requested' };
  if (Date.now() > entry.expiresAt) {
    delete otpStore[email];
    return { ok: false, reason: 'expired' };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    delete otpStore[email];
    return { ok: false, reason: 'too_many_attempts' };
  }
  entry.attempts++;
  if (hashCode(String(code)) !== entry.codeHash) {
    return { ok: false, reason: 'wrong_code' };
  }
  delete otpStore[email];
  return { ok: true };
}

module.exports = { requestOtp, verifyOtp };
