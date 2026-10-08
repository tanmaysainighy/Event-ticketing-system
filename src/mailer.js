'use strict';
const nodemailer = require('nodemailer');

const MODE = (process.env.MAIL_MODE || (process.env.SMTP_HOST ? 'smtp' : 'ethereal')).toLowerCase();
const FROM = process.env.MAIL_FROM || 'Campus Events <tickets@example.edu>';

let transporterPromise = null;

async function buildTransporter() {
  if (MODE === 'none') {
    console.log('[mail] MAIL_MODE=none; emails will be skipped');
    return null;
  }
  if (MODE === 'smtp') {
    if (!process.env.SMTP_HOST) throw new Error('MAIL_MODE=smtp but SMTP_HOST is not set');
    const port = Number(process.env.SMTP_PORT) || 587;
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.verify();
    console.log(`[mail] SMTP ready: ${process.env.SMTP_HOST}:${port}`);
    return t;
  }
  // ethereal: real SMTP delivery to a throwaway inbox with a web preview
  const acct = await nodemailer.createTestAccount();
  const t = nodemailer.createTransport({
    host: acct.smtp.host,
    port: acct.smtp.port,
    secure: acct.smtp.secure,
    auth: { user: acct.user, pass: acct.pass },
  });
  console.log('[mail] Ethereal test inbox ready');
  console.log(`[mail]   login:  https://ethereal.email/login`);
  console.log(`[mail]   user:   ${acct.user}`);
  console.log(`[mail]   pass:   ${acct.pass}`);
  console.log('[mail]   every confirmation email also returns a direct preview URL');
  return t;
}

/** Warm up the transport at startup so misconfiguration shows up immediately. */
function init() {
  if (!transporterPromise) {
    transporterPromise = buildTransporter().catch((err) => {
      console.error('[mail] transport unavailable:', err.message);
      transporterPromise = null; // allow a retry on the next send
      throw err;
    });
  }
  return transporterPromise;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function renderTicketEmail({ ticket, ticketUrl, qrCid }) {
  const name = escapeHtml(ticket.name);
  const title = escapeHtml(ticket.title);
  const venue = escapeHtml(ticket.venue);
  const when = escapeHtml(formatWhen(ticket.starts_at));
  const tid = escapeHtml(ticket.id);
  const token = escapeHtml(ticket.token);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Your ticket for ${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f2a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e6ee;">
  <tr>
    <td style="background:#2a3cff;background-image:linear-gradient(135deg,#2a3cff,#7b2ff7);padding:28px 32px;color:#ffffff;">
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;opacity:.85;">Campus Events</div>
      <div style="font-size:26px;font-weight:700;margin-top:6px;">You're in, ${name}!</div>
      <div style="font-size:15px;opacity:.9;margin-top:4px;">Your ticket for <strong>${title}</strong> is confirmed.</div>
    </td>
  </tr>
  <tr>
    <td style="padding:28px 32px 8px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e6ee;border-radius:12px;">
        <tr><td style="padding:16px 20px;">
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">Event</div>
          <div style="font-size:18px;font-weight:600;margin-top:2px;">${title}</div>
          <div style="font-size:14px;color:#374151;margin-top:10px;">&#128197;&nbsp; ${when}</div>
          <div style="font-size:14px;color:#374151;margin-top:4px;">&#128205;&nbsp; ${venue}</div>
        </td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:20px 32px 8px 32px;">
      <div style="font-size:14px;color:#374151;margin-bottom:12px;">Show this QR code at the door. It is unique to you and works once.</div>
      <img src="cid:${qrCid}" width="240" height="240" alt="Your ticket QR code" style="display:block;width:240px;height:240px;border:1px solid #e3e6ee;border-radius:12px;padding:8px;background:#fff;">
      <div style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#6b7280;margin-top:10px;">Ticket ID: ${tid}</div>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:16px 32px 28px 32px;">
      <a href="${ticketUrl}" style="display:inline-block;background:#2a3cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:999px;">Open my ticket</a>
      <div style="font-size:12px;color:#6b7280;margin-top:14px;">Can't see the image? Open the link above, or give this code to the organizer:</div>
      <div style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#374151;word-break:break-all;margin-top:6px;padding:10px;background:#f6f7fb;border-radius:8px;text-align:left;">${token}</div>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 32px;background:#f6f7fb;border-top:1px solid #e3e6ee;font-size:12px;color:#6b7280;">
      This ticket is signed and verified at check-in. Please don't share it. Questions? Reply to this email.
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `You're in, ${ticket.name}!`,
    '',
    `Event:  ${ticket.title}`,
    `When:   ${formatWhen(ticket.starts_at)}`,
    `Where:  ${ticket.venue}`,
    '',
    `Open your ticket (with QR code): ${ticketUrl}`,
    '',
    'If you cannot scan the QR code, give this code to the organizer:',
    ticket.token,
    '',
    `Ticket ID: ${ticket.id}`,
  ].join('\n');

  return { html, text };
}

/**
 * Send the confirmation email with the QR embedded inline.
 * @returns {Promise<{status:'sent'|'skipped'|'failed', previewUrl?:string, messageId?:string, error?:string}>}
 */
async function sendTicketEmail({ ticket, qrPng, baseUrl }) {
  let transporter;
  try {
    transporter = await init();
  } catch (err) {
    return { status: 'failed', error: `Mail transport unavailable: ${err.message}` };
  }
  if (!transporter) return { status: 'skipped' };

  const ticketUrl = `${baseUrl}/ticket/${encodeURIComponent(ticket.id)}`;
  const qrCid = `ticket-qr-${ticket.id}@campus-events`;
  const { html, text } = renderTicketEmail({ ticket, ticketUrl, qrCid });

  try {
    const info = await transporter.sendMail({
      from: FROM,
      to: `"${ticket.name.replace(/"/g, '')}" <${ticket.email}>`,
      subject: `Your ticket for ${ticket.title}`,
      text,
      html,
      attachments: [
        { filename: 'ticket-qr.png', content: qrPng, contentType: 'image/png', cid: qrCid },
      ],
    });
    const previewUrl = MODE === 'ethereal' ? nodemailer.getTestMessageUrl(info) || undefined : undefined;
    return { status: 'sent', messageId: info.messageId, previewUrl };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

module.exports = { init, sendTicketEmail, renderTicketEmail, MODE };
