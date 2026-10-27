# Operations: going live and keeping it running

This is the checklist for the people who own the Supabase project, the Vercel project and the cabinet. Do the steps **in order**. Steps 1 and 2 fix security problems that exist in production today.

## 1. Rotate the leaked Supabase keys (Supabase owner, ~10 min)

The production `service_role` and `anon` keys were committed to the public git history (commit `25bfce8`) and are still the live keys. Anyone with them can read or change every table.

1. Supabase → the production project → **Project Settings → API Keys**.
2. Create a new **secret key** (`sb_secret_…`) and a new **publishable key**.
3. In Vercel → Project → Settings → Environment Variables, set `SUPABASE_SERVICE_ROLE_KEY` to the new secret key. Redeploy.
4. Back in Supabase, **disable the legacy JWT-based API keys** (creating new keys alone does not revoke the old ones).
5. Set a new random `AUTH_SECRET` in Vercel (`openssl rand -hex 32`) and redeploy. Everyone is signed out once; that is expected.
6. Look over `users` and `borrow_records` for anything unexpected: the old key allowed writes, not only reads.

Steps 3 and 4 should be done together: the site is down between them.

## 2. Move the cabinet to a private MQTT broker (hardware lead + Vercel owner)

Today the cabinet listens on `broker.hivemq.com`, a public test broker with no password: anyone can open its locks.

1. Create a free **HiveMQ Cloud Serverless** cluster.
2. Create two credentials:
   - `astrix-cabinet`: may **subscribe** to `astrix-umbrella/cabinet/command` and **publish** to `astrix-umbrella/cabinet/response`, `…/ack`, `…/slots`, `…/status`.
   - `astrix-server`: the reverse (publish `…/command`; subscribe to the other four).
3. In Vercel set `HIVEMQ_BROKER_URL=wss://<cluster>.s1.eu.hivemq.cloud:8884/mqtt`, `HIVEMQ_USERNAME=astrix-server`, `HIVEMQ_PASSWORD=…`.
4. In the firmware set `MQTT_BROKER`, `MQTT_PORT = 8883`, `MQTT_USER = "astrix-cabinet"`, `MQTT_PASS`, and switch the client to `WiFiClientSecure` with the broker's CA certificate. Make `MQTT_CLIENT_ID` unique. Flash the cabinet (see 4).

Do 3 and 4 together. The cabinet is unreachable until both use the new broker.

## 3. Bring the production database up to date (Supabase owner)

Only `20261025_lockdown.sql` has been run on production. Run the rest **in this order** in the SQL editor, after reading each one:

1. `supabase/migrations/20261026_admin_panel.sql`: activity log, alerts, account locking
2. `supabase/migrations/20261027_overdue_reminders.sql`: overdue reminder column
3. `supabase/migrations/20261027_one_held_slot.sql`: **first** make sure nobody is mid-borrow (it clears duplicate holds without checking the cabinet)
4. `supabase/migrations/20261028_lifecycle.sql`: borrow/return SQL functions, shared rate limits, hashed reset codes, cabinet state

Then:

- Create the admin account: `node scripts/create-account.mjs` (role `admin`), paste the SQL it prints, and set `ADMIN_INDEXES`.
- Set `CRON_SECRET` in Vercel (`openssl rand -hex 32`).
- Optional: `SIGNUP_EMAIL_DOMAINS=uom.lk` if every student has a university mailbox.

Deploy the new code **after** step 4: it needs the new SQL functions.

## 4. Flash the updated firmware (hardware lead)

`firmware/esp32_smart_umbrella.ino` now:

- echoes the server's operation id (`op`) in its "got it" and result messages, so a late reply can never complete the wrong borrow;
- reports a successful **return only after the lock has closed** with the umbrella still docked (before, a student could pull it out while the lock was closing, after their loan had ended).

These changes have **not been compiled or tested on hardware yet**. Compile them in the Arduino IDE (ESP32 core, PubSubClient, ArduinoJson 7, MFRC522, Adafruit NeoPixel), flash, and test every case with the developer console (`DEV001`): borrow, not taken, return, no umbrella, wrong umbrella, cabinet offline.

Open hardware question: the take window is about 12 seconds (5 checks with the lock open). That is short for some users (WCAG 2.2.1, timing). Consider a longer window, or a way to choose one before unlocking.

## 5. Put the QR sticker on the cabinet

Print a QR code for `https://<your-domain>/dashboard?at=station`. Students who scan it skip the "I'm at the station" confirmation. It is a convenience, not a security check (the URL can be shared).

## Day to day

- **Admin panel:** `/admin` (alerts appear while it is open; the panel refreshes every 5 s).
- **A slot looks stuck:** Admin → Slots. "Release" ends a borrow/return that never finished; it refuses while one is genuinely in progress.
- **Overdue reminders:** Vercel Cron calls `/api/cron/overdue` daily at 08:00 Sri Lanka time.
- **Supabase free tier** pauses a project after 7 days without activity; the daily cron keeps it awake. Keep the cron enabled over holidays.
