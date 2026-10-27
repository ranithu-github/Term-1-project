import { supabaseAdmin } from './supabase';
import { getCabinetState } from './cabinet-state';
import { syncCabinetSlots } from './cabinet-sync';
import { logActivity, raiseAlert, resolveAlerts } from './events';
import { OPEN_LOAN_STATUSES } from './types';

// =====================================================================
// Checks that run while an admin has the admin panel open (it refreshes
// every few seconds). They turn the current state into alerts:
// cabinet offline, slots left unlocked, unknown/wrong tags, overdue loans.
// Event-type alerts (wrong umbrella returned, failed sign-ins, ...) are
// raised where they happen.
// =====================================================================

const CHECK_EVERY_MS = 10000;          // at most one check per server instance every 10 s
const UNLOCKED_ALERT_AFTER_S = 120;    // a slot unlocked (and idle) longer than this is reported
const VERY_OVERDUE_MS = 24 * 60 * 60 * 1000; // 24 h past the due time

let lastCheckAt = 0;
let lastOnline: boolean | null = null;

export async function runAdminChecks() {
  // Fresh cabinet report for the panel (the sync also fixes the database)
  await syncCabinetSlots(5000);

  if (Date.now() - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = Date.now();

  const state = await getCabinetState();
  await checkCabinetOnline(state.online);
  await checkSlots(state.slots);
  await checkOverdueLoans();
}

async function checkCabinetOnline(online: boolean | null) {
  if (online === false) {
    await raiseAlert('CABINET_OFFLINE', 'critical', 'The umbrella cabinet is offline. Borrowing and returning are paused.', {
      actor: 'cabinet',
      dedupeKey: 'cabinet',
    });
  } else if (online === true) {
    await resolveAlerts('CABINET_OFFLINE', 'cabinet');
    if (lastOnline === false) {
      await logActivity('CABINET_ONLINE', 'The umbrella cabinet is back online', { actor: 'cabinet' });
    }
  }
  if (online !== null) lastOnline = online;
}

async function checkSlots(slots: Awaited<ReturnType<typeof getCabinetState>>['slots']) {
  if (!slots) return;

  for (const s of slots) {
    const slot = Number(s.slot);
    const key = `slot:${slot}`;
    if (s.busy) continue;

    // Left unlocked (newer firmware reports how long)
    if (s.locked === false && (s.unlocked_s ?? 0) >= UNLOCKED_ALERT_AFTER_S) {
      await raiseAlert('SLOT_LEFT_UNLOCKED', 'warning', `Slot ${slot} has been unlocked for ${Math.round((s.unlocked_s ?? 0) / 60)} minutes.`, {
        slot, actor: 'cabinet', dedupeKey: key,
      });
    } else if (s.locked === true) {
      await resolveAlerts('SLOT_LEFT_UNLOCKED', key);
    }

    // Tag in the slot that isn't one of our umbrellas
    if (s.umbrella === 0) {
      await raiseAlert('UNKNOWN_TAG_IN_SLOT', 'warning', `Slot ${slot} has a tag that isn't one of the 4 umbrellas.`, {
        slot, actor: 'cabinet', dedupeKey: key,
      });
    } else {
      await resolveAlerts('UNKNOWN_TAG_IN_SLOT', key);
    }

    // Another umbrella sitting in this slot
    if (typeof s.umbrella === 'number' && s.umbrella > 0 && s.umbrella !== slot) {
      await raiseAlert('WRONG_UMBRELLA_IN_SLOT', 'warning', `Slot ${slot} has Umbrella ${s.umbrella} in it (it belongs in Slot ${s.umbrella}).`, {
        slot, actor: 'cabinet', dedupeKey: key,
      });
    } else {
      await resolveAlerts('WRONG_UMBRELLA_IN_SLOT', key);
    }

    // Its own umbrella is back: a "missing" alert has cleared itself
    if (s.docked && s.umbrella === slot) {
      await resolveAlerts('UMBRELLA_MISSING', key);
    }
  }
}

async function checkOverdueLoans() {
  const now = Date.now();
  const { data: loans, error } = await supabaseAdmin
    .from('borrow_records')
    .select('record_id, umbrella_id, index_no, due_time, status')
    .in('status', [...OPEN_LOAN_STATUSES])
    .lt('due_time', new Date(now).toISOString());

  if (error || !loans) return;

  for (const loan of loans) {
    if (loan.status === 'ACTIVE') {
      // Guarded: never reopens a loan that was returned a moment ago
      await supabaseAdmin.from('borrow_records').update({ status: 'OVERDUE' })
        .eq('record_id', loan.record_id).eq('status', 'ACTIVE').lt('due_time', new Date().toISOString());
    }
    const overdueMs = now - new Date(loan.due_time).getTime();
    if (overdueMs >= VERY_OVERDUE_MS) {
      await raiseAlert('LOAN_VERY_OVERDUE', 'critical', `${loan.index_no} is more than a day late returning their umbrella.`, {
        index_no: loan.index_no, actor: 'system', dedupeKey: loan.record_id, details: { record_id: loan.record_id, due_time: loan.due_time },
      });
    } else {
      await raiseAlert('LOAN_OVERDUE', 'warning', `${loan.index_no}'s umbrella loan is overdue.`, {
        index_no: loan.index_no, actor: 'system', dedupeKey: loan.record_id, details: { record_id: loan.record_id, due_time: loan.due_time },
      });
    }
  }
}
