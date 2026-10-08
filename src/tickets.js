'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'EVT1';

function loadSecret() {
  if (process.env.TICKET_SECRET && process.env.TICKET_SECRET.length >= 16) {
    return process.env.TICKET_SECRET;
  }
  if (process.env.TICKET_SECRET) {
    console.warn('[tickets] TICKET_SECRET is shorter than 16 chars; ignoring it and using a generated secret');
  }
  const file = path.join(__dirname, '..', 'data', '.ticket-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* not present yet */ }
  const generated = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
    console.warn(`[tickets] TICKET_SECRET not set; generated one and saved it to ${file}`);
  } catch (err) {
    console.warn('[tickets] could not persist generated secret; tokens will not survive a restart', err.message);
  }
  return generated;
}

const SECRET = loadSecret();

const b64u = (input) => Buffer.from(input).toString('base64url');

function hmac(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest();
}

function newTicketId() {
  // 20 chars, URL-safe, unguessable
  return crypto.randomBytes(15).toString('base64url');
}

/** Produce a signed token of the form EVT1.<base64url payload>.<base64url HMAC-SHA256> */
function signTicket({ ticketId, eventId }) {
  const payload = b64u(JSON.stringify({ tid: ticketId, eid: Number(eventId), iat: Date.now() }));
  const sig = hmac(payload).toString('base64url');
  return `${PREFIX}.${payload}.${sig}`;
}

/**
 * Verify a token string. Never throws.
 * @returns {{ok:true, ticketId:string, eventId:number, issuedAt:number} | {ok:false, reason:string}}
 */
function verifyToken(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'Token missing' };
  const token = raw.trim();
  if (token.length === 0) return { ok: false, reason: 'Token missing' };
  if (token.length > 1024) return { ok: false, reason: 'Token too long' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: 'Not a ticket QR code' };
  }
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) {
    return { ok: false, reason: 'Malformed token' };
  }

  const expected = hmac(payload);
  const provided = Buffer.from(sig, 'base64url');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'Signature mismatch (counterfeit or tampered)' };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'Corrupt payload' };
  }
  if (!data || typeof data.tid !== 'string' || !Number.isInteger(data.eid)) {
    return { ok: false, reason: 'Corrupt payload' };
  }
  return { ok: true, ticketId: data.tid, eventId: data.eid, issuedAt: data.iat };
}

module.exports = { signTicket, verifyToken, newTicketId, PREFIX };
