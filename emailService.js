// Sends the OTP code by email via Resend (https://resend.com).
// Uses Node's built-in fetch (Node 18+) — no extra dependency needed.

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendOtpEmail({ apiKey, from, to, code }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: `Your Kar le yaar sign-in code: ${code}`,
      html: `
        <div style="font-family:sans-serif; max-width:420px; margin:0 auto; padding:24px;">
          <h2 style="color:#073B44;">Kar le yaar</h2>
          <p>Your sign-in code is:</p>
          <p style="font-size:32px; font-weight:700; letter-spacing:6px; color:#D6007F;">${code}</p>
          <p style="color:#666; font-size:13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = { sendOtpEmail };
