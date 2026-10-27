-- ================================================================
-- ASTRIX: reliable borrow/return lifecycle (run once, after the earlier migrations)
--
-- Every change to a slot or a loan now happens inside one of the functions
-- below, in a single transaction, with the conditions re-checked under a row
-- lock. That closes the races found in review: two borrows by one student,
-- a loan recorded without the slot update (or the reverse), the slot sync
-- freeing a slot someone else has just borrowed, an "overdue" write reopening
-- a returned loan, and admin actions on old loan records.
--
-- Additive only: no column is removed or renamed. Safe to run more than once.
-- ================================================================

-- 1. A slot remembers the cabinet operation in progress on it
ALTER TABLE public.umbrellas ADD COLUMN IF NOT EXISTS pending_op UUID;
ALTER TABLE public.umbrellas ADD COLUMN IF NOT EXISTS pending_action TEXT CHECK (pending_action IN ('BORROW', 'RETURN'));
ALTER TABLE public.umbrellas ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ;

-- 2. A loan remembers which operation created it, so completing twice is harmless
ALTER TABLE public.borrow_records ADD COLUMN IF NOT EXISTS op_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS borrow_records_op_id ON public.borrow_records (op_id) WHERE op_id IS NOT NULL;

-- One open loan per umbrella (alongside the existing one open loan per student)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT umbrella_id FROM public.borrow_records
    WHERE status IN ('ACTIVE', 'OVERDUE') GROUP BY umbrella_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_loan_per_umbrella
      ON public.borrow_records (umbrella_id) WHERE status IN ('ACTIVE', 'OVERDUE');
  ELSE
    RAISE NOTICE 'An umbrella has more than one open loan: close the extra rows, then run this block again.';
  END IF;
END $$;

-- 3. Password reset codes: stored as a keyed hash, with an attempt budget
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reset_attempts INT NOT NULL DEFAULT 0;

-- 4. Rate limits shared by every server instance (replaces the in-memory counters)
CREATE TABLE IF NOT EXISTS public.rate_limits (
    key TEXT PRIMARY KEY,
    count INT NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
);

-- 5. The cabinet's last known status and slot report, shared by every server instance
CREATE TABLE IF NOT EXISTS public.cabinet_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    online BOOLEAN,
    ack BOOLEAN NOT NULL DEFAULT FALSE,
    status_at TIMESTAMPTZ,
    slots JSONB,
    slots_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ
);
INSERT INTO public.cabinet_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cabinet_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits, public.cabinet_state FROM anon, authenticated;

-- ================================================================
-- Rate limit: counts one hit and says whether it is within the limit
-- ================================================================
CREATE OR REPLACE FUNCTION public.hit_rate_limit(p_key TEXT, p_limit INT, p_window_s INT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_count INT;
BEGIN
  INSERT INTO public.rate_limits AS r (key, count, reset_at)
  VALUES (p_key, 1, NOW() + make_interval(secs => p_window_s))
  ON CONFLICT (key) DO UPDATE
    SET count = CASE WHEN r.reset_at < NOW() THEN 1 ELSE r.count + 1 END,
        reset_at = CASE WHEN r.reset_at < NOW() THEN NOW() + make_interval(secs => p_window_s) ELSE r.reset_at END
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END $$;

-- ================================================================
-- BORROW
-- ================================================================

-- Claims the lowest free slot for a student, or says why not.
-- Returns: status = OK | HAS_LOAN | IN_PROGRESS | NONE_FREE
CREATE OR REPLACE FUNCTION public.begin_borrow(p_index TEXT)
RETURNS TABLE (status TEXT, slot INT, umbrella_id TEXT, op UUID) LANGUAGE plpgsql AS $$
DECLARE v_slot INT; v_umbrella TEXT; v_op UUID := gen_random_uuid();
BEGIN
  -- One borrow decision at a time per student (double taps, two tabs, slow requests)
  PERFORM pg_advisory_xact_lock(hashtext('astrix-borrow:' || p_index));

  IF EXISTS (SELECT 1 FROM public.borrow_records b WHERE b.index_no = p_index AND b.status IN ('ACTIVE', 'OVERDUE')) THEN
    RETURN QUERY SELECT 'HAS_LOAN'::TEXT, NULL::INT, NULL::TEXT, NULL::UUID; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.umbrellas u WHERE u.borrowed_user = p_index AND u.availability) THEN
    RETURN QUERY SELECT 'IN_PROGRESS'::TEXT, NULL::INT, NULL::TEXT, NULL::UUID; RETURN;
  END IF;

  SELECT u.slot, u.umbrella_id INTO v_slot, v_umbrella
  FROM public.umbrellas u
  WHERE u.availability AND u.borrowed_user IS NULL AND u.pending_op IS NULL
  ORDER BY u.slot
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_slot IS NULL THEN
    RETURN QUERY SELECT 'NONE_FREE'::TEXT, NULL::INT, NULL::TEXT, NULL::UUID; RETURN;
  END IF;

  UPDATE public.umbrellas u
  SET borrowed_user = p_index, pending_op = v_op, pending_action = 'BORROW', pending_since = NOW(), updated_at = NOW()
  WHERE u.slot = v_slot;

  RETURN QUERY SELECT 'OK'::TEXT, v_slot, v_umbrella, v_op;
END $$;

-- The umbrella was taken: record the loan and mark the slot out. Idempotent.
-- Returns the loan (or nothing if the operation is unknown/was released).
CREATE OR REPLACE FUNCTION public.complete_borrow(p_op UUID)
RETURNS TABLE (record_id UUID, index_no TEXT, slot INT, umbrella_id TEXT, borrowed_time TIMESTAMPTZ, due_time TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE v_slot public.umbrellas%ROWTYPE;
BEGIN
  -- Already completed (e.g. the result arrived twice): return the existing loan
  IF EXISTS (SELECT 1 FROM public.borrow_records b WHERE b.op_id = p_op) THEN
    RETURN QUERY SELECT b.record_id, b.index_no::TEXT, u.slot, b.umbrella_id::TEXT, b.borrowed_time, b.due_time
      FROM public.borrow_records b LEFT JOIN public.umbrellas u ON u.umbrella_id = b.umbrella_id WHERE b.op_id = p_op;
    RETURN;
  END IF;

  SELECT * INTO v_slot FROM public.umbrellas u WHERE u.pending_op = p_op AND u.pending_action = 'BORROW' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  INSERT INTO public.borrow_records AS b (umbrella_id, index_no, status, borrowed_time, due_time, op_id)
  VALUES (v_slot.umbrella_id, v_slot.borrowed_user, 'ACTIVE', NOW(), NOW() + INTERVAL '24 hours', p_op)
  RETURNING b.record_id, b.index_no::TEXT, v_slot.slot, b.umbrella_id::TEXT, b.borrowed_time, b.due_time;

  UPDATE public.umbrellas u
  SET availability = FALSE, pending_op = NULL, pending_action = NULL, pending_since = NULL, updated_at = NOW()
  WHERE u.slot = v_slot.slot;
END $$;

-- The borrow didn't happen (not taken, cabinet busy/offline before sending): free the slot
CREATE OR REPLACE FUNCTION public.release_borrow(p_op UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.umbrellas u
  SET borrowed_user = NULL, pending_op = NULL, pending_action = NULL, pending_since = NULL, updated_at = NOW()
  WHERE u.pending_op = p_op AND u.pending_action = 'BORROW' AND u.availability;
  RETURN FOUND;
END $$;

-- ================================================================
-- RETURN
-- ================================================================

-- Marks the student's umbrella slot as "return in progress".
-- Returns: status = OK | NO_LOAN | IN_PROGRESS | SLOT_NOT_OUT | NO_SLOT
CREATE OR REPLACE FUNCTION public.begin_return(p_index TEXT)
RETURNS TABLE (status TEXT, slot INT, umbrella_id TEXT, op UUID, record_id UUID, borrowed_time TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE v_loan public.borrow_records%ROWTYPE; v_slot public.umbrellas%ROWTYPE; v_op UUID := gen_random_uuid();
BEGIN
  SELECT * INTO v_loan FROM public.borrow_records b
  WHERE b.index_no = p_index AND b.status IN ('ACTIVE', 'OVERDUE') ORDER BY b.borrowed_time DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NO_LOAN'::TEXT, NULL::INT, NULL::TEXT, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;

  SELECT * INTO v_slot FROM public.umbrellas u WHERE u.umbrella_id = v_loan.umbrella_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NO_SLOT'::TEXT, NULL::INT, v_loan.umbrella_id::TEXT, NULL::UUID, v_loan.record_id, v_loan.borrowed_time; RETURN;
  END IF;
  IF v_slot.pending_op IS NOT NULL THEN
    -- A return that never got an answer is retried after a minute
    IF v_slot.pending_action = 'RETURN' AND v_slot.pending_since < NOW() - INTERVAL '60 seconds' THEN
      NULL;
    ELSE
      RETURN QUERY SELECT 'IN_PROGRESS'::TEXT, v_slot.slot, v_slot.umbrella_id::TEXT, NULL::UUID, v_loan.record_id, v_loan.borrowed_time; RETURN;
    END IF;
  END IF;
  IF v_slot.availability THEN
    RETURN QUERY SELECT 'SLOT_NOT_OUT'::TEXT, v_slot.slot, v_slot.umbrella_id::TEXT, NULL::UUID, v_loan.record_id, v_loan.borrowed_time; RETURN;
  END IF;

  UPDATE public.umbrellas u
  SET pending_op = v_op, pending_action = 'RETURN', pending_since = NOW(), updated_at = NOW()
  WHERE u.slot = v_slot.slot;

  RETURN QUERY SELECT 'OK'::TEXT, v_slot.slot, v_slot.umbrella_id::TEXT, v_op, v_loan.record_id, v_loan.borrowed_time;
END $$;

-- The right umbrella is back: close its loan and free the slot. Idempotent.
CREATE OR REPLACE FUNCTION public.complete_return(p_op UUID)
RETURNS TABLE (record_id UUID, index_no TEXT, slot INT, umbrella_id TEXT, borrowed_time TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE v_slot public.umbrellas%ROWTYPE;
BEGIN
  SELECT * INTO v_slot FROM public.umbrellas u WHERE u.pending_op = p_op AND u.pending_action = 'RETURN' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.borrow_records b SET status = 'RETURNED', returned_time = NOW()
  WHERE b.umbrella_id = v_slot.umbrella_id AND b.status IN ('ACTIVE', 'OVERDUE')
  RETURNING b.record_id, b.index_no::TEXT, v_slot.slot, b.umbrella_id::TEXT, b.borrowed_time;

  UPDATE public.umbrellas u
  SET availability = TRUE, borrowed_user = NULL, pending_op = NULL, pending_action = NULL, pending_since = NULL, updated_at = NOW()
  WHERE u.slot = v_slot.slot;
END $$;

-- The return didn't happen (no umbrella, wrong umbrella, cabinet busy/offline): the loan stays open
CREATE OR REPLACE FUNCTION public.abort_return(p_op UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.umbrellas u SET pending_op = NULL, pending_action = NULL, pending_since = NULL, updated_at = NOW()
  WHERE u.pending_op = p_op AND u.pending_action = 'RETURN';
  RETURN FOUND;
END $$;

-- ================================================================
-- SLOT SYNC (what the cabinet reports physically)
-- Each function re-checks the slot under a lock, so a report that raced a
-- fresh borrow or return changes nothing.
-- ================================================================

-- The slot's own umbrella is docked but the database says it's out: close its loan.
-- Leaves alone loans younger than p_grace_s and slots with an operation in progress.
CREATE OR REPLACE FUNCTION public.sync_returned_at_cabinet(p_slot INT, p_grace_s INT DEFAULT 60)
RETURNS TABLE (record_id UUID, index_no TEXT, umbrella_id TEXT, borrowed_time TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE v_slot public.umbrellas%ROWTYPE;
BEGIN
  SELECT * INTO v_slot FROM public.umbrellas u WHERE u.slot = p_slot FOR UPDATE;
  IF NOT FOUND OR v_slot.availability OR v_slot.pending_op IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.borrow_records b WHERE b.umbrella_id = v_slot.umbrella_id AND b.status IN ('ACTIVE', 'OVERDUE')
             AND b.borrowed_time > NOW() - make_interval(secs => p_grace_s)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.borrow_records b SET status = 'RETURNED', returned_time = NOW()
  WHERE b.umbrella_id = v_slot.umbrella_id AND b.status IN ('ACTIVE', 'OVERDUE')
  RETURNING b.record_id, b.index_no::TEXT, b.umbrella_id::TEXT, b.borrowed_time;

  UPDATE public.umbrellas u SET availability = TRUE, borrowed_user = NULL, updated_at = NOW() WHERE u.slot = p_slot;
END $$;

-- A free slot is empty at the cabinet (taken by hand?): stop offering it. Returns true if changed.
CREATE OR REPLACE FUNCTION public.sync_mark_missing(p_slot INT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.umbrellas u SET availability = FALSE, updated_at = NOW()
  WHERE u.slot = p_slot AND u.availability AND u.borrowed_user IS NULL AND u.pending_op IS NULL;
  RETURN FOUND;
END $$;

-- An operation older than p_stale_s has no answer: settle it from what the cabinet reports.
--   p_state = 'home': its umbrella is docked  → a borrow never happened (release) / a return happened (complete)
--   p_state = 'gone': the slot is empty      → a borrow happened (record the loan) / a return didn't (abort)
-- Returns what was done: RELEASED | LOAN_RECORDED | RETURNED | RETURN_ABORTED | NONE
CREATE OR REPLACE FUNCTION public.sync_settle_stale(p_slot INT, p_state TEXT, p_stale_s INT DEFAULT 60)
RETURNS TABLE (action TEXT, op UUID, index_no TEXT) LANGUAGE plpgsql AS $$
DECLARE v_slot public.umbrellas%ROWTYPE;
BEGIN
  SELECT * INTO v_slot FROM public.umbrellas u WHERE u.slot = p_slot FOR UPDATE;
  IF NOT FOUND OR v_slot.pending_op IS NULL OR v_slot.pending_since > NOW() - make_interval(secs => p_stale_s) THEN
    RETURN QUERY SELECT 'NONE'::TEXT, NULL::UUID, NULL::TEXT; RETURN;
  END IF;

  IF v_slot.pending_action = 'BORROW' AND p_state = 'home' THEN
    PERFORM public.release_borrow(v_slot.pending_op);
    RETURN QUERY SELECT 'RELEASED'::TEXT, v_slot.pending_op, v_slot.borrowed_user::TEXT;
  ELSIF v_slot.pending_action = 'BORROW' AND p_state = 'gone' THEN
    PERFORM public.complete_borrow(v_slot.pending_op);
    RETURN QUERY SELECT 'LOAN_RECORDED'::TEXT, v_slot.pending_op, v_slot.borrowed_user::TEXT;
  ELSIF v_slot.pending_action = 'RETURN' AND p_state = 'home' THEN
    PERFORM public.complete_return(v_slot.pending_op);
    RETURN QUERY SELECT 'RETURNED'::TEXT, v_slot.pending_op, v_slot.borrowed_user::TEXT;
  ELSE
    PERFORM public.abort_return(v_slot.pending_op);
    RETURN QUERY SELECT 'RETURN_ABORTED'::TEXT, v_slot.pending_op, v_slot.borrowed_user::TEXT;
  END IF;
END $$;

-- ================================================================
-- ADMIN (same guards as everything else)
-- ================================================================

-- Close an OPEN loan by hand (umbrella checked back in by staff). Frees its slot only
-- if that slot is still out for this same loan's student and nothing is in progress.
CREATE OR REPLACE FUNCTION public.admin_close_loan(p_record UUID)
RETURNS TABLE (record_id UUID, index_no TEXT, umbrella_id TEXT) LANGUAGE plpgsql AS $$
DECLARE v_loan public.borrow_records%ROWTYPE;
BEGIN
  SELECT * INTO v_loan FROM public.borrow_records b WHERE b.record_id = p_record AND b.status IN ('ACTIVE', 'OVERDUE') FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.borrow_records b SET status = 'RETURNED', returned_time = NOW() WHERE b.record_id = p_record;
  UPDATE public.umbrellas u SET availability = TRUE, borrowed_user = NULL, updated_at = NOW()
  WHERE u.umbrella_id = v_loan.umbrella_id AND NOT u.availability AND u.pending_op IS NULL
    AND (u.borrowed_user = v_loan.index_no OR u.borrowed_user IS NULL);
  RETURN QUERY SELECT v_loan.record_id, v_loan.index_no::TEXT, v_loan.umbrella_id::TEXT;
END $$;

-- Only the server (service role) may call these
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'hit_rate_limit(text,integer,integer)', 'begin_borrow(text)', 'complete_borrow(uuid)', 'release_borrow(uuid)',
    'begin_return(text)', 'complete_return(uuid)', 'abort_return(uuid)', 'sync_returned_at_cabinet(integer,integer)',
    'sync_mark_missing(integer)', 'sync_settle_stale(integer,text,integer)', 'admin_close_loan(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;

-- ================================================================
-- PASSWORD RESET: check and use up a reset code in one step
-- Returns OK | WRONG (attempts left) | EXPIRED | LOCKED (too many wrong codes) | NONE
-- ================================================================
CREATE OR REPLACE FUNCTION public.consume_reset(p_index TEXT, p_hash TEXT, p_password TEXT, p_max_attempts INT DEFAULT 5)
RETURNS TABLE (status TEXT, attempts_left INT) LANGUAGE plpgsql AS $$
DECLARE v public.users%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.users u WHERE u.index_no = p_index FOR UPDATE;
  IF NOT FOUND OR v.reset_code_hash IS NULL THEN
    RETURN QUERY SELECT 'NONE'::TEXT, 0; RETURN;
  END IF;
  IF v.reset_expires IS NULL OR v.reset_expires < NOW() THEN
    UPDATE public.users u SET reset_code_hash = NULL, reset_expires = NULL, reset_attempts = 0 WHERE u.index_no = p_index;
    RETURN QUERY SELECT 'EXPIRED'::TEXT, 0; RETURN;
  END IF;
  IF v.reset_code_hash <> p_hash THEN
    IF v.reset_attempts + 1 >= p_max_attempts THEN
      UPDATE public.users u SET reset_code_hash = NULL, reset_expires = NULL, reset_attempts = 0 WHERE u.index_no = p_index;
      RETURN QUERY SELECT 'LOCKED'::TEXT, 0; RETURN;
    END IF;
    UPDATE public.users u SET reset_attempts = u.reset_attempts + 1 WHERE u.index_no = p_index;
    RETURN QUERY SELECT 'WRONG'::TEXT, p_max_attempts - v.reset_attempts - 1; RETURN;
  END IF;
  UPDATE public.users u
  SET password = p_password, reset_code_hash = NULL, reset_expires = NULL, reset_attempts = 0,
      verification_code = NULL, verification_expires = NULL, updated_at = NOW()
  WHERE u.index_no = p_index;
  RETURN QUERY SELECT 'OK'::TEXT, 0;
END $$;
REVOKE ALL ON FUNCTION public.consume_reset(text, text, text, integer) FROM PUBLIC, anon, authenticated;
