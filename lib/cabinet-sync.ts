import mqtt from 'mqtt';
import { supabaseAdmin } from './supabase';
import { getBrokerOptions, getEffectiveBrokerUrl, MQTT_TOPIC_SLOTS, MQTT_TOPIC_STATUS } from './mqtt';
import { CabinetSlotState, claimSync, parseStatus, saveCabinetSlots, saveCabinetStatus } from './cabinet-state';
import { sendReturnReceiptEmail } from './email';
import { formatLoanDuration } from './loans';
import { logActivity, raiseAlert } from './events';

export type { CabinetSlotState } from './cabinet-state';

// =====================================================================
// Keeps the database in step with what is physically in the cabinet.
// The cabinet publishes a retained message on astrix-umbrella/cabinet/slots:
//   {"slots":[{"slot":1,"busy":false,"docked":true,"umbrella":1}, ...]}
// (umbrella = number read on that slot's reader, 0 = unknown tag, null = no tag)
// This catches umbrellas returned or taken at the cabinet outside the website,
// and settles borrows/returns whose result never arrived.
//
// Every change goes through a database function that re-checks the slot
// under a lock (supabase/migrations/20261028_lifecycle.sql), so a report
// that races a fresh borrow or return changes nothing.
//
// NOTE: on the public broker anyone can publish this message. Move to a private
// broker before relying on this with real students.
// =====================================================================

const SYNC_EVERY_MS = 15000;     // at most one sync every 15 s across all server instances
const NEW_LOAN_GRACE_S = 60;     // never auto-close a loan younger than this
const STALE_OP_S = 60;           // a real borrow/return finishes in under 50 s

let running: Promise<void> | null = null;

/**
 * Runs a sync unless one ran recently (on any server). Safe to call often (e.g. from /api/me).
 */
export function syncCabinetSlots(everyMs = SYNC_EVERY_MS): Promise<void> {
  if (running) return running;
  running = (async () => {
    if (!(await claimSync(everyMs))) return;
    await doSync();
  })()
    .catch((err) => console.warn('⚠️ [Cabinet Sync] Failed:', err?.message || err))
    .finally(() => {
      running = null;
    });
  return running;
}

/**
 * Reads the cabinet's retained status and slot report (null if none arrives in time)
 */
function readCabinet(timeoutMs = 3000): Promise<{ online: boolean | null; slots: CabinetSlotState[] | null }> {
  return new Promise((resolve) => {
    const client = mqtt.connect(getEffectiveBrokerUrl(), getBrokerOptions('astrix-sync'));
    let finished = false;
    let slots: CabinetSlotState[] | null = null;
    let online: boolean | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        client.end(true);
      } catch {}
      resolve({ online, slots });
    };
    const timer = setTimeout(finish, timeoutMs);

    client.on('connect', () => {
      client.subscribe([MQTT_TOPIC_SLOTS, MQTT_TOPIC_STATUS], { qos: 0 }, (err) => {
        if (err) finish();
      });
    });
    client.on('message', (topic, message) => {
      if (topic === MQTT_TOPIC_STATUS) {
        const status = parseStatus(message.toString());
        if (status) {
          online = status.online;
          void saveCabinetStatus(status);
        }
      } else {
        try {
          const data = JSON.parse(message.toString());
          if (Array.isArray(data.slots)) slots = data.slots;
        } catch {
          // Ignore anything that isn't a slot state message
        }
      }
      if (slots && online !== null) finish();
    });
    client.on('error', finish);
  });
}

async function doSync() {
  const { online, slots } = await readCabinet();
  if (!slots) return;
  await saveCabinetSlots(slots);

  // A retained report from a cabinet that has since gone offline may be old: don't act on it
  if (online === false) return;

  for (const s of slots) {
    const slot = Number(s.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4 || s.busy) continue;

    const home = s.docked && s.umbrella === slot;
    const gone = !s.docked && s.umbrella === null;

    // A borrow/return whose result never arrived: settle it from what the cabinet sees
    if (home || gone) await settleStale(slot, home ? 'home' : 'gone');

    if (home) await returnedAtCabinet(slot);
    else if (gone) await markMissing(slot);
  }
}

async function settleStale(slot: number, state: 'home' | 'gone') {
  const { data, error } = await supabaseAdmin.rpc('sync_settle_stale', { p_slot: slot, p_state: state, p_stale_s: STALE_OP_S });
  if (error) return console.warn('⚠️ [Cabinet Sync] settle failed:', error.message);
  const row = data?.[0];
  if (!row || row.action === 'NONE') return;

  const who = row.index_no;
  const messages: Record<string, [string, 'info' | 'warning', string]> = {
    RELEASED: ['STALE_HOLD_RELEASED', 'info', `Slot ${slot} was held for ${who} after a borrow that never completed. The umbrella is still there, so the hold was released.`],
    LOAN_RECORDED: ['LOST_BORROW_RECORDED', 'warning', `The cabinet's answer for ${who}'s borrow from Slot ${slot} was lost, but the slot is empty, so the loan was recorded for them.`],
    RETURNED: ['LOST_RETURN_RECORDED', 'info', `The cabinet's answer for ${who}'s return to Slot ${slot} was lost, but the umbrella is back, so the loan was closed.`],
    RETURN_ABORTED: ['STALE_RETURN_CLEARED', 'info', `${who}'s return to Slot ${slot} never completed and the slot is empty, so the loan stays open.`],
  };
  const m = messages[row.action];
  if (m) {
    console.log(`🔄 [Cabinet Sync] ${m[2]}`);
    await raiseAlert(m[0], m[1], m[2], { slot, index_no: who, actor: 'system' });
  }
}

/**
 * The slot's own umbrella is back but the database says it is out: close its open loan.
 */
async function returnedAtCabinet(slot: number) {
  const { data: closed, error } = await supabaseAdmin.rpc('sync_returned_at_cabinet', { p_slot: slot, p_grace_s: NEW_LOAN_GRACE_S });
  if (error) return console.warn('⚠️ [Cabinet Sync] return check failed:', error.message);

  for (const loan of closed || []) {
    console.log(`🔄 [Cabinet Sync] Umbrella ${slot} is back in Slot ${slot}: closed loan for ${loan.index_no}.`);
    await raiseAlert('RETURNED_AT_CABINET', 'info', `Umbrella ${slot} was put back in Slot ${slot} outside the website, so ${loan.index_no}'s loan was closed automatically.`, {
      slot, index_no: loan.index_no, actor: 'cabinet', details: { record_id: loan.record_id },
    });
    await logActivity('RETURN', `${loan.index_no} returned Umbrella ${slot} at the cabinet (closed by sync)`, {
      slot, index_no: loan.index_no, actor: 'cabinet',
    });
    try {
      const { data: user } = await supabaseAdmin.from('users').select('email, username').eq('index_no', loan.index_no).maybeSingle();
      if (user?.email) {
        await sendReturnReceiptEmail(user.email, user.username || 'Student', slot, loan.umbrella_id, formatLoanDuration(loan.borrowed_time));
      }
    } catch (e) {
      console.warn('⚠️ [Cabinet Sync] Receipt email warning:', e);
    }
  }
}

/**
 * The database says the slot has its umbrella, but the cabinet reports it empty
 * (taken at the cabinet, not through the website): stop offering it.
 */
async function markMissing(slot: number) {
  const { data: changed, error } = await supabaseAdmin.rpc('sync_mark_missing', { p_slot: slot });
  if (error) return console.warn('⚠️ [Cabinet Sync] missing check failed:', error.message);
  if (changed) {
    console.warn(`🔄 [Cabinet Sync] Slot ${slot} is empty at the cabinet: marked as out (no loan recorded).`);
    await raiseAlert('UMBRELLA_MISSING', 'critical', `Umbrella ${slot} is missing from Slot ${slot} with no loan recorded. It may have been taken by hand.`, {
      slot, actor: 'cabinet', dedupeKey: `slot:${slot}`,
    });
  }
}
