'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, LogOut, ShieldCheck } from 'lucide-react';
import { Notice, Spinner, TabBar } from '@/components/ui';
import { useStation } from '@/lib/useStation';
import { clearStationCache } from '@/lib/stationCache';
import { formatStationDue } from '@/lib/time';

export default function ProfilePage() {
  const router = useRouter();
  const { me, user } = useStation();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const loan = me?.active_loan ?? null;
  const initials = (user?.username || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

  const signOut = async () => {
    setSigningOut(true);
    setSignOutFailed(false);
    // Only the server can clear the session cookie: on a shared phone, never pretend it did
    const res = await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      setSigningOut(false);
      setSignOutFailed(true);
      return;
    }
    clearStationCache();
    localStorage.removeItem('astrix_user');
    sessionStorage.clear();
    router.replace('/login');
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <main className="flex flex-1 flex-col gap-4 px-4 pb-6 pt-[calc(var(--safe-top)+24px)]">
        <section className="card enter flex items-center gap-4 p-5" aria-label="Your account">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-navy text-xl font-bold text-white" aria-hidden="true">{initials}</div>
          <div className="min-w-0">
            <h1 className="truncate text-[1.375rem] font-bold leading-tight tracking-[-0.015em]">{user?.username || ' '}</h1>
            <p className="num text-[0.9375rem] text-ink-2">{user?.index_no}</p>
          </div>
        </section>

        <section className="card enter enter-1 overflow-hidden" aria-label="Details">
          <dl className="divide-y divide-line/10">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <dt className="text-[0.9375rem] text-ink-2">Email</dt>
              <dd className="truncate text-right font-medium">{user?.email || '—'}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <dt className="text-[0.9375rem] text-ink-2">Umbrella</dt>
              <dd className="text-right font-medium">
                {!me ? <Spinner className="h-4 w-4 text-ink-3" /> : loan ? <>Umbrella <span className="num">{loan.slot}</span> · due {formatStationDue(loan.due_time)}</> : 'None on loan'}
              </dd>
            </div>
          </dl>
          {loan && (
            <Link href="/dashboard" className="flex items-center justify-between border-t border-line/10 px-5 py-4 font-semibold text-blue">
              Return umbrella <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </Link>
          )}
        </section>

        <section className="card enter enter-2 p-5" aria-labelledby="how-title">
          <h2 id="how-title" className="text-[1.0625rem] font-bold">How it works</h2>
          <ol className="mt-3 space-y-2.5 text-[0.9375rem] text-ink-2">
            <li className="flex gap-3"><span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky text-[0.8125rem] font-bold text-blue">1</span>At the umbrella station, tap Borrow. The app tells you which slot opens.</li>
            <li className="flex gap-3"><span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky text-[0.8125rem] font-bold text-blue">2</span>Take the umbrella within about 12 seconds.</li>
            <li className="flex gap-3"><span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky text-[0.8125rem] font-bold text-blue">3</span>Return it to the same slot within 24 hours: tap Return, then push it fully in.</li>
          </ol>
        </section>

        {me?.is_admin && (
          <Link href="/admin" className="card enter enter-2 flex items-center gap-3 p-5 font-semibold">
            <ShieldCheck className="h-5 w-5 text-blue" strokeWidth={2} aria-hidden="true" />
            <span className="flex-1">Staff · Admin panel</span>
            <ChevronRight className="h-5 w-5 text-ink-3" aria-hidden="true" />
          </Link>
        )}

        <div className="enter enter-3 mt-2">
          {signOutFailed && (
            <Notice tone="danger" title="You're still signed in" live="assertive" className="mb-3">
              We couldn&apos;t reach the server. Check your connection, then tap Sign out again.
            </Notice>
          )}
          <button type="button" onClick={signOut} disabled={signingOut} className="btn btn-lg w-full bg-card text-danger shadow-1">
            {signingOut ? <Spinner className="h-5 w-5" /> : <LogOut className="h-5 w-5" strokeWidth={2} aria-hidden="true" />} Sign out
          </button>
          {loan && <p className="mt-2 text-center text-[0.8125rem] text-ink-2">Signing out doesn&apos;t end your loan.</p>}
        </div>
      </main>
      <TabBar />
    </div>
  );
}
