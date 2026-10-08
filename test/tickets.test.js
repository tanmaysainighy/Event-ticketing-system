'use strict';
process.env.TICKET_SECRET = 'test-secret-for-unit-tests-0123456789';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signTicket, verifyToken, newTicketId } = require('../src/tickets');

test('signed token verifies and round-trips its claims', () => {
  const ticketId = newTicketId();
  const token = signTicket({ ticketId, eventId: 7 });
  assert.match(token, /^EVT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const v = verifyToken(token);
  assert.equal(v.ok, true);
  assert.equal(v.ticketId, ticketId);
  assert.equal(v.eventId, 7);
  assert.equal(typeof v.issuedAt, 'number');
});

test('tampering with the signature is rejected', () => {
  const token = signTicket({ ticketId: newTicketId(), eventId: 1 });
  const [p, payload, sig] = token.split('.');
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  const v = verifyToken(`${p}.${payload}.${flipped}`);
  assert.equal(v.ok, false);
  assert.match(v.reason, /Signature mismatch/);
});

test('tampering with the payload (changing event id) is rejected', () => {
  const token = signTicket({ ticketId: newTicketId(), eventId: 1 });
  const [p, payload, sig] = token.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  data.eid = 2;
  const forged = Buffer.from(JSON.stringify(data)).toString('base64url');
  const v = verifyToken(`${p}.${forged}.${sig}`);
  assert.equal(v.ok, false);
  assert.match(v.reason, /Signature mismatch/);
});

test('garbage inputs are rejected without throwing', () => {
  for (const bad of ['', '   ', 'hello', 'EVT1.abc', 'EVT1.abc.def.ghi', 'EVT0.abc.def', 'EVT1.a b.c', null, undefined, 42, 'x'.repeat(2000)]) {
    const v = verifyToken(bad);
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.equal(typeof v.reason, 'string');
  }
});

test('ticket ids are unique and URL-safe', () => {
  const ids = new Set(Array.from({ length: 500 }, newTicketId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{20}$/);
});
