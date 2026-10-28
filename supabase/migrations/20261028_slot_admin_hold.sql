-- ================================================================
-- ASTRIX: admin "Hold" button for slots (run once in the Supabase SQL Editor)
-- An admin can hold a slot from the admin panel. Students can't borrow from a
-- held slot until the admin presses Release hold; returns still work.
-- availability keeps following what is physically in the cabinet, so the
-- cabinet sync never releases this hold. Safe to run more than once.
-- ================================================================

ALTER TABLE public.umbrellas
    ADD COLUMN IF NOT EXISTS admin_hold BOOLEAN NOT NULL DEFAULT FALSE;
