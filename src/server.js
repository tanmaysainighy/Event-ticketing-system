'use strict';
require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const store = require('./store');
const { signTicket, verifyToken } = require('./tickets');
const mailer = require('./mailer');
const sse = require('./sse');

const PORT = Number(process.env.PORT) || 3000;
const ORGANIZER_KEY = process.env.ORGANIZER_KEY || 'organizer123';
if (!process.env.ORGANIZER_KEY) console.warn('[server] ORGANIZER_KEY not set; using default "organizer123"');

// Serverless instances don't share memory, so an SSE stream on one instance can't see
// scans handled by another. On Vercel the organizer UI polls instead.
const SSE_ENABLED = process.env.REALTIME ? process.env.REALTIME === 'sse' : !process.env.VERCEL;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));

// Wait for the database (schema + seed) before serving anything dynamic.
app.use(async (_req, _res, next) => {
  try { await store.ready; next(); } catch (err) { next(err); }
});

// ---------- Pages ----------
const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', page('index.html'));
app.get('/events/:id', page('event.html'));
app.get('/success/:ticketId', page('success.html'));
app.get('/ticket/:ticketId', page('ticket.html'));
app.get('/organizer', page('organizer.html'));

// ---------- Helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function baseUrlFor(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function publicEvent(e) {
  if (!e) return null;
  const remaining = Math.max(0, e.capacity - e.registered);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    venue: e.venue,
    startsAt: e.starts_at,
    category: e.category,
    capacity: e.capacity,
    registered: e.registered,
    checkedIn: e.checked_in,
    remaining,
    soldOut: remaining === 0,
  };
}

function publicTicket(t) {
  if (!t) return null;
  return {
    id: t.id,
    status: t.status,
    name: t.name,
    email: t.email,
    studentId: t.student_id,
    createdAt: t.created_at,
    checkedInAt: t.checked_in_at,
    token: t.token,
    email_delivery: { status: t.email_status, previewUrl: t.email_preview, error: t.email_error },
    event: { id: t.event_id, title: t.title, venue: t.venue, startsAt: t.starts_at, category: t.category },
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireOrganizer(req, res, next) {
  const key = req.get('x-organizer-key') || req.query.key;
  if (!key || !safeEqual(key, ORGANIZER_KEY)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Organizer key is missing or wrong' });
  }
  next();
}

const qrOptions = (width) => ({
  type: 'png', width, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Public API ----------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    storage: store.label,
    ephemeral: store.ephemeral,
    mail: mailer.MODE,
    realtime: SSE_ENABLED ? 'sse' : 'poll',
  });
});

app.get('/api/events', wrap(async (_req, res) => {
  res.json((await store.listEvents()).map(publicEvent));
}));

app.get('/api/events/:id', wrap(async (req, res) => {
  const ev = await store.getEvent(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'NOT_FOUND', message: 'Event not found' });
  res.json(publicEvent(ev));
}));

app.post('/api/events/:id/register', wrap(async (req, res) => {
  const eventId = Number(req.params.id);
  const body = req.body || {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  const studentId = String(body.studentId || '').trim() || null;

  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'VALIDATION', field: 'name', message: 'Please enter your full name (2–80 characters).' });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'VALIDATION', field: 'email', message: 'Please enter a valid email address.' });
  }
  if (studentId && studentId.length > 32) {
    return res.status(400).json({ error: 'VALIDATION', field: 'studentId', message: 'Student ID is too long.' });
  }
  if (!Number.isInteger(eventId)) return res.status(404).json({ error: 'NOT_FOUND', message: 'Event not found' });

  let reserved;
  try {
    reserved = await store.register({
      eventId, name, email, studentId,
      sign: (ticketId, eid) => signTicket({ ticketId, eventId: eid }),
    });
  } catch (err) {
    if (err instanceof store.StoreError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    throw err;
  }

  const ticket = await store.getTicket(reserved.ticketId);
  const baseUrl = baseUrlFor(req);

  let mail;
  try {
    const qrPng = await QRCode.toBuffer(reserved.token, qrOptions(480));
    mail = await mailer.sendTicketEmail({ ticket, qrPng, baseUrl });
  } catch (err) {
    mail = { status: 'failed', error: err.message };
  }
  await store.updateEmail(reserved.ticketId, mail.status, mail.previewUrl || null, mail.error || null);
  if (mail.status !== 'sent') console.warn(`[mail] ${mail.status} for ${email}: ${mail.error || ''}`);

  const updated = publicEvent(await store.getEvent(eventId));
  if (SSE_ENABLED) sse.broadcast('registration', { eventId, registered: updated.registered, capacity: updated.capacity, name });

  res.status(201).json({
    ticketId: reserved.ticketId,
    ticketUrl: `${baseUrl}/ticket/${reserved.ticketId}`,
    email: { to: email, ...mail },
  });
}));

app.get('/api/tickets/:id', wrap(async (req, res) => {
  const t = await store.getTicket(String(req.params.id));
  if (!t) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ticket not found' });
  res.json(publicTicket(t));
}));

app.get('/api/tickets/:id/qr.png', wrap(async (req, res) => {
  const t = await store.getTicket(String(req.params.id));
  if (!t) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ticket not found' });
  const size = Math.min(1024, Math.max(128, Number(req.query.size) || 360));
  const png = await QRCode.toBuffer(t.token, qrOptions(size));
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(png);
}));

// ---------- Organizer API ----------
app.post('/api/organizer/login', requireOrganizer, (_req, res) => res.json({ ok: true, realtime: SSE_ENABLED ? 'sse' : 'poll' }));

app.get('/api/organizer/events', requireOrganizer, wrap(async (_req, res) => {
  res.json((await store.listEvents()).map(publicEvent));
}));

app.get('/api/organizer/attendees', requireOrganizer, wrap(async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!Number.isInteger(eventId)) return res.status(400).json({ error: 'VALIDATION', message: 'eventId required' });
  const rows = await store.attendees(eventId);
  res.json(rows.map((t) => ({
    id: t.id,
    name: t.name,
    email: t.email,
    studentId: t.student_id,
    status: t.status,
    createdAt: t.created_at,
    checkedInAt: t.checked_in_at,
    emailStatus: t.email_status,
  })));
}));

app.get('/api/organizer/scans', requireOrganizer, wrap(async (req, res) => {
  const eventId = req.query.eventId ? Number(req.query.eventId) : null;
  res.json(await store.recentScans(eventId));
}));

app.get('/api/organizer/stream', requireOrganizer, (req, res) => {
  if (!SSE_ENABLED) return res.status(204).end();
  sse.subscribe(req, res);
});

app.post('/api/organizer/verify', requireOrganizer, wrap(async (req, res) => {
  const body = req.body || {};
  const raw = typeof body.token === 'string' ? body.token.trim() : '';
  const selectedEventId = body.eventId ? Number(body.eventId) : null;
  const scannedAt = new Date().toISOString();

  const respond = async (payload) => {
    await store.logScan({
      ticketId: payload.ticketId, eventId: payload.eventId, result: payload.status,
      reason: payload.reason, rawToken: raw.slice(0, 1024), at: scannedAt,
    });
    const ev = payload.eventId ? publicEvent(await store.getEvent(payload.eventId)) : null;
    const out = {
      ...payload,
      scannedAt,
      counts: ev ? { registered: ev.registered, checkedIn: ev.checkedIn, capacity: ev.capacity } : undefined,
    };
    if (SSE_ENABLED) sse.broadcast('scan', out);
    res.json(out);
  };

  const v = verifyToken(raw);
  if (!v.ok) return respond({ status: 'INVALID', reason: v.reason, eventId: selectedEventId });

  const t = await store.getTicket(v.ticketId);
  if (!t || t.event_id !== v.eventId || t.token !== raw) {
    return respond({ status: 'INVALID', reason: 'Signature is valid but no matching ticket exists in the database', ticketId: v.ticketId, eventId: selectedEventId });
  }

  const attendee = { name: t.name, email: t.email, studentId: t.student_id };
  const event = { id: t.event_id, title: t.title };

  if (selectedEventId && selectedEventId !== t.event_id) {
    return respond({
      status: 'INVALID',
      reason: `This ticket is for "${t.title}", not the event selected on the scanner`,
      ticketId: t.id, eventId: t.event_id, attendee, event,
    });
  }

  // Single atomic UPDATE: only one scan can flip VALID -> CHECKED_IN.
  if (await store.checkIn(t.id, scannedAt)) {
    return respond({ status: 'CHECKED_IN', ticketId: t.id, eventId: t.event_id, attendee, event, checkedInAt: scannedAt });
  }
  const fresh = await store.getTicket(t.id);
  return respond({
    status: 'ALREADY_USED',
    reason: 'This ticket was already scanned',
    ticketId: t.id, eventId: t.event_id, attendee, event,
    checkedInAt: fresh.checked_in_at,
  });
}));

// ---------- Errors ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such API route' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_JSON', message: 'Request body is not valid JSON' });
  }
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong on the server' });
});

// ---------- Start ----------
if (require.main === module) {
  mailer.init().catch(() => { /* already logged; sends will retry */ });
  app.listen(PORT, () => {
    const base = process.env.BASE_URL || `http://localhost:${PORT}`;
    console.log(`\nCampus Events ticketing running at ${base}`);
    console.log(`  Participant portal: ${base}/`);
    console.log(`  Organizer portal:   ${base}/organizer   (key: ${ORGANIZER_KEY})\n`);
  });
}

module.exports = app;
