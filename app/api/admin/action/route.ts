import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getAdminIndex, isAdminIndex } from '@/lib/admin';
import { cabinetErrorMessage, cabinetErrorStatus, runCabinetCommand } from '@/lib/mqtt';
import { logActivity, resolveAlerts } from '@/lib/events';
import { sendResetCode } from '@/lib/password-reset';
import { OPEN_LOAN_STATUSES } from '@/lib/types';

export const maxDuration = 30;

type Body = {
  action?: string;
  slot?: number;
  record_id?: string;
  index_no?: string;
  hours?: number;
  id?: number;
};

const ok = (message: string, extra: Record<string, unknown> = {}) => NextResponse.json({ success: true, message, ...extra });
const fail = (message: string, status = 400) => NextResponse.json({ success: false, message }, { status });

/**
 * Every admin action. Each one is recorded in the activity log as "admin:<index>".
 */
export async function POST(request: Request) {
  const adminIndex = await getAdminIndex();
  if (!adminIndex) return fail('Admin access only.', 403);

  const actor = `admin:${adminIndex}`;
  const body: Body = await request.json().catch(() => ({}));
  const action = body.action || '';
  const slot = Number(body.slot);
  const validSlot = Number.isInteger(slot) && slot >= 1 && slot <= 4;
  const indexNo = (body.index_no || '').trim().toUpperCase();

  const log = (type: string, message: string, extra: { slot?: number; index_no?: string; details?: Record<string, unknown> } = {}) =>
    logActivity(type, message, { actor, ...extra });

  try {
    switch (action) {
      // ---------------- Slots ----------------
      case 'slot.open':
      case 'slot.close': {
        if (!validSlot) return fail('Choose a slot from 1 to 4.');
        const command = action === 'slot.open' ? 'OPEN' : 'CLOSE';
        const result = await runCabinetCommand(command, slot, 12000);
        await log(`ADMIN_LOCK_${command}`, `Admin ${adminIndex} sent ${command} to Slot ${slot}: ${result.ok ? result.response.status : result.error}`, { slot });
        if (!result.ok) return fail(cabinetErrorMessage(result.error, command), cabinetErrorStatus(result.error));
        return ok(result.response.message || `Slot ${slot}: ${command} sent.`);
      }

      case 'slot.release': {
        if (!validSlot) return fail('Choose a slot from 1 to 4.');
        const { data: held } = await supabaseAdmin.from('umbrellas').select('pending_op, pending_action, borrowed_user, availability').eq('slot', slot).maybeSingle();
        if (held?.pending_action === 'BORROW' && held.pending_op) {
          await supabaseAdmin.rpc('release_borrow', { p_op: held.pending_op });
        } else if (held?.pending_action === 'RETURN' && held.pending_op) {
          await supabaseAdmin.rpc('abort_return', { p_op: held.pending_op });
        } else if (held?.availability && held.borrowed_user) {
          await supabaseAdmin.from('umbrellas').update({ borrowed_user: null }).eq('slot', slot).eq('availability', true).is('pending_op', null);
        } else {
          return fail(`Slot ${slot} isn't held.`);
        }
        await resolveAlerts('CABINET_NO_RESPONSE', `slot:${slot}`, actor);
        await log('ADMIN_SLOT_RELEASE', `Admin ${adminIndex} released the hold on Slot ${slot}`, { slot });
        return ok(`Slot ${slot} released.`);
      }

      case 'slot.markAvailable':
      case 'slot.markOut': {
        if (!validSlot) return fail('Choose a slot from 1 to 4.');
        const available = action === 'slot.markAvailable';
        // Not while a borrow/return is in progress on it: release that first
        const { data: changed } = await supabaseAdmin
          .from('umbrellas')
          .update(available ? { availability: true, borrowed_user: null } : { availability: false })
          .eq('slot', slot)
          .is('pending_op', null)
          .select('slot');
        if (!changed?.length) return fail(`Slot ${slot} has a borrow or return in progress. Release it first.`, 409);
        if (available) await resolveAlerts('UMBRELLA_MISSING', `slot:${slot}`, actor);
        await log(available ? 'ADMIN_SLOT_AVAILABLE' : 'ADMIN_SLOT_OUT', `Admin ${adminIndex} marked Slot ${slot} as ${available ? 'available' : 'out'}`, { slot });
        return ok(`Slot ${slot} marked ${available ? 'available' : 'out'}.`);
      }

      // ---------------- Loans ----------------
      case 'loan.close': {
        // Guarded: only an open loan, and its slot is freed only if it's still out for this loan
        const { data: closed, error } = await supabaseAdmin.rpc('admin_close_loan', { p_record: body.record_id });
        if (error) return fail('Could not close the loan.', 500);
        const loan = closed?.[0];
        if (!loan) return fail('That loan is not open (already returned or not found).', 404);
        await resolveAlerts('LOAN_OVERDUE', loan.record_id, actor);
        await resolveAlerts('LOAN_VERY_OVERDUE', loan.record_id, actor);
        await log('ADMIN_LOAN_CLOSE', `Admin ${adminIndex} closed ${loan.index_no}'s loan (marked returned)`, {
          index_no: loan.index_no, details: { record_id: loan.record_id },
        });
        return ok(`Loan closed for ${loan.index_no}.`);
      }

      case 'loan.extend': {
        const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 14);
        const { data: loan } = await supabaseAdmin.from('borrow_records').select('*').eq('record_id', body.record_id).in('status', [...OPEN_LOAN_STATUSES]).maybeSingle();
        if (!loan) return fail('Only an open loan can be extended.', 404);
        const base = Math.max(new Date(loan.due_time).getTime(), Date.now());
        const newDue = new Date(base + hours * 60 * 60 * 1000).toISOString();
        await supabaseAdmin.from('borrow_records').update({ due_time: newDue, status: 'ACTIVE', reminder_sent_at: null })
          .eq('record_id', loan.record_id).in('status', [...OPEN_LOAN_STATUSES]);
        await resolveAlerts('LOAN_OVERDUE', loan.record_id, actor);
        await resolveAlerts('LOAN_VERY_OVERDUE', loan.record_id, actor);
        await log('ADMIN_LOAN_EXTEND', `Admin ${adminIndex} extended ${loan.index_no}'s loan by ${hours} h`, {
          index_no: loan.index_no, details: { record_id: loan.record_id, due_time: newDue },
        });
        return ok(`Loan extended by ${hours} hours.`);
      }

      case 'loan.delete': {
        const { data: loan } = await supabaseAdmin.from('borrow_records').select('*').eq('record_id', body.record_id).maybeSingle();
        if (!loan) return fail('Loan not found.', 404);
        if (OPEN_LOAN_STATUSES.includes(loan.status)) return fail('This loan is still open. Close it first.', 409);
        await supabaseAdmin.from('borrow_records').delete().eq('record_id', loan.record_id).eq('status', 'RETURNED');
        await log('ADMIN_LOAN_DELETE', `Admin ${adminIndex} deleted a loan record of ${loan.index_no} (${loan.status})`, {
          index_no: loan.index_no, details: { record_id: loan.record_id, umbrella_id: loan.umbrella_id, status: loan.status },
        });
        return ok('Loan record deleted.');
      }

      // ---------------- Users ----------------
      case 'user.lock':
      case 'user.unlock': {
        if (!indexNo) return fail('Choose a user.');
        const lock = action === 'user.lock';
        if (lock && (indexNo === adminIndex || isAdminIndex(indexNo))) return fail("Admin accounts can't be locked.");
        const { error } = await supabaseAdmin.from('users').update({ is_locked: lock }).eq('index_no', indexNo);
        if (error) {
          return fail(/is_locked/.test(error.message) ? 'Run the admin SQL script first (it adds the lock column).' : 'Could not update the user.', 500);
        }
        await log(lock ? 'ADMIN_USER_LOCK' : 'ADMIN_USER_UNLOCK', `Admin ${adminIndex} ${lock ? 'locked' : 'unlocked'} ${indexNo}`, { index_no: indexNo });
        return ok(`${indexNo} ${lock ? 'locked' : 'unlocked'}.`);
      }

      case 'user.resetPassword': {
        if (!indexNo) return fail('Choose a user.');
        const result = await sendResetCode(indexNo);
        if (!result.ok) return fail(result.message, result.status);
        await log('ADMIN_USER_RESET', `Admin ${adminIndex} sent a password reset code to ${indexNo}`, { index_no: indexNo });
        return ok(`Reset code sent to ${result.maskedEmail}.`);
      }

      case 'user.delete': {
        if (!indexNo) return fail('Choose a user.');
        if (indexNo === adminIndex || isAdminIndex(indexNo)) return fail("Admin accounts can't be deleted here.");
        const { data: openLoans } = await supabaseAdmin
          .from('borrow_records')
          .select('record_id')
          .eq('index_no', indexNo)
          .in('status', [...OPEN_LOAN_STATUSES]);
        if (openLoans?.length) return fail(`${indexNo} still has an umbrella. Close the loan first.`);
        // Keep the loan history: an account with past loans is locked instead of deleted
        const { count: pastLoans } = await supabaseAdmin.from('borrow_records').select('record_id', { count: 'exact', head: true }).eq('index_no', indexNo);
        if (pastLoans) return fail(`${indexNo} has loan history, so the account can't be deleted. Lock it instead.`, 409);
        const { data: busy } = await supabaseAdmin.from('umbrellas').select('slot').eq('borrowed_user', indexNo).limit(1);
        if (busy?.length) return fail(`${indexNo} has a borrow in progress. Release Slot ${busy[0].slot} first.`, 409);
        const { error } = await supabaseAdmin.from('users').delete().eq('index_no', indexNo);
        if (error) return fail('Could not delete the user.', 500);
        await log('ADMIN_USER_DELETE', `Admin ${adminIndex} deleted the account ${indexNo}`, { index_no: indexNo });
        return ok(`${indexNo} deleted.`);
      }

      // ---------------- Alerts ----------------
      case 'alert.handle': {
        await supabaseAdmin
          .from('admin_events')
          .update({ handled_at: new Date().toISOString(), handled_by: actor })
          .eq('id', body.id)
          .eq('kind', 'ALERT');
        return ok('Alert marked handled.');
      }

      case 'alert.handleAll': {
        await supabaseAdmin
          .from('admin_events')
          .update({ handled_at: new Date().toISOString(), handled_by: actor })
          .eq('kind', 'ALERT')
          .is('handled_at', null);
        await log('ADMIN_ALERTS_CLEARED', `Admin ${adminIndex} marked all alerts handled`);
        return ok('All alerts marked handled.');
      }

      default:
        return fail('Unknown action.');
    }
  } catch (error: any) {
    console.error('❌ [API/Admin/Action] Error:', error);
    return fail('The action failed. Please try again.', 500);
  }
}
