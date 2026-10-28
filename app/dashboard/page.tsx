'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Clock, LifeBuoy, RefreshCw, Umbrella, WifiOff } from 'lucide-react';
import { ActionDock, Mark, Notice, Spinner, TabBar } from '@/components/ui';
import { Cabinet, SlotNumeral, type BayState } from '@/components/Cabinet';
import { DevConsole } from '@/components/DevConsole';
import { useStation } from '@/lib/useStation';
import { useCabinetAction, type CabinetKind, type CabinetResult, type Phase } from '@/lib/useCabinetAction';
import { formatStationDue, formatTimeLeft } from '@/lib/time';
import type { MeResponse } from '@/lib/types';

// Arriving from the QR sticker on the cabinet (/dashboard?at=station) counts as
// being at the station for a while, so Borrow skips the "are you there?" step.
const AT_STATION_KEY = 'astrix_at_station';
const AT_STATION_MS = 10 * 60 * 1000;

export default function DashboardPage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const params = useSearchParams();
  const [settling, setSettling] = useState(false);
  const { me, user, refresh } = useStation({ fast: settling });
  const action = useCabinetAction(useCallback(() => { void refresh(); }, [refresh]));
  const { phase, setPhase } = action;
  const resumed = useRef(false);   // a pending operation is picked up once, on first load
  const staleMe = useRef<MeResponse | null>(null); // the data we had when an outcome became uncertain
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (params.get('at') === 'station') sessionStorage.setItem(AT_STATION_KEY, String(Date.now()));
  }, [params]);

  // The page was (re)loaded while a borrow/return of this student is still settling
  useEffect(() => {
    if (!me || resumed.current) return;
    resumed.current = true;
    if (phase.kind === 'idle' && me.pending) {
      staleMe.current = me;
      setPhase({ kind: 'uncertain', action: me.pending.action === 'RETURN' ? 'return' : 'borrow', slot: me.pending.slot });
    }
  }, [me, phase.kind, setPhase]);

  // Entering "uncertain": remember the data we had, so we only decide from a fresh answer
  const uncertain = phase.kind === 'uncertain';
  useEffect(() => {
    setSettling(uncertain);
    if (uncertain && !staleMe.current) staleMe.current = me;
    if (!uncertain) staleMe.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uncertain]);

  // Resolve an uncertain outcome once the server has settled it (no pending operation left)
  useEffect(() => {
    if (phase.kind !== 'uncertain' || !me || me === staleMe.current || me.pending) return;
    const loan = me.active_loan;
    const slot = phase.slot ?? undefined;
    if (phase.action === 'borrow') {
      setPhase({ kind: 'done', action: 'borrow', slot: phase.slot, result: loan ? { success: true, slot: loan.slot ?? slot, due_time: loan.due_time } : { success: false, reason: 'NOT_TAKEN', slot } });
    } else {
      setPhase({ kind: 'done', action: 'return', slot: phase.slot, result: loan ? { success: false, reason: 'NO_UMBRELLA', slot } : { success: true, slot } });
    }
  }, [me, phase, setPhase]);

  // Move focus to the new state's heading so screen readers hear it once
  useEffect(() => {
    if (phase.kind !== 'idle') headingRef.current?.focus();
  }, [phase.kind]);

  if (me?.is_dev) return <DevConsole me={me} refresh={refresh} />;

  const loan = me?.active_loan ?? null;
  const slots = me?.slots ?? [];
  const available = slots.filter((s) => s.availability);
  const offline = me?.cabinet_online === false;

  const startBorrow = () => {
    const at = Number(sessionStorage.getItem(AT_STATION_KEY) || 0);
    if (Date.now() - at < AT_STATION_MS) {
      void action.run('borrow');
    } else {
      setConfirming(true);
    }
  };
  const run = (kind: CabinetKind) => {
    setConfirming(false);
    void action.run(kind, loan?.slot ?? undefined);
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="flex items-center justify-between px-5 pb-2 pt-[calc(var(--safe-top)+16px)]">
        <div className="flex items-center gap-2.5">
          <Mark className="h-9 w-9" />
          <div className="leading-tight">
            <p className="text-[1.0625rem] font-bold tracking-[-0.01em]">ASTRIX</p>
            <p className="text-[0.8125rem] text-ink-2">{user ? `Hi, ${user.username.split(' ')[0]}` : 'Campus umbrellas'}</p>
          </div>
        </div>
        <CabinetPill online={me?.cabinet_online ?? null} loading={!me} />
      </header>

      <main className="flex flex-1 flex-col gap-4 px-4 pb-6 pt-2">
        {!me ? (
          <HomeSkeleton />
        ) : phase.kind === 'idle' ? (
          loan ? <LoanCard loan={loan} /> : <AvailabilityCard me={me} />
        ) : (
          <WorkingView phase={phase} me={me} headingRef={headingRef} />
        )}

        {phase.kind === 'idle' && offline && (
          <Notice tone="caution" title="The cabinet is offline">
            {loan ? 'Your loan is still active. Try returning when the cabinet is back online.' : 'We can’t open a slot right now. This page updates by itself.'}
          </Notice>
        )}
      </main>

      <ActionDock aboveTabBar>
        <DockActions
          phase={phase}
          loan={loan}
          offline={offline}
          noneFree={!!me && available.length === 0}
          ready={!!me}
          confirming={confirming}
          onBorrow={startBorrow}
          onConfirm={() => run('borrow')}
          onCancel={() => setConfirming(false)}
          onReturn={() => run('return')}
          onDone={() => { action.reset(); void refresh(); }}
          onRetry={(kind) => run(kind)}
          onCheck={() => void refresh()}
        />
      </ActionDock>
      <TabBar />
    </div>
  );
}

/* ---------------------------------------------------------------- */

function CabinetPill({ online, loading }: { online: boolean | null; loading: boolean }) {
  if (loading || online === null) return <span className="pill pill-quiet"><Spinner className="h-3.5 w-3.5" /> Checking</span>;
  return online ? (
    <span className="pill pill-ok"><span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />Cabinet online</span>
  ) : (
    <span className="pill pill-warn"><WifiOff className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />Offline</span>
  );
}

function HomeSkeleton() {
  return (
    <div className="card p-5" aria-busy="true" aria-label="Loading the station">
      <div className="h-4 w-28 rounded-full bg-ink/[0.07]" />
      <div className="mt-3 h-10 w-40 rounded-xl bg-ink/[0.07]" />
      <div className="mt-6 h-[104px] rounded-[20px] bg-ink/[0.05]" />
    </div>
  );
}

function AvailabilityCard({ me }: { me: MeResponse }) {
  const count = me.slots.filter((s) => s.availability).length;
  const bays = me.slots.map((s) => ({ slot: s.slot, state: (s.availability ? 'ready' : 'out') as BayState }));
  return (
    <section className="card enter p-5" aria-labelledby="avail-title">
      <p className="text-sm font-semibold text-ink-2">Umbrella station</p>
      <h1 id="avail-title" className="mt-1 text-[2rem] font-bold leading-tight tracking-[-0.025em]">
        {count === 0 ? 'All umbrellas are out' : <><span className="num">{count}</span> {count === 1 ? 'umbrella' : 'umbrellas'} ready</>}
      </h1>
      <p className="mt-1 text-[0.9375rem] text-ink-2">
        {count === 0 ? 'Check again soon. This page updates by itself.' : 'Return within 24 hours · One umbrella at a time'}
      </p>
      <div className="mt-5"><Cabinet bays={bays} /></div>
    </section>
  );
}

function LoanCard({ loan }: { loan: NonNullable<MeResponse['active_loan']> }) {
  const left = formatTimeLeft(loan.due_time);
  const overdue = loan.is_overdue || left.overdue;
  return (
    <section className="card enter p-5" aria-labelledby="loan-title">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-2">Your umbrella</p>
        {overdue ? <span className="pill pill-warn">Overdue</span> : <span className="pill pill-ok">On loan</span>}
      </div>
      <h1 id="loan-title" className="mt-2 text-[2rem] font-bold leading-tight tracking-[-0.025em]">
        Umbrella <span className="num">{loan.slot ?? '?'}</span> is with you
      </h1>
      <p className="mt-1 text-[1.0625rem] font-semibold text-blue">Return it to Slot <span className="num">{loan.slot ?? '?'}</span></p>

      <dl className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-md bg-paper p-3.5">
          <dt className="text-[0.8125rem] font-medium text-ink-2">Due back</dt>
          <dd className="num mt-0.5 font-semibold">
            {formatStationDue(loan.due_time).split(', ').map((part, k) => <span key={k} className="block">{part}</span>)}
          </dd>
        </div>
        <div className={`rounded-md p-3.5 ${overdue ? 'bg-caution-bg' : 'bg-paper'}`}>
          <dt className={`text-[0.8125rem] font-medium ${overdue ? 'text-caution' : 'text-ink-2'}`}>{overdue ? 'Overdue by' : 'Time left'}</dt>
          <dd className="num mt-0.5 flex items-center gap-1.5 font-semibold"><Clock className="h-4 w-4 text-ink-2" strokeWidth={2.25} aria-hidden="true" />{left.text}</dd>
        </div>
      </dl>
      {overdue && <p className="mt-3 text-[0.9375rem] text-caution">Please return it to Slot {loan.slot ?? '?'} as soon as you can.</p>}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* The working view: one screen per moment of a borrow/return        */

function WorkingView({ phase, me, headingRef }: { phase: Exclude<Phase, { kind: 'idle' }>; me: MeResponse; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const slot = 'slot' in phase ? phase.slot : null;
  const bays = (label: BayState) => me.slots.map((s) => ({ slot: s.slot, state: (s.slot === slot ? label : s.availability ? 'ready' : 'out') as BayState }));
  const isReturn = ('action' in phase && phase.action === 'return') || phase.kind === 'insert';
  const heading = (text: React.ReactNode) => (
    <h1 ref={headingRef} tabIndex={-1} className="text-center text-[1.5rem] font-bold leading-tight tracking-[-0.02em] outline-none">{text}</h1>
  );

  if (phase.kind === 'done') return <ResultView phase={phase} headingRef={headingRef} me={me} />;

  return (
    <section className="card enter flex flex-col gap-5 p-5" aria-live="polite">
      {phase.kind === 'requesting' && (
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <Spinner className="h-8 w-8 text-blue" />
          {heading(phase.action === 'borrow' ? 'Finding an umbrella for you…' : 'Getting your slot ready…')}
        </div>
      )}

      {slot !== null && phase.kind !== 'requesting' && (
        <>
          <SlotNumeral slot={slot} />
          {phase.kind === 'opening' && heading(<>Opening Slot <span className="num">{slot}</span>…</>)}
          {phase.kind === 'take' && heading(<>Take Umbrella <span className="num">{slot}</span> from Slot <span className="num">{slot}</span></>)}
          {phase.kind === 'insert' && heading(<>Push Umbrella <span className="num">{slot}</span> fully into Slot <span className="num">{slot}</span></>)}
          {phase.kind === 'checking' && heading(isReturn ? 'Checking your umbrella…' : <>Checking whether you took Umbrella <span className="num">{slot}</span>…</>)}
          {phase.kind === 'uncertain' && heading('We haven’t heard back from the cabinet')}

          {phase.kind === 'take' && <TakeCountdown endsAt={phase.endsAt} />}
          {(phase.kind === 'opening' || phase.kind === 'checking' || phase.kind === 'insert') && (
            <div className="flex items-center justify-center gap-2 text-ink-2">
              <Spinner className="h-4 w-4" />
              <span className="text-[0.9375rem]">
                {phase.kind === 'opening' ? 'The lock is opening. Get ready.' : phase.kind === 'insert' ? 'The cabinet checks it automatically.' : 'This takes a few seconds.'}
              </span>
            </div>
          )}
          {phase.kind === 'uncertain' && (
            <p className="text-center text-[0.9375rem] leading-relaxed text-ink-2">
              We&apos;re checking what happened{phase.action === 'borrow' ? '. If you took the umbrella, keep it.' : '.'} Please don&apos;t start another {phase.action} yet. This settles by itself within a minute or two.
            </p>
          )}

          <Cabinet bays={bays(isReturn ? 'home' : 'target')} targetLabel={isReturn ? 'Return' : 'Open'} compact />
        </>
      )}
    </section>
  );
}

/** Seconds left to take the umbrella: a number plus a draining bar, computed from the deadline */
function TakeCountdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const msLeft = Math.max(0, endsAt - now);
  const secs = Math.ceil(msLeft / 1000);
  const low = secs <= 5;
  return (
    <div>
      <p className={`num text-center text-[1.0625rem] font-semibold ${low ? 'text-caution' : 'text-ink-2'}`}>
        <span aria-hidden="true">{secs} seconds left</span>
        <span className="sr-only">You have about 12 seconds to take the umbrella.</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
        <div
          className={`h-full origin-left rounded-full ${low ? 'bg-caution' : 'bg-blue'} motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-linear`}
          style={{ transform: `scaleX(${msLeft / 12000})` }}
        />
      </div>
    </div>
  );
}

/** What happened → what to do. Success is quiet and green; failures say how to recover. */
function ResultView({ phase, headingRef, me }: { phase: Extract<Phase, { kind: 'done' }>; headingRef: React.RefObject<HTMLHeadingElement | null>; me: MeResponse }) {
  const r = phase.result;
  const slot = r.slot ?? phase.slot ?? me.active_loan?.slot ?? null;
  const s = slot ?? '?';
  const view = describe(phase.action, r, s);

  if (r.success) {
    return (
      <section className="card flex flex-col items-center gap-3 p-6 text-center" role="status">
        <CheckCircle2 className="h-14 w-14 text-success motion-safe:animate-[enter_300ms_var(--ease-out)_both]" strokeWidth={1.75} aria-hidden="true" />
        <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] font-bold leading-tight tracking-[-0.02em] outline-none">{view.title}</h1>
        <p className="text-[1.0625rem] leading-relaxed text-ink-2">{view.body}</p>
      </section>
    );
  }
  return (
    <section className="card flex flex-col gap-4 p-5" role={view.urgent ? 'alert' : 'status'}>
      {slot !== null && <SlotNumeral slot={slot} />}
      <div>
        {view.status && <span className={`pill mb-3 ${view.status.tone === 'warn' ? 'pill-warn' : 'pill-quiet'}`}>{view.status.text}</span>}
        <h1 ref={headingRef} tabIndex={-1} className="text-[1.5rem] font-bold leading-tight tracking-[-0.02em] outline-none">{view.title}</h1>
        <p className="mt-2 text-[1.0625rem] leading-relaxed text-ink-2">{view.body}</p>
      </div>
      {view.help && <HelpNote slot={slot} me={me} />}
    </section>
  );
}

function describe(action: CabinetKind, r: CabinetResult, s: number | string): { title: string; body: string; urgent?: boolean; help?: boolean; status?: { tone: 'warn' | 'quiet'; text: string } } {
  if (r.success) {
    return action === 'borrow'
      ? { title: `Umbrella ${s} borrowed`, body: r.due_time ? `Return it to Slot ${s} by ${formatStationDue(r.due_time)}.` : `Return it to Slot ${s} within 24 hours.` }
      : { title: `Umbrella ${s} returned`, body: `Your loan has ended${r.duration && !/^0 /.test(r.duration) ? ` after ${r.duration}` : ''}. Thank you!` };
  }
  switch (r.reason) {
    case 'NOT_TAKEN':
      return { title: 'The take window ended', body: `Umbrella ${s} wasn’t taken. Try again when you’re ready.`, status: { tone: 'quiet', text: 'No loan recorded' } };
    case 'NO_UMBRELLA':
      return { title: `We couldn’t detect Umbrella ${s}`, body: `Check it’s pushed fully into Slot ${s}, then try again.`, help: true, status: { tone: 'warn', text: 'Loan still open' } };
    case 'WRONG_UMBRELLA':
      return { title: `That isn’t Umbrella ${s}`, body: `Take that umbrella out of Slot ${s}, then try returning Umbrella ${s}.`, urgent: true, help: true, status: { tone: 'warn', text: `Slot ${s} is still unlocked` } };
  }
  if (r.message === 'NETWORK') return { title: 'We lost the connection', body: 'Check your internet, then try again. If the cabinet opened, your loan will appear here.' };
  return { title: action === 'borrow' ? 'Couldn’t borrow right now' : 'Couldn’t return right now', body: r.message || 'Please try again in a moment.', help: true };
}

function HelpNote({ slot, me }: { slot: number | null; me: MeResponse }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <Notice tone="info" title="Ask the station team for help" live="off">
      Show them this: <span className="num font-semibold text-ink">{me.user.index_no}</span>
      {slot !== null && <> · Slot <span className="num font-semibold text-ink">{slot}</span></>} ·{' '}
      <span className="num">{new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Colombo' })}</span>.
      Don&apos;t leave an umbrella beside the cabinet.
    </Notice>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="btn btn-plain self-start px-2">
      <LifeBuoy className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" /> Get help
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* The dock: always exactly one primary action for the current state */

function DockActions(p: {
  phase: Phase; loan: MeResponse['active_loan']; offline: boolean; noneFree: boolean; ready: boolean; confirming: boolean;
  onBorrow: () => void; onConfirm: () => void; onCancel: () => void; onReturn: () => void; onDone: () => void;
  onRetry: (kind: CabinetKind) => void; onCheck: () => void;
}) {
  const { phase } = p;
  // While the cabinet works, the dock shows what's happening rather than a dead button
  const working = (label: string) => (
    <div role="status" className="flex min-h-[56px] items-center justify-center gap-2.5 rounded-[18px] bg-sky px-4 text-[1.0625rem] font-semibold text-navy">
      <Spinner className="h-5 w-5 text-blue" /> {label}
    </div>
  );

  if (phase.kind === 'done') {
    const r = phase.result;
    const retry = !r.success && (r.reason === 'NOT_TAKEN' || r.reason === 'NO_UMBRELLA' || r.reason === 'WRONG_UMBRELLA' || r.message === 'NETWORK');
    return retry ? (
      <>
        <button type="button" className="btn btn-primary btn-lg w-full" onClick={() => p.onRetry(phase.action)}>
          <RefreshCw className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" /> {phase.action === 'borrow' ? 'Borrow again' : 'Try return again'}
        </button>
        <button type="button" className="btn btn-plain w-full" onClick={p.onDone}>Not now</button>
      </>
    ) : (
      <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onDone}>Done</button>
    );
  }
  if (phase.kind === 'uncertain') {
    return (
      <button type="button" className="btn btn-secondary btn-lg w-full" onClick={p.onCheck}>
        <RefreshCw className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" /> Check status
      </button>
    );
  }
  if (phase.kind === 'requesting') return working(phase.action === 'borrow' ? 'Finding a slot…' : 'Starting return…');
  if (phase.kind === 'opening') return working(`Opening Slot ${phase.slot}…`);
  if (phase.kind === 'take') return working('Take it now');
  if (phase.kind === 'insert') return working('Waiting for your umbrella…');
  if (phase.kind === 'checking') return working('Checking…');

  if (!p.ready) return working('Loading…');
  if (p.offline) {
    return <button type="button" className="btn btn-primary btn-lg w-full" disabled>Cabinet offline</button>;
  }
  if (p.loan) {
    return (
      <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onReturn}>
        <span className="num">Return umbrella {p.loan.slot ?? ''}</span>
      </button>
    );
  }
  if (p.noneFree) return <button type="button" className="btn btn-primary btn-lg w-full" disabled>No umbrellas available</button>;
  if (p.confirming) {
    return (
      <div className="enter flex flex-col gap-2">
        <p className="px-2 pt-1 text-center text-[0.9375rem] text-ink-2">A slot opens for about 12 seconds. Make sure you&apos;re at the umbrella station.</p>
        <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onConfirm}>I&apos;m at the station · Open a slot</button>
        <button type="button" className="btn btn-plain w-full" onClick={p.onCancel}>Cancel</button>
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onBorrow}>
      <Umbrella className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" /> Borrow an umbrella
    </button>
  );
}

