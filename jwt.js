// Minimal JWT (HMAC-SHA256) implementation using only Node's built-in crypto —
// no external dependency needed for something this small, and it means this
// piece can be fully unit-tested without needing network access to npm.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function base64urlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  const signaturePart = base64url(signature);

  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

// Returns the decoded payload if valid, or null if invalid/expired/tampered.
function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  const actualSig = base64urlToBuffer(signaturePart);

  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(payloadPart).toString('utf8'));
  } catch (e) {
    return null;
  }

  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) {
    return null; // expired
  }
  return payload;
}

module.exports = { sign, verify };
