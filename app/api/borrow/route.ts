import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cabinetErrorMessage, runCabinetCommand, cabinetErrorStatus, getCachedCabinetOnline } from '@/lib/mqtt';
import { sendBorrowReceiptEmail } from '@/lib/email';
import { getSessionIndex } from '@/lib/session';
import { isDevIndex } from '@/lib/dev';
import { findOpenLoan } from '@/lib/loans';
import { countRecentActivity, logActivity, raiseAlert } from '@/lib/events';

// The cabinet takes up to ~20 s to report the result, so allow the route to wait
export const maxDuration = 60;

const BORROW_IN_PROGRESS_MESSAGE =
  'You already have a borrow in progress. Please wait for it to finish (or contact the station team if a slot opened for you).';

/**
 * Borrow: claim a free slot, tell the phone which slot it got, send BORROW to the
 * cabinet, wait for its response, and only then record the loan.
 * Nothing is written from the browser.
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

    // No attempt limit on borrows for now: a student must be able to retry at the
    // cabinet, and the one-open-loan rule already stops anyone taking more than one
    const body = await request.json().catch(() => ({}));
    const isDev = isDevIndex(indexNo);

    // ------------------------------------------------------------------
    // Developer accounts: actuate any slot directly, no loan is recorded
    // ------------------------------------------------------------------
    if (isDev) {
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

    // ------------------------------------------------------------------
    // Students: one open loan at a time
    // ------------------------------------------------------------------
    const openLoan = await findOpenLoan(indexNo);
    if (openLoan) {
      return NextResponse.json(
        { success: false, message: 'You already have an umbrella. Please return it before borrowing another.' },
        { status: 400 }
      );
    }

    // A borrow of theirs is already in progress (or held after the cabinet never
    // answered): don't let a second request open another slot at the same time
    const { data: heldByMe, error: heldError } = await supabaseAdmin
      .from('umbrellas')
      .select('slot')
      .eq('availability', true)
      .eq('borrowed_user', indexNo)
      .limit(1);

    if (heldError) {
      console.error('❌ [API/Borrow] Held-slot lookup error:', heldError.message);
      return NextResponse.json({ success: false, message: 'Could not check the station. Please try again.' }, { status: 500 });
    }

    if (heldByMe && heldByMe.length > 0) {
      return NextResponse.json(
        { success: false, message: BORROW_IN_PROGRESS_MESSAGE },
        { status: 409 }
      );
    }

    // Known to be offline: say so straight away, without reserving a slot
    if (getCachedCabinetOnline() === false) {
      return NextResponse.json(
        { success: false, message: cabinetErrorMessage('OFFLINE', 'BORROW') },
        { status: 503 }
      );
    }

    // Claim the first free slot with one conditional update, so two students
    // borrowing at the same moment can never be sent to the same slot.
    // Slots an admin is holding are skipped (filtered here rather than in the
    // query, so borrowing still works before the admin_hold column exists).
    const { data: freeRows, error: freeError } = await supabaseAdmin
      .from('umbrellas')
      .select('*')
      .eq('availability', true)
      .is('borrowed_user', null)
      .order('slot', { ascending: true });
    const freeSlots = (freeRows || []).filter((s) => s.admin_hold !== true);

    if (freeError) {
      console.error('❌ [API/Borrow] Slot lookup error:', freeError.message);
      return NextResponse.json({ success: false, message: 'Could not check the station. Please try again.' }, { status: 500 });
    }

    let claimed: { slot: number; umbrella_id: string } | null = null;
    for (const { slot } of freeSlots) {
      const { data: rows, error: claimError } = await supabaseAdmin
        .from('umbrellas')
        .update({ borrowed_user: indexNo })
        .eq('slot', slot)
        .eq('availability', true)
        .is('borrowed_user', null)
        .select('slot, umbrella_id');

      // 23505 = unique violation from one_held_slot_per_student: another request
      // from this student claimed a slot a moment ago (two taps / two tabs)
      if (claimError?.code === '23505') {
        return NextResponse.json(
          { success: false, message: BORROW_IN_PROGRESS_MESSAGE },
          { status: 409 }
        );
      }
      if (claimError) {
        console.error('❌ [API/Borrow] Slot claim error:', claimError.message);
        continue;
      }
      if (rows && rows.length > 0) {
        claimed = rows[0];
        break;
      }
    }

    // Belt and braces (also covers a database without the unique index): if this
    // student now holds more than one slot, another request won the race. Give
    // this slot back and stop, so only one slot ever opens.
    if (claimed) {
      const { data: myHolds } = await supabaseAdmin
        .from('umbrellas')
        .select('slot')
        .eq('availability', true)
        .eq('borrowed_user', indexNo)
        .order('slot', { ascending: true });

      if (myHolds && myHolds.length > 1 && myHolds[0].slot !== claimed.slot) {
        await supabaseAdmin
          .from('umbrellas')
          .update({ borrowed_user: null })
          .eq('slot', claimed.slot)
          .eq('availability', true)
          .eq('borrowed_user', indexNo);
        return NextResponse.json(
          { success: false, message: BORROW_IN_PROGRESS_MESSAGE },
          { status: 409 }
        );
      }
    }

    if (!claimed) {
      return NextResponse.json(
        { success: false, message: 'All umbrellas are currently in use. Please check back soon.' },
        { status: 409 }
      );
    }

    // Stream two lines of JSON (NDJSON) on the same response:
    //   1. {"type":"assigned",...} straight away, so the phone shows the right slot
    //      while the lock is still opening (two students borrowing at once get
    //      different slots and each must know which one is theirs)
    //   2. {"type":"result",...} once the cabinet has answered
    const slot = claimed;
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

        send({
          type: 'assigned',
          slot: slot.slot,
          umbrella_number: slot.slot, // each umbrella lives in its own numbered slot
          umbrella_id: slot.umbrella_id,
        });

        let outcome: Record<string, unknown>;
        try {
          outcome = await completeBorrow(indexNo, slot);
        } catch (error) {
          console.error('❌ [API/Borrow] Error:', error);
          outcome = { success: false, message: 'Borrow request failed. Please try again.', slot: slot.slot };
        }
        send({ type: 'result', ...outcome });

        try {
          controller.close();
        } catch {}
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
 * Returns the final result body for the phone.
 */
async function completeBorrow(
  indexNo: string,
  claimed: { slot: number; umbrella_id: string }
): Promise<Record<string, unknown>> {
  const releaseClaim = () =>
    supabaseAdmin
      .from('umbrellas')
      .update({ borrowed_user: null })
      .eq('slot', claimed.slot)
      .eq('availability', true)
      .eq('borrowed_user', indexNo);

  const result = await runCabinetCommand('BORROW', claimed.slot);

  if (!result.ok) {
    if (result.error === 'TIMEOUT') {
      // The command reached the broker, so the cabinet may still open this slot later.
      // Keep the slot held (not offered to anyone) until staff check it, instead of
      // freeing it and risking an umbrella leaving with no loan.
      console.error(
        `❌ [API/Borrow] No station response for slot ${claimed.slot} (student ${indexNo}). Slot kept held — check the station and clear umbrellas.borrowed_user by hand.`
      );
      await raiseAlert('CABINET_NO_RESPONSE', 'warning', `The station confirmed ${indexNo}'s borrow from Slot ${claimed.slot} but never sent the result. The slot is held until someone checks it.`, {
        slot: claimed.slot, index_no: indexNo, actor: 'cabinet', dedupeKey: `slot:${claimed.slot}`,
      });
    } else {
      await releaseClaim();
    }
    await logActivity('BORROW_FAILED', `${indexNo}'s borrow from Slot ${claimed.slot} failed: ${result.error}`, {
      slot: claimed.slot, index_no: indexNo, actor: indexNo,
    });
    return { success: false, message: cabinetErrorMessage(result.error, 'BORROW'), slot: claimed.slot };
  }

  // Case 2: the umbrella was not taken — free the slot again
  if (result.response.status !== 'SUCCESS') {
    await releaseClaim();
    await logActivity('BORROW_NOT_TAKEN', `${indexNo} did not take Umbrella ${claimed.slot} from Slot ${claimed.slot}`, {
      slot: claimed.slot, index_no: indexNo, actor: indexNo,
    });
    if ((await countRecentActivity('BORROW_NOT_TAKEN', indexNo, 60 * 60 * 1000)) >= 3) {
      await raiseAlert('REPEATED_NOT_TAKEN', 'warning', `${indexNo} has opened a slot 3 or more times in the last hour without taking the umbrella.`, {
        index_no: indexNo, actor: indexNo, dedupeKey: `idx:${indexNo}`,
      });
    }
    return {
      success: false,
      message: result.response.message,
      reason: result.response.reason,
      slot: claimed.slot,
    };
  }

  // Case 1: umbrella taken — record the loan
  const now = new Date();
  const dueTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h window

  const { error: insertError } = await supabaseAdmin.from('borrow_records').insert({
    umbrella_id: claimed.umbrella_id,
    index_no: indexNo,
    status: 'ACTIVE',
    borrowed_time: now.toISOString(),
    due_time: dueTime.toISOString(),
  });

  // The umbrella has physically left either way, so the slot is out
  await supabaseAdmin
    .from('umbrellas')
    .update({ availability: false, borrowed_user: indexNo })
    .eq('slot', claimed.slot);

  if (insertError) {
    console.error('❌ [API/Borrow] Loan insert error:', insertError.message);
    await raiseAlert('LOAN_NOT_RECORDED', 'critical', `${indexNo} took Umbrella ${claimed.slot} but the loan could not be saved: ${insertError.message}`, {
      slot: claimed.slot, index_no: indexNo, actor: 'system',
    });
  }

  await logActivity('BORROW', `${indexNo} borrowed Umbrella ${claimed.slot} from Slot ${claimed.slot}`, {
    slot: claimed.slot, index_no: indexNo, actor: indexNo,
  });

  // Borrow receipt email
  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('email, username')
      .eq('index_no', indexNo)
      .maybeSingle();
    if (user?.email) {
      await sendBorrowReceiptEmail(user.email, user.username || 'Student', claimed.slot, claimed.umbrella_id, now, dueTime);
    }
  } catch (e) {
    console.warn('⚠️ [API/Borrow] Receipt email warning:', e);
  }

  return {
    success: true,
    message: result.response.message,
    slot: claimed.slot,
    umbrella_id: claimed.umbrella_id,
    due_time: dueTime.toISOString(),
  };
}
