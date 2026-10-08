# Campus Event Ticketing

Multi-page event ticketing and check-in system for campus events.

Students browse events and register. The server reserves a seat (rejecting registrations once venue capacity is reached), signs a ticket token with HMAC-SHA256, renders it as a QR code and emails it. Organizers open a dedicated portal, scan QR codes with the webcam (or paste the code manually) and get an instant verdict: **CHECKED-IN**, **ALREADY USED** (with the original check-in time) or **INVALID TICKET**.

## Stack

| Layer | Choice |
|---|---|
| Server | Node.js 22+ / Express |
| Database | SQLite via the built-in `node:sqlite` module locally; Postgres (`pg`) when `DATABASE_URL` is set, e.g. on Vercel |
| Ticket signing | HMAC-SHA256, `EVT1.<payload>.<signature>` tokens |
| QR generation | `qrcode` |
| Email | Nodemailer over SMTP (Brevo, SendGrid, Resend, Gmail, Mailgun...) with an Ethereal test-inbox fallback |
| Scanner | `html5-qrcode` in the browser, plus manual token entry |
| Live updates | Server-Sent Events to the organizer dashboard |

## Quick start

```bash
npm install
cp .env.example .env     # optional; defaults work for local development
npm start
```

Then open:

- Participant portal: http://localhost:3000/
- Organizer portal: http://localhost:3000/organizer (default key `organizer123`)

With no SMTP configured the server creates a free [Ethereal](https://ethereal.email) test inbox at startup. Emails are genuinely dispatched over SMTP to that inbox, and the registration success page shows an **Open the email preview** link so you can see the delivered HTML and QR code.

## Pages

| Route | Purpose |
|---|---|
| `/` | Event list with live capacity bars; sold-out events can't be registered for |
| `/events/:id` | Event details and registration form |
| `/success/:ticketId` | Confirmation, email delivery status, QR preview |
| `/ticket/:ticketId` | The digital ticket (QR, details, copyable code, printable) |
| `/organizer` | Key-gated scanner, manual entry, live feed, stats, attendee list |

## Sending real email

Set these in `.env` and restart:

```ini
MAIL_MODE=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-brevo-login
SMTP_PASS=your-brevo-smtp-key
MAIL_FROM="Campus Events <tickets@yourdomain.edu>"
BASE_URL=https://your-public-host   # used for links inside the email
```

Provider cheat sheet:

| Provider | Host | Port | User | Pass |
|---|---|---|---|---|
| Brevo | `smtp-relay.brevo.com` | 587 | account email | SMTP key |
| SendGrid | `smtp.sendgrid.net` | 587 | `apikey` | API key |
| Resend | `smtp.resend.com` | 465 | `resend` | API key |
| Gmail | `smtp.gmail.com` | 587 | address | App Password |
| Mailgun | `smtp.mailgun.org` | 587 | SMTP login | SMTP password |

The QR code is attached as an inline CID image, so it renders in Gmail, Outlook and Apple Mail without relying on data URIs. The email also contains a link to the ticket page and the raw code as text for manual entry.

Set `MAIL_MODE=none` to skip sending entirely (used by the tests).

## How tickets are secured

1. On registration the server creates a random 20-character ticket ID and signs `{ tid, eid, iat }` with HMAC-SHA256 using `TICKET_SECRET`. The token looks like `EVT1.eyJ0aWQiOi...` and is what the QR encodes.
2. At scan time the server first checks the signature with a constant-time comparison. Anything malformed, tampered or signed with a different key is rejected as **INVALID TICKET** before the database is touched.
3. A valid signature is then matched against the database. A ticket that was deleted or never existed is also **INVALID**.
4. Check-in is a single atomic `UPDATE ... WHERE status = 'VALID'`. Only one scan can win, so two devices scanning the same ticket at once can't both check it in. The loser receives **ALREADY USED** with the original timestamp.
5. If the organizer has selected an event on the scanner, tickets for other events are refused.

Capacity is enforced inside a `BEGIN IMMEDIATE` transaction, so concurrent registrations can't oversell a venue. Duplicate registrations (same email, same event) are rejected with a clear message.

If `TICKET_SECRET` is not set, a random secret is generated once and stored in `data/.ticket-secret` so tokens survive restarts. Set it explicitly in production.

## Testing the full flow locally

1. Start the server and register for **Intro to Rock Climbing** (capacity 3) three times with different emails. The fourth attempt is rejected with a sold-out message, and the event card on the home page switches to *Venue at capacity*.
2. On the success page click **Open the email preview** to see the delivered email, or open the ticket page.
3. Open `/organizer` in another tab, enter the key, pick the event, and either:
   - click **Start camera** and point it at the QR on your phone or a second screen, or
   - expand *Can't scan?* on the ticket page, copy the code, and paste it into **Manual entry**.
4. Scan once: **CHECKED-IN**. Scan again: **ALREADY USED** with the first check-in time. Edit a character of the code and verify: **INVALID TICKET**.

Camera access requires HTTPS or `localhost`. To scan from a phone, expose the server with a tunnel (for example `npx localtunnel --port 3000` or ngrok) and set `BASE_URL` to the public URL so emailed links work.

## Deploying to Vercel

The repo is Vercel-ready: `api/index.js` wraps the Express app as a serverless function, `vercel.json` rewrites the page routes to the static HTML in `public/`, and the organizer portal switches from Server-Sent Events to polling (serverless instances don't share memory).

1. Create a project and deploy (`vercel` CLI, Git import, or the dashboard).
2. Set these environment variables on the project:
   - `TICKET_SECRET` — long random string (required; without it each instance would sign with a different key)
   - `ORGANIZER_KEY` — the key organizers type into `/organizer`
   - `MAIL_MODE` + SMTP settings as above (`ethereal` works for demos; use a real provider for production)
3. Attach a Postgres database. In the Vercel dashboard open the project, go to **Storage → Create Database → Neon** (or Supabase) and connect it; this injects `DATABASE_URL` / `POSTGRES_URL` automatically. Redeploy once.

Without a database the app still runs, but in an **in-memory SQLite** that resets on every cold start. A yellow banner on every page says so, and `GET /api/health` reports `"ephemeral": true`.

Vercel enables "Vercel Authentication" on new projects by default. Turn it off under **Settings → Deployment Protection** or visitors will be asked to log into Vercel.

## Tests

```bash
npm test
```

Covers token signing and tamper detection, capacity limits, duplicate registration, QR generation, organizer auth, check-in, double-scan detection, counterfeit rejection and wrong-event rejection, using an in-memory database and `MAIL_MODE=none`.

## API

Public:

- `GET /api/events` and `GET /api/events/:id`
- `POST /api/events/:id/register` `{ name, email, studentId? }` → `201 { ticketId, ticketUrl, email }` or `409 { error: "SOLD_OUT" | "DUPLICATE" }`
- `GET /api/tickets/:id` and `GET /api/tickets/:id/qr.png?size=360`

Organizer (header `x-organizer-key`):

- `POST /api/organizer/login`
- `GET /api/organizer/events`, `/attendees?eventId=`, `/scans?eventId=`
- `GET /api/organizer/stream` (SSE: `scan`, `registration` events)
- `POST /api/organizer/verify` `{ token, eventId? }` → `{ status: "CHECKED_IN" | "ALREADY_USED" | "INVALID", reason?, attendee?, checkedInAt?, counts? }`

## Project layout

```
src/
  server.js    Express app, routes, capacity + check-in logic
  db.js        SQLite schema and seed events
  tickets.js   HMAC token signing and verification
  mailer.js    Nodemailer transport and HTML email template
  sse.js       Server-Sent Events broadcaster
public/
  index.html event.html success.html ticket.html organizer.html
  css/styles.css  js/common.js
test/
  tickets.test.js api.test.js
```
