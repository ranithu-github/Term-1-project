import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cabinetErrorMessage, runCabinetCommand, cabinetErrorStatus, outcomeUncertain } from '@/lib/mqtt';
import { getCabinetState } from '@/lib/cabinet-state';
import { sendBorrowReceiptEmail } from '@/lib/email';
import { getSessionIndex } from '@/lib/session';
import { isDevIndex } from '@/lib/dev';
import { countRecentActivity, logActivity, raiseAlert } from '@/lib/events';

// The cabinet takes up to ~20 s to report the result, so allow the route to wait
export const maxDuration = 60;

const BORROW_IN_PROGRESS_MESSAGE =
  'You already have a borrow in progress. Please wait for it to finish (it settles by itself within a minute or two).';

/**
 * Borrow: claim a free slot, tell the phone which slot it got, send BORROW to the
 * cabinet, wait for its response, and only then record the loan.
 * Every database change goes through a guarded function (begin_borrow,
 * complete_borrow, release_borrow), so double taps, two tabs and a slow
 * request can never open two slots or record half a loan.
 *
 * Students get a streamed NDJSON response (see below). Errors before a slot is
 * assigned, and developer-console borrows, are plain JSON.
 */
export async function POST(request: Request) {
  try {
    const indexNo = await getSessionIndex();
    if (!indexNo) {
      return NextResponse.json({ success: false, message: 'Please sign in to borrow an umbrella.' }, { status: 401 });
    }

    // No attempt limit on borrows: a student must be able to retry at the cabinet,
    // and begin_borrow already stops anyone taking more than one umbrella
    const body = await request.json().catch(() => ({}));

    // ------------------------------------------------------------------
    // Developer accounts: actuate any slot directly, no loan is recorded
    // ------------------------------------------------------------------
    if (isDevIndex(indexNo)) {
      const slot = Number(body?.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
        return NextResponse.json({ success: false, message: 'Choose a slot from 1 to 4.' }, { status: 400 });
      }

      const result = await runCabinetCommand('BORROW', slot);
      await logActivity('DEV_BORROW', `Developer ${indexNo} tested BORROW on Slot ${slot}: ${result.ok ? result.response.status : result.error}`, {
        slot, index_no: indexNo, actor: indexNo,
      });
      if (!result.ok) {
        return NextResponse.json(
          { success: false, message: cabinetErrorMessage(result.error, 'BORROW'), slot },
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

    // Known to be offline: say so straight away, without reserving a slot
    if ((await getCabinetState()).online === false) {
      return NextResponse.json({ success: false, message: cabinetErrorMessage('OFFLINE', 'BORROW') }, { status: 503 });
    }

    // ------------------------------------------------------------------
    // Students: claim a slot (one decision at a time per student)
    // ------------------------------------------------------------------
    const { data: claim, error: claimError } = await supabaseAdmin.rpc('begin_borrow', { p_index: indexNo });
    if (claimError || !claim?.[0]) {
      console.error('❌ [API/Borrow] begin_borrow error:', claimError?.message);
      return NextResponse.json({ success: false, message: 'Could not check the station. Please try again.' }, { status: 500 });
    }
    const { status, slot, umbrella_id, op } = claim[0] as { status: string; slot: number; umbrella_id: string; op: string };

    if (status === 'HAS_LOAN') {
      return NextResponse.json({ success: false, message: 'You already have an umbrella. Please return it before borrowing another.' }, { status: 400 });
    }
    if (status === 'IN_PROGRESS') {
      return NextResponse.json({ success: false, message: BORROW_IN_PROGRESS_MESSAGE }, { status: 409 });
    }
    if (status !== 'OK') {
      return NextResponse.json({ success: false, message: 'All umbrellas are currently in use. Please check back soon.' }, { status: 409 });
    }

    // The receipt email is sent after the response has finished, never while the student waits
    let receipt: (() => Promise<void>) | null = null;
    let streamDone: () => void = () => {};
    const finished = new Promise<void>((resolve) => (streamDone = resolve));
    after(async () => {
      await finished;
      if (receipt) await receipt().catch((e) => console.warn('⚠️ [API/Borrow] Receipt email warning:', e));
    });

    // Stream two lines of JSON (NDJSON) on the same response:
    //   1. {"type":"assigned",...} straight away, so the phone shows the right slot
    //      while the lock is still opening (two students borrowing at once get
    //      different slots and each must know which one is theirs)
    //   2. {"type":"result",...} once the cabinet has answered
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          } catch {
            // The phone disconnected; keep going so the loan is still recorded correctly
          }
        };

        send({ type: 'assigned', slot, umbrella_number: slot, umbrella_id });

        let outcome: Record<string, unknown>;
        try {
          const done = await completeBorrow(indexNo, { slot, umbrella_id, op });
          outcome = done.body;
          receipt = done.receipt;
        } catch (error) {
          console.error('❌ [API/Borrow] Error:', error);
          outcome = { success: false, message: 'Borrow request failed. Please try again.', slot };
        }
        send({ type: 'result', ...outcome });

        try {
          controller.close();
        } catch {}
        streamDone();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    console.error('❌ [API/Borrow] Error:', error);
    await raiseAlert('SERVER_ERROR', 'critical', `Borrow failed with a server error: ${error?.message || error}`, {
      actor: 'system', dedupeKey: 'route:borrow',
    });
    return NextResponse.json({ success: false, message: 'Borrow request failed. Please try again.' }, { status: 500 });
  }
}

/**
 * Sends BORROW for the claimed slot, waits for the cabinet, and records the result.
 * Returns the final result body for the phone, and the receipt email to send afterwards.
 */
async function completeBorrow(
  indexNo: string,
  claimed: { slot: number; umbrella_id: string; op: string }
): Promise<{ body: Record<string, unknown>; receipt: (() => Promise<void>) | null }> {
  const release = () => supabaseAdmin.rpc('release_borrow', { p_op: claimed.op });

  const result = await runCabinetCommand('BORROW', claimed.slot, 45000, claimed.op.slice(0, 8));

  if (!result.ok) {
    if (outcomeUncertain(result)) {
      // The cabinet may have opened the slot. Keep it held: the slot sync records the
      // loan if the umbrella is gone, or releases the hold if it is still there.
      await raiseAlert('CABINET_NO_RESPONSE', 'warning', `No result from the cabinet for ${indexNo}'s borrow from Slot ${claimed.slot} (${result.error}). The slot is held until the cabinet's slot report settles it.`, {
        slot: claimed.slot, index_no: indexNo, actor: 'cabinet', dedupeKey: `slot:${claimed.slot}`,
      });
    } else {
      await release();
    }
    await logActivity('BORROW_FAILED', `${indexNo}'s borrow from Slot ${claimed.slot} failed: ${result.error}`, {
      slot: claimed.slot, index_no: indexNo, actor: indexNo,
    });
    return {
      body: { success: false, uncertain: outcomeUncertain(result), message: cabinetErrorMessage(result.error, 'BORROW'), slot: claimed.slot },
      receipt: null,
    };
  }

  // Case 2: the umbrella was not taken — free the slot again
  if (result.response.status !== 'SUCCESS') {
    await release();
    await logActivity('BORROW_NOT_TAKEN', `${indexNo} did not take Umbrella ${claimed.slot} from Slot ${claimed.slot}`, {
      slot: claimed.slot, index_no: indexNo, actor: indexNo,
    });
    if ((await countRecentActivity('BORROW_NOT_TAKEN', indexNo, 60 * 60 * 1000)) >= 3) {
      await raiseAlert('REPEATED_NOT_TAKEN', 'warning', `${indexNo} has opened a slot 3 or more times in the last hour without taking the umbrella.`, {
        index_no: indexNo, actor: indexNo, dedupeKey: `idx:${indexNo}`,
      });
    }
    return {
      body: { success: false, message: result.response.message, reason: result.response.reason, slot: claimed.slot },
      receipt: null,
    };
  }

  // Case 1: umbrella taken — record the loan and mark the slot out, in one transaction
  const { data: loanRows, error: loanError } = await supabaseAdmin.rpc('complete_borrow', { p_op: claimed.op });
  const loan = loanRows?.[0] as { borrowed_time: string; due_time: string } | undefined;

  if (loanError || !loan) {
    console.error('❌ [API/Borrow] complete_borrow failed:', loanError?.message || 'operation not found');
    await raiseAlert('LOAN_NOT_RECORDED', 'critical', `${indexNo} took Umbrella ${claimed.slot} but the loan could not be saved: ${loanError?.message || 'the slot was no longer held'}`, {
      slot: claimed.slot, index_no: indexNo, actor: 'system',
    });
    return {
      body: { success: false, message: 'You took the umbrella, but the loan could not be saved. Please keep it and contact the station team.', slot: claimed.slot },
      receipt: null,
    };
  }

  await logActivity('BORROW', `${indexNo} borrowed Umbrella ${claimed.slot} from Slot ${claimed.slot}`, {
    slot: claimed.slot, index_no: indexNo, actor: indexNo,
  });

  const receipt = async () => {
    const { data: user } = await supabaseAdmin.from('users').select('email, username').eq('index_no', indexNo).maybeSingle();
    if (user?.email) {
      await sendBorrowReceiptEmail(user.email, user.username || 'Student', claimed.slot, claimed.umbrella_id, new Date(loan.borrowed_time), new Date(loan.due_time));
    }
  };

  return {
    body: { success: true, message: result.response.message, slot: claimed.slot, umbrella_id: claimed.umbrella_id, due_time: loan.due_time },
    receipt,
  };
}
