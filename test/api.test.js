'use strict';
process.env.MAIL_MODE = 'none';
process.env.DB_PATH = ':memory:';
process.env.ORGANIZER_KEY = 'test-organizer-key';
process.env.TICKET_SECRET = 'test-secret-for-api-tests-0123456789';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let server;
let base;
const KEY = { 'x-organizer-key': 'test-organizer-key' };

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('lists seeded events with capacity info', async () => {
  const { status, json } = await api('GET', '/api/events');
  assert.equal(status, 200);
  assert.ok(json.length >= 5);
  const climbing = json.find((e) => e.title === 'Intro to Rock Climbing');
  assert.equal(climbing.capacity, 3);
  assert.equal(climbing.remaining, 3);
  assert.equal(climbing.soldOut, false);
});

test('registration: validation, capacity limit, duplicate email', async () => {
  const events = (await api('GET', '/api/events')).json;
  const ev = events.find((e) => e.title === 'Intro to Rock Climbing');

  const bad = await api('POST', `/api/events/${ev.id}/register`, { name: 'A', email: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'VALIDATION');

  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', `/api/events/${ev.id}/register`, { name: `Student ${i}`, email: `s${i}@campus.edu`, studentId: `S00${i}` });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(r.json.ticketId);
    assert.equal(r.json.email.status, 'skipped');
  }

  const full = await api('POST', `/api/events/${ev.id}/register`, { name: 'Late Comer', email: 'late@campus.edu' });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'SOLD_OUT');

  const after = (await api('GET', `/api/events/${ev.id}`)).json;
  assert.equal(after.registered, 3);
  assert.equal(after.soldOut, true);

  const big = events.find((e) => e.title === 'HackNight 2026');
  const first = await api('POST', `/api/events/${big.id}/register`, { name: 'Dup Person', email: 'Dup@Campus.edu' });
  assert.equal(first.status, 201);
  const dup = await api('POST', `/api/events/${big.id}/register`, { name: 'Dup Person', email: 'dup@campus.edu' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'DUPLICATE');
});

test('ticket lookup and QR image', async () => {
  const events = (await api('GET', '/api/events')).json;
  const ev = events.find((e) => e.title === 'Alumni Career Panel');
  const reg = await api('POST', `/api/events/${ev.id}/register`, { name: 'QR Tester', email: 'qr@campus.edu' });
  const t = await api('GET', `/api/tickets/${reg.json.ticketId}`);
  assert.equal(t.status, 200);
  assert.equal(t.json.status, 'VALID');
  assert.match(t.json.token, /^EVT1\./);
  assert.equal(t.json.event.title, 'Alumni Career Panel');

  const png = await fetch(`${base}/api/tickets/${reg.json.ticketId}/qr.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await png.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  assert.equal((await api('GET', '/api/tickets/does-not-exist')).status, 404);
});

test('organizer: auth, check-in, duplicate scan, counterfeit, wrong event', async () => {
  const events = (await api('GET', '/api/events')).json;
  const ev = events.find((e) => e.title === 'Startup Pitch Day');
  const other = events.find((e) => e.title === 'Autumn Cultural Fest');
  const reg = await api('POST', `/api/events/${ev.id}/register`, { name: 'Scan Me', email: 'scan@campus.edu' });
  const { token } = (await api('GET', `/api/tickets/${reg.json.ticketId}`)).json;

  // no key / wrong key
  assert.equal((await api('POST', '/api/organizer/verify', { token })).status, 401);
  assert.equal((await api('POST', '/api/organizer/verify', { token }, { 'x-organizer-key': 'wrong' })).status, 401);
  assert.equal((await api('POST', '/api/organizer/login', {}, KEY)).status, 200);

  // first scan
  const first = await api('POST', '/api/organizer/verify', { token, eventId: ev.id }, KEY);
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'CHECKED_IN');
  assert.equal(first.json.attendee.name, 'Scan Me');
  assert.ok(first.json.checkedInAt);
  assert.equal(first.json.counts.checkedIn, 1);

  // second scan
  const second = await api('POST', '/api/organizer/verify', { token, eventId: ev.id }, KEY);
  assert.equal(second.json.status, 'ALREADY_USED');
  assert.equal(second.json.checkedInAt, first.json.checkedInAt);

  // counterfeit: valid shape, bad signature
  const [p, payload] = token.split('.');
  const fake = await api('POST', '/api/organizer/verify', { token: `${p}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }, KEY);
  assert.equal(fake.json.status, 'INVALID');
  assert.match(fake.json.reason, /Signature mismatch/);

  // malformed
  const junk = await api('POST', '/api/organizer/verify', { token: 'https://example.com/not-a-ticket' }, KEY);
  assert.equal(junk.json.status, 'INVALID');

  // wrong event selected on scanner
  const reg2 = await api('POST', `/api/events/${ev.id}/register`, { name: 'Wrong Door', email: 'door@campus.edu' });
  const t2 = (await api('GET', `/api/tickets/${reg2.json.ticketId}`)).json;
  const wrong = await api('POST', '/api/organizer/verify', { token: t2.token, eventId: other.id }, KEY);
  assert.equal(wrong.json.status, 'INVALID');
  assert.match(wrong.json.reason, /not the event selected/);
  // ticket is still unused after the wrong-event rejection
  const stillValid = (await api('GET', `/api/tickets/${reg2.json.ticketId}`)).json;
  assert.equal(stillValid.status, 'VALID');

  // attendees + scan log
  const att = await api('GET', `/api/organizer/attendees?eventId=${ev.id}`, undefined, KEY);
  assert.equal(att.status, 200);
  assert.equal(att.json.length, 2);
  assert.equal(att.json[0].status, 'CHECKED_IN');

  const scans = await api('GET', `/api/organizer/scans?eventId=${ev.id}`, undefined, KEY);
  // newest first: wrong-door INVALID (logged against the ticket's real event), ALREADY_USED, CHECKED_IN
  assert.deepEqual(scans.json.slice(0, 3).map((s) => s.status), ['INVALID', 'ALREADY_USED', 'CHECKED_IN']);
  assert.match(scans.json[0].reason, /not the event selected/);
  assert.equal(scans.json[2].attendeeName, 'Scan Me');
});

test('pages are served', async () => {
  for (const p of ['/', '/events/1', '/success/abc', '/ticket/abc', '/organizer']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
