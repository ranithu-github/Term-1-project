import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cabinetErrorMessage, runCabinetCommand, cabinetErrorStatus, outcomeUncertain } from '@/lib/mqtt';
import { getCabinetState } from '@/lib/cabinet-state';
import { sendReturnReceiptEmail } from '@/lib/email';
import { getSessionIndex } from '@/lib/session';
import { isDevIndex } from '@/lib/dev';
import { formatLoanDuration } from '@/lib/loans';
import { logActivity, raiseAlert } from '@/lib/events';

// The cabinet takes up to ~20 s to report the result, so allow the route to wait
export const maxDuration = 60;

/**
 * Return: open the home slot of the student's umbrella, send RETURN to the
 * cabinet, wait for its response, and only then close the loan. The database
 * changes go through guarded functions (begin_return, complete_return,
 * abort_return), so a return can't run twice or close half a loan.
 */
export async function POST(request: Request) {
  try {
    const indexNo = await getSessionIndex();
    if (!indexNo) {
      return NextResponse.json({ success: false, message: 'Please sign in to return an umbrella.' }, { status: 401 });
    }

    // No attempt limit on returns: a student at the cabinet must always be able to
    // retry, and a return only ever opens the slot that belongs to their own umbrella
    const body = await request.json().catch(() => ({}));

    // ------------------------------------------------------------------
    // Developer accounts: test RETURN on any slot, no loan is touched
    // ------------------------------------------------------------------
    if (isDevIndex(indexNo)) {
      const slot = Number(body?.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
        return NextResponse.json({ success: false, message: 'Choose a slot from 1 to 4.' }, { status: 400 });
      }

      const result = await runCabinetCommand('RETURN', slot);
      await logActivity('DEV_RETURN', `Developer ${indexNo} tested RETURN on Slot ${slot}: ${result.ok ? result.response.reason || result.response.status : result.error}`, {
        slot, index_no: indexNo, actor: indexNo,
      });
      if (!result.ok) {
        return NextResponse.json(
          { success: false, message: cabinetErrorMessage(result.error, 'RETURN'), slot },
          { status: cabinetErrorStatus(result.error) }
        );
      }
      return NextResponse.json({
        success: result.response.status === 'SUCCESS',
        message: result.response.message,
        reason: result.response.reason,
        slot,
        dev: true,
      });
    }

    // Known to be offline: say so straight away
    if ((await getCabinetState()).online === false) {
      return NextResponse.json({ success: false, message: cabinetErrorMessage('OFFLINE', 'RETURN') }, { status: 503 });
    }

    // ------------------------------------------------------------------
    // Students: the slot comes from the loan, never from the request
    // ------------------------------------------------------------------
    const { data: started, error: startError } = await supabaseAdmin.rpc('begin_return', { p_index: indexNo });
    const begin = started?.[0] as { status: string; slot: number | null; umbrella_id: string | null; op: string | null; borrowed_time: string | null } | undefined;
    if (startError || !begin) {
      console.error('❌ [API/Return] begin_return error:', startError?.message);
      return NextResponse.json({ success: false, message: 'Could not check the station. Please try again.' }, { status: 500 });
    }

    if (begin.status === 'NO_LOAN') {
      return NextResponse.json({ success: false, message: 'No active umbrella loan found for your account.' }, { status: 400 });
    }
    if (begin.status === 'IN_PROGRESS') {
      return NextResponse.json({ success: false, message: 'Your return is already in progress. Please wait for it to finish.', slot: begin.slot }, { status: 409 });
    }
    if (begin.status !== 'OK' || !begin.slot || !begin.op) {
      console.error(`❌ [API/Return] Can't start return for ${indexNo}: ${begin.status}`);
      await raiseAlert('RETURN_BLOCKED', 'warning', `${indexNo} couldn't start a return (${begin.status}) for umbrella ${begin.umbrella_id}.`, {
        slot: begin.slot, index_no: indexNo, actor: 'system', dedupeKey: `idx:${indexNo}`,
      });
      return NextResponse.json(
        { success: false, message: 'Your umbrella\u2019s slot isn\u2019t ready for a return. Please contact the station team.', slot: begin.slot },
        { status: 409 }
      );
    }
    const slot = begin.slot;
    const op = begin.op;

    const result = await runCabinetCommand('RETURN', slot, 45000, op.slice(0, 8));

    if (!result.ok) {
      if (outcomeUncertain(result)) {
        // The slot may have opened. Keep the return pending: the slot sync closes the loan
        // if the umbrella is back, or clears the pending return if the slot is still empty.
        await raiseAlert('CABINET_NO_RESPONSE', 'warning', `No result from the cabinet for ${indexNo}'s return to Slot ${slot} (${result.error}). It settles from the cabinet's slot report.`, {
          slot, index_no: indexNo, actor: 'cabinet', dedupeKey: `slot:${slot}`,
        });
      } else {
        await supabaseAdmin.rpc('abort_return', { p_op: op });
      }
      await logActivity('RETURN_FAILED', `${indexNo}'s return to Slot ${slot} failed: ${result.error}`, {
        slot, index_no: indexNo, actor: indexNo,
      });
      return NextResponse.json(
        { success: false, uncertain: outcomeUncertain(result), message: cabinetErrorMessage(result.error, 'RETURN'), slot },
        { status: cabinetErrorStatus(result.error) }
      );
    }

    // Case 4 / Case 5: loan stays open
    if (result.response.status !== 'SUCCESS') {
      await supabaseAdmin.rpc('abort_return', { p_op: op });
      if (result.response.reason === 'WRONG_UMBRELLA') {
        await raiseAlert('WRONG_UMBRELLA_RETURNED', 'critical', `${indexNo} put the wrong umbrella in Slot ${slot}. The slot was left unlocked.`, {
          slot, index_no: indexNo, actor: indexNo,
        });
      }
      await logActivity('RETURN_FAILED', `${indexNo}'s return to Slot ${slot}: ${result.response.reason}`, {
        slot, index_no: indexNo, actor: indexNo,
      });
      return NextResponse.json({ success: false, message: result.response.message, reason: result.response.reason, slot });
    }

    // Case 3: right umbrella is back — close the loan and free the slot, in one transaction
    const { data: closedRows, error: closeError } = await supabaseAdmin.rpc('complete_return', { p_op: op });
    const closed = closedRows?.[0] as { umbrella_id: string; borrowed_time: string } | undefined;
    if (closeError || !closed) {
      console.error('❌ [API/Return] complete_return failed:', closeError?.message || 'operation not found');
      await raiseAlert('RETURN_NOT_RECORDED', 'critical', `${indexNo}'s umbrella is back in Slot ${slot} but the loan could not be closed: ${closeError?.message || 'the return was no longer pending'}`, {
        slot, index_no: indexNo, actor: 'system',
      });
      return NextResponse.json(
        { success: false, message: 'Your umbrella is back, but the loan could not be closed yet. It will be fixed automatically; contact the station team if it still shows tomorrow.', slot },
        { status: 500 }
      );
    }

    const durationStr = formatLoanDuration(closed.borrowed_time);
    await logActivity('RETURN', `${indexNo} returned Umbrella ${slot} to Slot ${slot} (${durationStr})`, {
      slot, index_no: indexNo, actor: indexNo,
    });

    // Return receipt email, after the response
    after(async () => {
      try {
        const { data: user } = await supabaseAdmin.from('users').select('email, username').eq('index_no', indexNo).maybeSingle();
        if (user?.email) await sendReturnReceiptEmail(user.email, user.username || 'Student', slot, closed.umbrella_id, durationStr);
      } catch (e) {
        console.warn('⚠️ [API/Return] Receipt email warning:', e);
      }
    });

    return NextResponse.json({
      success: true,
      message: result.response.message,
      slot,
      umbrella_id: closed.umbrella_id,
      duration: durationStr,
    });
  } catch (error: any) {
    console.error('❌ [API/Return] Error:', error);
    await raiseAlert('SERVER_ERROR', 'critical', `Return failed with a server error: ${error?.message || error}`, {
      actor: 'system', dedupeKey: 'route:return',
    });
    return NextResponse.json({ success: false, message: 'Return request failed. Please try again.' }, { status: 500 });
  }
}
