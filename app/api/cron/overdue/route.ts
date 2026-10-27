import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { sendOverdueReminderEmail } from '@/lib/email';
import { OPEN_LOAN_STATUSES, BorrowRecord } from '@/lib/types';

// Emails each student once when their loan passes its due time.
// Called by Vercel Cron (vercel.json) and optionally an outside scheduler such
// as cron-job.org, both sending "Authorization: Bearer <CRON_SECRET>".

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('borrow_records')
    .select('*')
    .in('status', [...OPEN_LOAN_STATUSES])
    .is('reminder_sent_at', null)
    .lt('due_time', nowIso)
    .limit(50);

  if (error) {
    console.error('❌ [Cron/Overdue] Lookup error:', error.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }

  const loans = (data || []) as BorrowRecord[];
  let sent = 0;
  let failed = 0;

  for (const loan of loans) {
    // Claim the loan first so two runs at once never email the same student twice
    const { data: claimed } = await supabaseAdmin
      .from('borrow_records')
      .update({ reminder_sent_at: nowIso, status: 'OVERDUE' })
      .eq('record_id', loan.record_id)
      .is('reminder_sent_at', null)
      .in('status', [...OPEN_LOAN_STATUSES]) // never reopens a loan returned a moment ago
      .select('record_id');
    if (!claimed?.length) continue;

    const [{ data: user }, { data: umbrella }] = await Promise.all([
      supabaseAdmin.from('users').select('email, username').eq('index_no', loan.index_no).maybeSingle(),
      supabaseAdmin.from('umbrellas').select('slot').eq('umbrella_id', loan.umbrella_id).maybeSingle(),
    ]);

    const result = user?.email
      ? await sendOverdueReminderEmail(
          user.email,
          user.username || 'Student',
          umbrella?.slot ?? null,
          new Date(loan.borrowed_time),
          new Date(loan.due_time)
        )
      : { success: false, error: 'No email on file' };

    if (result.success) {
      sent++;
    } else {
      // Release the claim so the next run tries again
      failed++;
      console.warn(`⚠️ [Cron/Overdue] Reminder for ${loan.index_no} failed: ${result.error}`);
      await supabaseAdmin.from('borrow_records').update({ reminder_sent_at: null }).eq('record_id', loan.record_id);
    }
  }

  return NextResponse.json({ checked: loans.length, sent, failed });
}
