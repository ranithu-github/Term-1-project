'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LifeBuoy, RefreshCw, WifiOff } from 'lucide-react';
import { ActionDock, Notice, Spinner, TabBar } from '@/components/ui';
import { Cabinet, FoldedUmbrella, SlotBadge, type BayState } from '@/components/Cabinet';
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
        <div className="leading-tight">
          <p className="text-[0.8125rem] font-semibold tracking-[0.02em] text-ink-3">{greeting()}</p>
          <p className="text-[1.375rem] font-semibold tracking-[-0.02em]">{user ? user.username.split(' ')[0] : 'ASTRIX'}</p>
        </div>
        <a href="/profile" aria-label="Profile" className="glass flex h-11 w-11 items-center justify-center rounded-full text-[0.875rem] font-semibold">
          {initials(user?.username)}
        </a>
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

function greeting() {
  const h = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Colombo' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function initials(name?: string) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
}

function CabinetPill({ online, loading }: { online: boolean | null; loading: boolean }) {
  if (loading) return <span className="pill pill-quiet"><Spinner className="h-3.5 w-3.5" /> Checking</span>;
  // No recent report from the cabinet: say nothing rather than spin forever
  if (online === null) return <span />;
  return online ? (
    <span className="pill pill-quiet text-ink"><span className="h-[7px] w-[7px] rounded-full bg-success shadow-[0_0_0_3px_rgb(14_125_80/0.18)]" aria-hidden="true" />Cabinet online</span>
  ) : (
    <span className="pill pill-warn"><WifiOff className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />Offline</span>
  );
}

function HomeSkeleton() {
  return (
    <div className="card p-5" aria-busy="true" aria-label="Loading the station">
      <div className="h-4 w-28 rounded-full bg-ink/[0.07]" />
      <div className="mt-3 h-10 w-40 rounded-xl bg-ink/[0.07]" />
      <div className="mt-6 h-[188px] rounded-[26px] bg-ink/[0.05]" />
    </div>
  );
}

function AvailabilityCard({ me }: { me: MeResponse }) {
  const count = me.slots.filter((s) => s.availability).length;
  const bays = me.slots.map((s) => ({ slot: s.slot, state: (s.availability ? 'ready' : 'out') as BayState }));
  return (
    <section className="card enter p-5" aria-labelledby="avail-title">
      <div className="flex items-center justify-between">
        <CabinetPill online={me.cabinet_online} loading={false} />
        <span className="text-[0.8125rem] font-semibold text-ink-3">Umbrella station</span>
      </div>
      {count === 0 ? (
        <h1 id="avail-title" className="mt-5 text-[1.75rem] font-semibold leading-tight tracking-[-0.03em]">All umbrellas are out</h1>
      ) : (
        <h1 id="avail-title" className="mt-5 flex items-baseline gap-3">
          <span className="num text-[4.75rem] font-semibold leading-[0.9] tracking-[-0.05em]">{count}</span>
          <span className="text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-ink-2">
            of {me.slots.length} umbrellas<br />ready now
          </span>
        </h1>
      )}
      {count === 0 && <p className="mt-1 text-[0.9375rem] text-ink-2">Check again soon. This page updates by itself.</p>}
      <div className="mt-5"><Cabinet bays={bays} /></div>
      {count > 0 && <p className="mt-4 text-center text-[0.875rem] text-ink-2">Free for 24 hours · one umbrella at a time</p>}
    </section>
  );
}

function LoanCard({ loan }: { loan: NonNullable<MeResponse['active_loan']> }) {
  const left = formatTimeLeft(loan.due_time);
  const overdue = loan.is_overdue || left.overdue;
  const borrowed = new Date(loan.borrowed_time).getTime();
  const due = new Date(loan.due_time).getTime();
  const used = Math.min(1, Math.max(0, (Date.now() - borrowed) / Math.max(1, due - borrowed)));
  return (
    <>
      <section className="pass enter p-6" aria-labelledby="loan-title">
        <span className="halo -right-10 -top-12 h-56 w-56 bg-blue-2/55" aria-hidden="true" />
        <img src="/brand/umbrella-open.webp" alt="" aria-hidden="true" draggable={false} className="asset absolute -right-[72px] -top-9 w-[230px] rotate-12 drop-shadow-[0_18px_24px_rgb(0_0_0/0.35)]" />
        <div className="relative flex items-center gap-2 text-[0.8125rem] font-semibold tracking-[0.06em] text-white/75">
          {overdue ? <span className="rounded-full bg-[#FF9A52] px-2.5 py-0.5 tracking-normal text-ink">Overdue</span> : 'ON LOAN'}
        </div>
        <div className="relative mt-14 flex items-end justify-between gap-4">
          <div>
            <p className="text-[0.9375rem] text-white/75">Umbrella</p>
            <h1 id="loan-title" className="num text-[5.75rem] font-semibold leading-[0.85] tracking-[-0.06em]">
              <span className="sr-only">Umbrella </span>{loan.slot ?? '?'}<span className="sr-only"> is with you</span>
            </h1>
          </div>
          <div className="text-right">
            <p className="text-[0.9375rem] text-white/75">{overdue ? 'Overdue by' : 'Time left'}</p>
            <p className={`num text-[1.875rem] font-semibold tracking-[-0.03em] ${overdue ? 'text-[#FFB27A]' : ''}`}>{left.text}</p>
          </div>
        </div>
        <div className="relative mt-5 h-1.5 overflow-hidden rounded-full bg-white/[0.18]" aria-hidden="true">
          <div className={`h-full rounded-full ${overdue ? 'bg-[#FF9A52]' : 'bg-white'}`} style={{ width: `${Math.max(3, used * 100)}%` }} />
        </div>
        <p className="relative mt-3.5 text-[0.9375rem] text-white/85">
          Return by <b className="num font-semibold text-white">{formatStationDue(loan.due_time)}</b>
        </p>
      </section>
      <div className="card enter enter-1 flex items-center gap-3.5 px-5 py-4">
        <img src="/brand/glyph-pin.webp" alt="" aria-hidden="true" draggable={false} className="asset w-9 drop-shadow-[0_8px_10px_rgb(61_90_254/0.35)]" />
        <p className="text-[0.9375rem] text-ink">
          {overdue ? 'Please return it as soon as you can, to ' : 'Return it to '}<b className="num font-semibold">Slot {loan.slot ?? '?'}</b> at the umbrella station.
        </p>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- */
/* The working view: one screen per moment of a borrow/return        */

function WorkingView({ phase, me, headingRef }: { phase: Exclude<Phase, { kind: 'idle' }>; me: MeResponse; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const slot = 'slot' in phase ? phase.slot : null;
  const bays = (label: BayState) => me.slots.map((s) => ({ slot: s.slot, state: (s.slot === slot ? label : s.availability ? 'ready' : 'out') as BayState }));
  const isReturn = ('action' in phase && phase.action === 'return') || phase.kind === 'insert';
  const heading = (text: React.ReactNode) => (
    <h1 ref={headingRef} tabIndex={-1} className="text-center text-[2rem] font-semibold leading-[1.08] tracking-[-0.035em] outline-none">{text}</h1>
  );

  if (phase.kind === 'done') return <ResultView phase={phase} headingRef={headingRef} me={me} />;

  if (phase.kind === 'requesting' || slot === null) {
    return (
      <section className="enter flex flex-col items-center gap-6 pt-10 text-center" aria-live="polite">
        <HeroDial><FoldedUmbrella className="absolute left-1/2 top-4 h-[170px] -translate-x-1/2 opacity-80" /></HeroDial>
        {heading(phase.kind === 'requesting' && phase.action === 'return' ? 'Getting your slot ready…' : 'Finding an umbrella for you…')}
      </section>
    );
  }

  return (
    <section className="enter flex flex-col items-center gap-4 pt-1 text-center" aria-live="polite">
      <span className="pill pill-signal">
        <span className="h-[7px] w-[7px] rounded-full bg-blue shadow-[0_0_0_3px_rgb(61_90_254/0.2)]" aria-hidden="true" />
        {phase.kind === 'uncertain' ? `Slot ${slot}` : phase.kind === 'opening' ? `Opening Slot ${slot}` : phase.kind === 'checking' ? `Slot ${slot} · checking` : `Slot ${slot} is open`}
      </span>

      {phase.kind === 'opening' && heading(<>Opening Slot <span className="num">{slot}</span>…</>)}
      {phase.kind === 'take' && heading(<>Take Umbrella <span className="num">{slot}</span><br />now</>)}
      {phase.kind === 'insert' && heading(<>Push Umbrella <span className="num">{slot}</span> fully<br />into Slot <span className="num">{slot}</span></>)}
      {phase.kind === 'checking' && heading(isReturn ? 'Checking your umbrella…' : <>Checking whether you took Umbrella <span className="num">{slot}</span>…</>)}
      {phase.kind === 'uncertain' && heading('We haven’t heard back from the cabinet')}

      {phase.kind === 'take' ? (
        <TakeCountdown endsAt={phase.endsAt} slot={slot} />
      ) : phase.kind === 'insert' ? (
        <InsertGraphic slot={slot} />
      ) : (
        <HeroDial badge={slot} spinning={phase.kind !== 'uncertain'}>
          <FoldedUmbrella className="absolute left-1/2 top-4 h-[176px] -translate-x-1/2 rotate-[8deg] drop-shadow-[0_12px_14px_rgb(30_45_90/0.3)]" />
        </HeroDial>
      )}

      {(phase.kind === 'opening' || phase.kind === 'checking' || phase.kind === 'insert') && (
        <p className="flex items-center justify-center gap-2 text-[1rem] text-ink-2">
          <Spinner className="h-4 w-4 text-blue" />
          {phase.kind === 'opening' ? 'The lock is opening. Get ready.' : phase.kind === 'insert' ? 'The cabinet checks it automatically.' : 'This takes a few seconds.'}
        </p>
      )}
      {phase.kind === 'uncertain' && (
        <p className="text-[1rem] leading-relaxed text-ink-2">
          We&apos;re checking what happened{phase.action === 'borrow' ? '. If you took the umbrella, keep it.' : '.'} Please don&apos;t start another {phase.action} yet. This settles by itself within a minute or two.
        </p>
      )}

      {phase.kind !== 'insert' && (
        <div className="w-full"><Cabinet bays={bays(isReturn ? 'home' : 'target')} targetLabel={isReturn ? 'Return' : 'Open'} compact /></div>
      )}
      {phase.kind === 'take' && <p className="text-[0.9375rem] text-ink-2">The lock closes by itself. Not ready? Just leave it.</p>}
    </section>
  );
}

/** A frosted glass disc holding the umbrella, with an optional slot badge and a soft spinning ring */
function HeroDial({ children, badge, spinning = true, ring }: { children: React.ReactNode; badge?: number; spinning?: boolean; ring?: React.ReactNode }) {
  return (
    <div className="relative h-[240px] w-[240px]" aria-hidden="true">
      {ring ?? (
        <svg className={`absolute inset-0 ${spinning ? 'motion-safe:animate-[spin_2.4s_linear_infinite]' : ''}`} viewBox="0 0 240 240">
          <circle cx="120" cy="120" r="108" fill="none" stroke="rgb(255 255 255 / 0.75)" strokeWidth="12" />
          {spinning && <circle cx="120" cy="120" r="108" fill="none" stroke="url(#dial)" strokeWidth="12" strokeLinecap="round" strokeDasharray="170 509" />}
          <defs><linearGradient id="dial"><stop offset="0" stopColor="#7C9BFF" /><stop offset="1" stopColor="#3D5AFE" /></linearGradient></defs>
        </svg>
      )}
      <div className="glass absolute inset-[22px] overflow-hidden rounded-full">
        <span className="halo -bottom-2.5 left-1/2 h-20 w-36 -translate-x-1/2 bg-blue/35" />
        {children}
      </div>
      {badge !== undefined && <SlotBadge slot={badge} className="absolute right-1.5 top-3.5" />}
    </div>
  );
}

/** Return: the folded umbrella lowering into a glowing glass slot */
function InsertGraphic({ slot }: { slot: number }) {
  return (
    <div className="relative h-[310px] w-[230px]" aria-hidden="true">
      <span className="halo bottom-0 left-1/2 h-24 w-52 -translate-x-1/2 bg-blue/30" />
      <div className="absolute inset-x-[35px] bottom-0 h-[190px] rounded-[34px] bg-gradient-to-b from-white/55 to-white/25 p-2.5 shadow-[inset_0_1px_0_#fff,inset_0_0_0_1px_rgb(255_255_255/0.45),0_18px_40px_-14px_rgb(30_45_90/0.22)]">
        <div className="relative h-full rounded-[26px] bg-gradient-to-b from-blue/20 to-blue-2/10 shadow-[inset_0_0_0_2px_rgb(var(--blue)),0_0_30px_-6px_rgb(61_90_254/0.6)]">
          <span className="num absolute inset-x-0 bottom-2.5 text-[0.8125rem] font-semibold text-blue">Slot {slot}</span>
        </div>
      </div>
      <FoldedUmbrella className="absolute left-1/2 top-0 h-[240px] -translate-x-1/2 drop-shadow-[0_14px_16px_rgb(30_45_90/0.3)] motion-safe:animate-[lower_1.6s_var(--ease-in-out)_infinite_alternate]" />
      <svg className="absolute right-2 top-16 h-[70px] w-[26px] text-blue" viewBox="0 0 26 70" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M13 4v58M5 54l8 8 8-8" /></svg>
    </div>
  );
}

/** Seconds left to take the umbrella: the ring drains from the deadline */
function TakeCountdown({ endsAt, slot }: { endsAt: number; slot: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const msLeft = Math.max(0, endsAt - now);
  const secs = Math.ceil(msLeft / 1000);
  const low = secs <= 5;
  const C = 2 * Math.PI * 108;
  return (
    <>
      <HeroDial
        badge={slot}
        ring={
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 240 240">
            <circle cx="120" cy="120" r="108" fill="none" stroke="rgb(255 255 255 / 0.75)" strokeWidth="12" />
            <circle
              cx="120" cy="120" r="108" fill="none" stroke={low ? '#E8672A' : 'url(#take)'} strokeWidth="12" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - msLeft / 12000)}
              className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300 motion-safe:ease-linear"
            />
            <defs><linearGradient id="take"><stop offset="0" stopColor="#7C9BFF" /><stop offset="1" stopColor="#3D5AFE" /></linearGradient></defs>
          </svg>
        }
      >
        <FoldedUmbrella className="absolute left-1/2 top-4 h-[176px] -translate-x-1/2 rotate-[8deg] drop-shadow-[0_12px_14px_rgb(30_45_90/0.3)]" />
      </HeroDial>
      <p className={`flex items-baseline justify-center gap-1.5 ${low ? 'text-caution' : ''}`}>
        <span className="num text-[2.75rem] font-semibold leading-none tracking-[-0.04em]" aria-hidden="true">{secs}</span>
        <span className={`text-[1rem] font-semibold ${low ? '' : 'text-ink-2'}`} aria-hidden="true">seconds left to take it</span>
        <span className="sr-only">You have about 12 seconds to take the umbrella.</span>
      </p>
    </>
  );
}

/** What happened → what to do. Success is calm and green; failures say how to recover. */
function ResultView({ phase, headingRef, me }: { phase: Extract<Phase, { kind: 'done' }>; headingRef: React.RefObject<HTMLHeadingElement | null>; me: MeResponse }) {
  const r = phase.result;
  const slot = r.slot ?? phase.slot ?? me.active_loan?.slot ?? null;
  const s = slot ?? '?';
  const view = describe(phase.action, r, s);
  const warn = view.status?.tone === 'warn' || view.urgent;

  return (
    <section className="enter flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center" role={view.urgent ? 'alert' : 'status'}>
      {view.status && (
        <span className={`pill ${warn ? 'pill-quiet text-caution' : 'pill-quiet'}`}>
          <span className={`h-[7px] w-[7px] rounded-full ${warn ? 'bg-caution' : 'bg-ink/30'}`} aria-hidden="true" />
          {view.status.text}
        </span>
      )}
      <img
        src={r.success ? '/brand/glyph-check.webp' : '/brand/glyph-alert.webp'}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={`asset mt-2 motion-safe:animate-[pop_400ms_var(--ease-out)_both] ${r.success ? 'w-[140px] drop-shadow-[0_18px_26px_rgb(14_143_91/0.35)]' : 'w-[110px] drop-shadow-[0_18px_26px_rgb(180_64_15/0.35)]'}`}
      />
      <h1 ref={headingRef} tabIndex={-1} className="mt-3 text-[2rem] font-semibold leading-[1.08] tracking-[-0.035em] outline-none">{view.title}</h1>
      <p className="max-w-[300px] text-[1.0625rem] leading-relaxed text-ink-2">{view.body}</p>
      {view.help && <div className="mt-2 w-full text-left"><HelpNote slot={slot} me={me} /></div>}
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
    <button type="button" onClick={() => setOpen(true)} className="btn btn-plain mx-auto flex px-3">
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
    <div role="status" className="glass flex min-h-[58px] items-center justify-center gap-2.5 rounded-full px-4 text-[1.0625rem] font-semibold text-ink">
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
        <div className="card mb-1 px-5 py-4 text-left">
          <p className="font-semibold">Are you at the umbrella station?</p>
          <p className="mt-1 text-[0.9375rem] text-ink-2">A slot opens for about 12 seconds, so tap when you&apos;re standing at the cabinet.</p>
        </div>
        <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onConfirm}>I&apos;m at the station · Open a slot</button>
        <button type="button" className="btn btn-plain w-full" onClick={p.onCancel}>Cancel</button>
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-lg w-full" onClick={p.onBorrow}>
      Borrow an umbrella
    </button>
  );
}

