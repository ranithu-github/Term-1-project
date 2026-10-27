# ASTRIX: smart umbrella borrowing

A campus umbrella-sharing service for University of Moratuwa students. Students register once by scanning their student ID barcode, then borrow and return umbrellas from a 4-slot cabinet with their phone. Team Astrix, Term 1 engineering project.

## How it works

| Part | Technology | Notes |
| --- | --- | --- |
| Web app and API | Next.js 15 (App Router), TypeScript, Tailwind, on Vercel | Phone-first. All database access is in API routes. |
| Database | Supabase Postgres | Row level security on, no policies: only the server (service key) can read or write. Borrow/return state changes run in guarded SQL functions. |
| Sessions | Signed httpOnly cookie (`lib/session.ts`) | Re-checked on every request; a password change or admin lock ends every session. |
| Student ID scanner | Own Code 39 decoder (`lib/barcode/`) in a Web Worker, plus the browser's BarcodeDetector where available | The UoM card's barcode prints with heavy ink spread and no quiet zone; general decoders can't read it. |
| Cabinet link | MQTT (HiveMQ) | Commands carry an operation id; the cabinet confirms ("got it"), then reports the result and what is in each slot. |
| Cabinet | ESP32-S3: 4 servo locks, 4 dock buttons, 4 RC522 RFID readers, LED strips | `firmware/esp32_smart_umbrella.ino` |
| Email | Gmail SMTP (`nodemailer`), or Resend | Codes, receipts, overdue reminders. Sent after the response, never while a student waits. |

### A borrow

1. The student taps **Borrow** (after confirming they're at the station, unless they arrived via the cabinet's QR sticker `/dashboard?at=station`).
2. `POST /api/borrow` calls `begin_borrow()`, which claims the lowest free slot for this student in one transaction. A double tap, a second tab or a slow request can't claim a second slot.
3. The response is a stream: `assigned` (which slot), `opened` (the cabinet confirmed it got the command: the take window starts), then `result`.
4. The server publishes `{"action":"BORROW","slot":N,"op":"…"}` and waits for the cabinet's answer for that operation.
5. **SUCCESS** → `complete_borrow()` records the loan and marks the slot out, atomically. **NOT_TAKEN / BUSY / offline** → `release_borrow()`. **No answer** → the slot stays held; the slot sync settles it from the cabinet's report (records the loan if the slot is empty, releases it if the umbrella is still there). The phone shows "We haven't heard back" until then.

A **return** works the same way through `begin_return()` / `complete_return()` / `abort_return()`. The slot always comes from the student's loan; each umbrella has a home slot.

### Keeping the database true to the cabinet

The cabinet publishes a retained slot report. `lib/cabinet-sync.ts` reads it at most every 15 s (across all server instances) and, through guarded SQL functions, closes loans whose umbrella is back, marks empty free slots as out, and settles operations whose answer was lost. Reports from a cabinet whose status says offline are ignored.

## Running it locally

You need Node 20+ and a **separate** Supabase project for development (never point a local app at production).

```bash
npm install
cp .env.example .env.local     # fill in the dev Supabase URL + secret key, AUTH_SECRET, CRON_SECRET
npm run dev:cabinet            # terminal 1: local MQTT broker + simulated cabinet
npm run dev                    # terminal 2: http://localhost:3000
```

Set `HIVEMQ_BROKER_URL=ws://localhost:18884/mqtt` in `.env.local`. **Never use the public broker locally**: the topic names are the real cabinet's, so a local borrow would open a real lock.

Database for a new project: run `supabase/schema.sql`, then every file in `supabase/migrations/` in date order, in the Supabase SQL editor. Create admin/developer accounts with `node scripts/create-account.mjs`.

With no email provider set, codes and emails print in the `npm run dev` terminal.

The simulated cabinet answers like the firmware. Type a key + Enter to force outcomes: `n` next borrow not taken · `e` next return finds no umbrella · `w` wrong umbrella · `s` no result (lost answer) · `x` no "got it" · `o` offline/online · `t1`–`t4` take by hand · `r1`–`r4` put back by hand · `l` old firmware (no op ids) · `p` print slots.

### Checks

```bash
npm run typecheck
npm test          # unit tests + cabinet-protocol tests against a real local MQTT broker
npm run build
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database. The key is the project's secret (`sb_secret_…`) key; server only. |
| `AUTH_SECRET` | Signs session cookies and signup tokens (≥ 32 random characters). Changing it signs everyone out. |
| `CRON_SECRET` | Protects `/api/cron/overdue` (Vercel Cron sends it automatically). |
| `ADMIN_INDEXES`, `DEV_INDEXES` | Comma-separated admin and hardware-tester accounts. |
| `SIGNUP_EMAIL_DOMAINS` | Optional, e.g. `uom.lk`: only these email domains may sign up. |
| `HIVEMQ_BROKER_URL`, `HIVEMQ_USERNAME`, `HIVEMQ_PASSWORD` | MQTT broker. Production must use a private broker with credentials. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_FROM_NAME` or `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Email delivery. |

## Repository

```
app/            pages (student app, admin panel) and API routes
components/     UI kit (ui.tsx), cabinet diagram, developer console
lib/            sessions, MQTT, cabinet sync, barcode decoder, hooks
supabase/       schema.sql and migrations (incl. the borrow/return SQL functions)
firmware/       ESP32 cabinet firmware and the old interactive simulator
scripts/        dev-cabinet.mjs (local broker + simulated cabinet), create-account.mjs
docs/           ADMIN_PANEL.md, OPERATIONS.md (going live, keys, broker, firmware)
```

Going live, rotating keys, moving to a private broker and flashing the cabinet: see [docs/OPERATIONS.md](docs/OPERATIONS.md).
