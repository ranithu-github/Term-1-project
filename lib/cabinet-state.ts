import { supabaseAdmin } from './supabase';

// =====================================================================
// The cabinet's last known status and slot report, kept in the database
// (public.cabinet_state) so every server instance sees the same thing.
// Written whenever a server reads the cabinet's retained MQTT messages.
// =====================================================================

export interface CabinetSlotState {
  slot: number;
  busy: boolean;
  docked: boolean;
  umbrella: number | null; // tag number read in the slot: 0 = unknown tag, null = none
  locked?: boolean;        // newer firmware: whether the lock is closed
  unlocked_s?: number;     // newer firmware: seconds the slot has been unlocked while idle
}

export interface CabinetState {
  online: boolean | null; // null = not known (no recent status)
  ack: boolean;           // the firmware sends "got it" replies
  status_at: string | null;
  slots: CabinetSlotState[] | null;
  slots_at: string | null;
}

// The firmware refreshes its retained status every minute; older than this = unknown
const STATUS_FRESH_MS = 3 * 60 * 1000;

export function parseStatus(raw: string): { online: boolean; ack: boolean } | null {
  try {
    const data = JSON.parse(raw);
    return typeof data.online === 'boolean' ? { online: data.online, ack: Boolean(data.ack) } : null;
  } catch {
    return null;
  }
}

export async function saveCabinetStatus(status: { online: boolean; ack: boolean }) {
  const { error } = await supabaseAdmin
    .from('cabinet_state')
    .update({ online: status.online, ack: status.ack, status_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) console.warn('⚠️ [CabinetState] Could not save status:', error.message);
}

export async function saveCabinetSlots(slots: CabinetSlotState[]) {
  const { error } = await supabaseAdmin
    .from('cabinet_state')
    .update({ slots, slots_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) console.warn('⚠️ [CabinetState] Could not save slots:', error.message);
}

export async function getCabinetState(): Promise<CabinetState> {
  const { data, error } = await supabaseAdmin
    .from('cabinet_state')
    .select('online, ack, status_at, slots, slots_at')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) {
    if (error) console.warn('⚠️ [CabinetState] Could not read state:', error.message);
    return { online: null, ack: false, status_at: null, slots: null, slots_at: null };
  }
  const fresh = data.status_at && Date.now() - new Date(data.status_at).getTime() < STATUS_FRESH_MS;
  return {
    online: fresh ? data.online : null,
    ack: Boolean(data.ack),
    status_at: data.status_at,
    slots: data.slots,
    slots_at: data.slots_at,
  };
}

/**
 * Claims the right to run the slot sync now (at most once per `everyMs` across
 * all server instances). Returns false if another instance synced recently.
 */
export async function claimSync(everyMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - everyMs).toISOString();
  const { data, error } = await supabaseAdmin
    .from('cabinet_state')
    .update({ synced_at: new Date().toISOString() })
    .eq('id', 1)
    .or(`synced_at.is.null,synced_at.lt.${cutoff}`)
    .select('id');
  if (error) {
    console.warn('⚠️ [CabinetState] Sync claim failed:', error.message);
    return false;
  }
  return Boolean(data && data.length > 0);
}
