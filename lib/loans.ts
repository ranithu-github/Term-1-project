import { supabaseAdmin } from './supabase';
import { OPEN_LOAN_STATUSES, BorrowRecord } from './types';

/**
 * Whether an open loan is past its due time. Worked out from due_time rather
 * than written on read, so a read can never race a return and reopen a loan.
 */
export function isOverdue(loan: Pick<BorrowRecord, 'status' | 'due_time'>): boolean {
  return loan.status === 'OVERDUE' || (loan.status === 'ACTIVE' && Boolean(loan.due_time) && new Date(loan.due_time).getTime() < Date.now());
}

/**
 * The student's open loan (ACTIVE or OVERDUE), newest first. Read-only.
 */
export async function findOpenLoan(indexNo: string): Promise<BorrowRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('borrow_records')
    .select('*')
    .eq('index_no', indexNo)
    .in('status', [...OPEN_LOAN_STATUSES])
    .order('borrowed_time', { ascending: false })
    .limit(1);

  if (error) {
    console.error('❌ [Loans] Lookup error:', error.message);
    throw new Error('LOAN_LOOKUP_FAILED');
  }

  return (data?.[0] as BorrowRecord | undefined) || null;
}

/**
 * Human-readable loan duration for receipts, e.g. "42 minutes" or "3h 5m"
 */
export function formatLoanDuration(borrowedTime: string | null | undefined): string {
  const start = borrowedTime ? new Date(borrowedTime).getTime() : Date.now();
  const diffMins = Math.floor(Math.max(0, Date.now() - start) / 60000);
  return diffMins < 60 ? `${diffMins} minutes` : `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
}
