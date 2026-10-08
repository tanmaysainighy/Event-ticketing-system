'use strict';
/**
 * Data layer with two interchangeable drivers:
 *   - SQLite (node:sqlite) for local development and tests
 *   - Postgres (pg) when DATABASE_URL / POSTGRES_URL is set (Vercel + Neon/Supabase)
 *
 * All SQL is written once with `?` placeholders; the Postgres driver rewrites them to $1..$n.
 */
const path = require('node:path');
const fs = require('node:fs');
const { newTicketId } = require('./tickets');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';
const ON_VERCEL = Boolean(process.env.VERCEL);

const nowIso = () => new Date().toISOString();

function schema(dialect) {
  const serial = dialect === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return `
    CREATE TABLE IF NOT EXISTS events (
      id          ${serial},
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      venue       TEXT    NOT NULL,
      starts_at   TEXT    NOT NULL,
      capacity    INTEGER NOT NULL CHECK (capacity > 0),
      category    TEXT    NOT NULL DEFAULT 'General',
      created_at  TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id             TEXT PRIMARY KEY,
      event_id       INTEGER NOT NULL REFERENCES events(id),
      name           TEXT NOT NULL,
      email          TEXT NOT NULL,
      student_id     TEXT,
      token          TEXT NOT NULL UNIQUE,
      status         TEXT NOT NULL DEFAULT 'VALID',
      created_at     TEXT NOT NULL,
      checked_in_at  TEXT,
      email_status   TEXT NOT NULL DEFAULT 'pending',
      email_preview  TEXT,
      email_error    TEXT,
      UNIQUE (event_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
    CREATE TABLE IF NOT EXISTS scan_log (
      id          ${serial},
      ticket_id   TEXT,
      event_id    INTEGER,
      result      TEXT NOT NULL,
      reason      TEXT,
      raw_token   TEXT,
      scanned_at  TEXT NOT NULL
    );
  `;
}

const SEED_EVENTS = [
  ['HackNight 2026', 'A 12-hour overnight build sprint. Teams of up to four, mentors on the floor, pizza at midnight, demos at dawn. Bring a laptop and a charger.', 'Innovation Lab, Block C', '2026-10-24T18:00:00', 120, 'Tech'],
  ['Autumn Cultural Fest', 'Music, dance, drama and food stalls from every department. The headline band plays the main stage at 8 PM.', 'Open Air Theatre', '2026-11-02T16:00:00', 500, 'Culture'],
  ['Startup Pitch Day', "Twelve student startups pitch to a panel of alumni investors. Audience votes decide the People's Choice award.", 'Auditorium Hall A', '2026-11-09T10:00:00', 200, 'Business'],
  ['Intro to Rock Climbing', 'Beginner session at the campus wall. Harnesses and shoes provided. Small group so everyone gets wall time.', 'Sports Complex Climbing Wall', '2026-10-18T09:00:00', 3, 'Sports'],
  ['Alumni Career Panel', 'Five graduates from the classes of 2016 to 2024 talk about their first jobs, career switches and what they wish they knew.', 'Seminar Room 204', '2026-10-30T15:00:00', 60, 'Career'],
  ['Night Sky Observation', 'The astronomy club opens the rooftop telescopes. Saturn, the Andromeda galaxy and, with luck, a few meteors. Dress warm.', 'Physics Block Rooftop', '2026-11-14T20:30:00', 40, 'Science'],
];

// ---------------------------------------------------------------- SQLite
function makeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  let dbPath = process.env.DB_PATH;
  let ephemeral = false;
  if (!dbPath) {
    if (ON_VERCEL) { dbPath = ':memory:'; ephemeral = true; }
    else dbPath = path.join(__dirname, '..', 'data', 'tickets.db');
  }
  if (dbPath === ':memory:') ephemeral = true;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema('sqlite'));

  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const ops = {
    all: async (sql, p = []) => stmt(sql).all(...p),
    get: async (sql, p = []) => stmt(sql).get(...p),
    run: async (sql, p = []) => ({ changes: Number(stmt(sql).run(...p).changes) }),
  };
  return {
    mode: 'sqlite',
    ephemeral,
    label: dbPath === ':memory:' ? 'SQLite (in-memory)' : `SQLite (${path.basename(dbPath)})`,
    ...ops,
    // node:sqlite calls are synchronous, so awaiting them only yields to the microtask
    // queue; no other request can interleave inside the transaction.
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn({ ...ops, lockEvent: async () => {} });
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// -------------------------------------------------------------- Postgres
function makePostgres() {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(PG_URL);
  const pool = new Pool({
    connectionString: PG_URL,
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => console.error('[store] pg pool error', err.message));

  const convert = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const wrap = (client) => ({
    all: async (sql, p = []) => (await client.query(convert(sql), p)).rows,
    get: async (sql, p = []) => (await client.query(convert(sql), p)).rows[0],
    run: async (sql, p = []) => ({ changes: (await client.query(convert(sql), p)).rowCount }),
  });

  return {
    mode: 'postgres',
    ephemeral: false,
    label: 'Postgres',
    ...wrap(pool),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          ...wrap(client),
          lockEvent: (id) => client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [id]),
          lockTable: (t) => client.query(`LOCK TABLE ${t} IN ACCESS EXCLUSIVE MODE`),
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// ------------------------------------------------------------------ init
const driver = PG_URL ? makePostgres() : makeSqlite();

async function init() {
  if (driver.mode === 'postgres') {
    await driver.exec(schema('postgres'));
  }
  // Seed inside a transaction so two cold-starting instances cannot both seed.
  await driver.transaction(async (tx) => {
    if (tx.lockTable) await tx.lockTable('events');
    const { n } = await tx.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM events');
    if (Number(n) > 0) return;
    for (const [title, description, venue, startsAt, capacity, category] of SEED_EVENTS) {
      await tx.run(
        'INSERT INTO events (title, description, venue, starts_at, capacity, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [title, description, venue, startsAt, capacity, category, nowIso()],
      );
    }
    console.log(`[store] seeded ${SEED_EVENTS.length} events`);
  });
  console.log(`[store] ready: ${driver.label}${driver.ephemeral ? ' (EPHEMERAL: data resets on restart; set DATABASE_URL for persistence)' : ''}`);
}

const ready = init().catch((err) => {
  console.error('[store] initialisation failed:', err.message);
  throw err;
});

// ---------------------------------------------------------------- queries
const EVENT_SELECT = `
  SELECT e.*,
    (SELECT CAST(COUNT(*) AS INTEGER) FROM tickets t WHERE t.event_id = e.id) AS registered,
    (SELECT CAST(COUNT(*) AS INTEGER) FROM tickets t WHERE t.event_id = e.id AND t.status = 'CHECKED_IN') AS checked_in
  FROM events e`;

const TICKET_SELECT = `
  SELECT t.*, e.title, e.venue, e.starts_at, e.category
  FROM tickets t JOIN events e ON e.id = t.event_id`;

class StoreError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const store = {
  ready,
  get mode() { return driver.mode; },
  get ephemeral() { return driver.ephemeral; },
  get label() { return driver.label; },
  StoreError,

  listEvents: () => driver.all(`${EVENT_SELECT} ORDER BY e.starts_at ASC`),
  getEvent: (id) => driver.get(`${EVENT_SELECT} WHERE e.id = ?`, [id]),

  /** Reserve a seat atomically. Throws StoreError(SOLD_OUT | DUPLICATE | NOT_FOUND). */
  register: ({ eventId, name, email, studentId, sign }) => driver.transaction(async (tx) => {
    await tx.lockEvent(eventId);
    const ev = await tx.get('SELECT * FROM events WHERE id = ?', [eventId]);
    if (!ev) throw new StoreError('NOT_FOUND', 'Event not found');
    const { n } = await tx.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM tickets WHERE event_id = ?', [eventId]);
    if (Number(n) >= ev.capacity) {
      throw new StoreError('SOLD_OUT', `Sorry, ${ev.title} has reached its venue capacity of ${ev.capacity}.`, { event: ev });
    }
    if (await tx.get('SELECT id FROM tickets WHERE event_id = ? AND email = ?', [eventId, email])) {
      throw new StoreError('DUPLICATE', 'This email is already registered for this event. Check your inbox for the ticket.');
    }
    const ticketId = newTicketId();
    const token = sign(ticketId, eventId);
    await tx.run(
      'INSERT INTO tickets (id, event_id, name, email, student_id, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ticketId, eventId, name, email, studentId, token, nowIso()],
    );
    return { ticketId, token };
  }),

  getTicket: (id) => driver.get(`${TICKET_SELECT} WHERE t.id = ?`, [id]),

  updateEmail: (id, status, preview, error) =>
    driver.run('UPDATE tickets SET email_status = ?, email_preview = ?, email_error = ? WHERE id = ?', [status, preview, error, id]),

  /** Returns true if this call performed the check-in (VALID -> CHECKED_IN). */
  checkIn: async (id, at) => {
    const r = await driver.run(`UPDATE tickets SET status = 'CHECKED_IN', checked_in_at = ? WHERE id = ? AND status = 'VALID'`, [at, id]);
    return r.changes === 1;
  },

  logScan: ({ ticketId, eventId, result, reason, rawToken, at }) =>
    driver.run('INSERT INTO scan_log (ticket_id, event_id, result, reason, raw_token, scanned_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ticketId || null, eventId || null, result, reason || null, rawToken || null, at || nowIso()]),

  attendees: (eventId) => driver.all(`
    SELECT id, name, email, student_id, status, created_at, checked_in_at, email_status
    FROM tickets WHERE event_id = ?
    ORDER BY (checked_in_at IS NULL), checked_in_at DESC, created_at DESC`, [eventId]),

  recentScans: (eventId, limit = 40) => {
    const where = eventId ? 'WHERE s.event_id = ?' : '';
    const params = eventId ? [eventId, limit] : [limit];
    return driver.all(`
      SELECT s.id, s.ticket_id AS "ticketId", s.event_id AS "eventId", s.result AS status, s.reason, s.scanned_at AS "scannedAt",
             t.name AS "attendeeName", e.title AS "eventTitle"
      FROM scan_log s
      LEFT JOIN tickets t ON t.id = s.ticket_id
      LEFT JOIN events e ON e.id = s.event_id
      ${where}
      ORDER BY s.id DESC LIMIT ?`, params);
  },
};

module.exports = store;
