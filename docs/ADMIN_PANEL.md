# ASTRIX Admin Panel

The admin panel is at **`/admin`**. Only admin accounts can open it. Admins are listed in the `ADMIN_INDEXES` environment variable (comma-separated); if it is not set, the admin is **`ADMIN-ASTRIX`**. Admins sign in with their normal password. Admins also see an **"Open admin panel"** link on the dashboard.

Alerts appear **while an admin has the panel open**. The panel refreshes every 5 s, and each refresh also runs the server checks. New alerts play a short sound and, if allowed (bell button), show a browser notification.

## One-time setup
The admin account (`admin-astrix`) can't be made through signup. Run `node scripts/create-admin.mjs`, enter an email and password, and paste the SQL it prints into the Supabase SQL Editor. Running it again resets that account's password. Sign in with `admin-astrix` as the index number.

Run [`supabase/migrations/20261026_admin_panel.sql`](../supabase/migrations/20261026_admin_panel.sql) once in the Supabase SQL Editor. It creates the `admin_events` table (activity log + alerts) and adds `users.is_locked`. Until it is run, the app works normally, but the panel shows no alerts or activity and accounts can't be locked.

## What the panel shows and does

| Tab | Shows | Actions |
| :--- | :--- | :--- |
| **Overview** | Cabinet online/offline, all 4 slots (database vs. cabinet report, lock state), open/overdue loans, student count, open alerts, latest activity | Refresh |
| **Alerts** | Open alerts (optionally handled ones too) | Mark handled, mark all handled |
| **Slots** | Each slot's state | Open lock, close lock, release a held slot, Hold / Release hold (students can't borrow from a slot an admin holds until it is released; returns still work; needs `supabase/migrations/20261028_slot_admin_hold.sql`) |
| **Loans** | Open / returned / all loans | Mark returned, extend +24 h, delete the record |
| **Users** | Students with search, lock state, open loan | Lock/unlock, email a password reset code, delete (only without an open loan) |
| **Activity** | Every borrow, return, sign-in, signup, password reset, cabinet event and admin action, with who did it | — |

Admin accounts can't be locked or deleted from the panel. Every admin action is recorded in the activity log as `admin:<index>`.

## Alerts (unusual events)

**Cabinet and umbrellas**
| Alert | When |
| :--- | :--- |
| `CABINET_OFFLINE` | The cabinet's status says offline (clears itself when it is back) |
| `CABINET_NO_RESPONSE` | The cabinet confirmed a borrow/return but never sent the result (slot held) |
| `WRONG_UMBRELLA_RETURNED` | A student put the wrong umbrella in; the slot was left unlocked |
| `SLOT_LEFT_UNLOCKED` | A slot has been unlocked (and idle) for more than 2 minutes — needs the newer firmware (clears itself when locked) |
| `UMBRELLA_MISSING` | A slot is empty with no loan — taken by hand? (clears itself when the umbrella is back) |
| `UNKNOWN_TAG_IN_SLOT` | A tag that isn't one of the 4 umbrellas is in a slot |
| `WRONG_UMBRELLA_IN_SLOT` | Another umbrella is sitting in a slot |
| `RETURNED_AT_CABINET` | A loan was closed because the umbrella was put back outside the website (e.g. `r1`) |
| `STALE_HOLD_RELEASED` | A slot held after an unanswered borrow was released automatically |
| `LOST_BORROW_RECORDED` / `LOST_BORROW_NOT_RECORDED` | A borrow's answer was lost but the slot is empty, so the loan was recorded (or couldn't be) |
| `LOAN_NOT_RECORDED` | An umbrella was taken but saving the loan failed |

**Loans**
| Alert | When |
| :--- | :--- |
| `LOAN_OVERDUE` | Past the 24 h due time |
| `LOAN_VERY_OVERDUE` | More than a day past the due time |
| `REPEATED_NOT_TAKEN` | A student opened a slot 3+ times in an hour without taking the umbrella |

**Security and errors**
| Alert | When |
| :--- | :--- |
| `PRIVILEGED_LOGIN_FAILED` | Wrong password on an admin (critical) or developer account |
| `TOO_MANY_LOGIN_ATTEMPTS` | The sign-in limit was hit for an account or network |
| `TOO_MANY_CODE_ATTEMPTS` | Too many wrong verification/reset codes |
| `SIGNUP_FLOOD` / `PASSWORD_RESET_FLOOD` | Too many signup or reset emails requested |
| `EMAIL_FAILED` | A verification or reset email could not be sent |
| `SERVER_ERROR` | A sign-in, signup, verify, reset, borrow or return request failed with a server error |

An alert with the same type and subject isn't repeated while an earlier one is still open.

## Possible later additions (not built)
- Email or Telegram alerts, so the admin is told even when the panel is closed
- Phone push notifications from the site
- A free every-minute check (e.g. cron-job.org calling a secret URL) so alerts are created even when nobody has the site open
