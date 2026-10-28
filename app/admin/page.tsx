'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ShieldAlert,
  Bell,
  BellRing,
  Umbrella,
  Lock,
  Unlock,
  RefreshCw,
  Wifi,
  WifiOff,
  ArrowLeft,
  Search,
} from 'lucide-react';
import { formatStationDateTime } from '@/lib/time';

// =====================================================================
// Admin panel. Only admin accounts (ADMIN_INDEXES) can load the data.
// While this page is open it refreshes every 5 s; each refresh also runs
// the server checks that raise alerts, so alerts appear here live.
// =====================================================================

const REFRESH_MS = 5000;

type Tab = 'overview' | 'alerts' | 'slots' | 'loans' | 'users' | 'activity';

interface AdminEvent {
  id: number;
  created_at: string;
  kind: 'ALERT' | 'ACTIVITY';
  severity: 'info' | 'warning' | 'critical';
  type: string;
  message: string;
  slot: number | null;
  index_no: string | null;
  actor: string | null;
  handled_at: string | null;
  handled_by: string | null;
}

interface CabinetSlot {
  slot: number;
  busy: boolean;
  docked: boolean;
  umbrella: number | null;
  locked?: boolean;
  unlocked_s?: number;
}

interface Overview {
  admin: string;
  cabinet: { online: boolean | null; report_at: number | null; slots: CabinetSlot[] };
  slots: { slot: number; umbrella_id: string; availability: boolean; borrowed_user: string | null; held: boolean; admin_hold: boolean }[];
  open_loans: { record_id: string; umbrella_id: string; index_no: string; borrowed_time: string; due_time: string; status: string }[];
  counts: { users: number; open_loans: number; overdue_loans: number; open_alerts: number };
  alerts: AdminEvent[];
  activity: AdminEvent[];
  events_table_missing: boolean;
}

interface Loan {
  record_id: string;
  umbrella_id: string;
  index_no: string;
  borrowed_time: string;
  due_time: string;
  returned_time: string | null;
  status: string;
}

interface AdminUser {
  index_no: string;
  username: string;
  email: string;
  is_verified: boolean;
  is_locked: boolean;
  is_admin: boolean;
  created_at: string | null;
  open_loan: { umbrella_id: string; status: string } | null;
}

const timeAgo = (iso: string | number | null) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const severityStyle: Record<AdminEvent['severity'], string> = {
  critical: 'border-l-rose-500 bg-rose-50',
  warning: 'border-l-amber-500 bg-amber-50',
  info: 'border-l-sky-400 bg-sky-50',
};

// Short beep for new alerts (no audio file needed)
function beep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {}
}

export default function AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [denied, setDenied] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);

  const [loans, setLoans] = useState<Loan[]>([]);
  const [loanFilter, setLoanFilter] = useState<'open' | 'returned' | 'all'>('open');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [showHandled, setShowHandled] = useState(false);

  const seenAlertIds = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (typeof Notification !== 'undefined') setNotifyOn(Notification.permission === 'granted');
  }, []);

  // New alerts while the panel is open: sound, browser notification, toast
  const announceNewAlerts = useCallback((alerts: AdminEvent[]) => {
    if (seenAlertIds.current === null) {
      seenAlertIds.current = new Set(alerts.map((a) => a.id));
      return;
    }
    const fresh = alerts.filter((a) => !seenAlertIds.current!.has(a.id));
    fresh.forEach((a) => seenAlertIds.current!.add(a.id));
    if (fresh.length === 0) return;

    beep();
    setToast({ ok: false, text: `🚨 ${fresh[0].message}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}` });
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      fresh.slice(0, 3).forEach((a) => new Notification(`ASTRIX alert: ${a.type.replace(/_/g, ' ').toLowerCase()}`, { body: a.message }));
    }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/overview', { cache: 'no-store' });
      if (res.status === 403 || res.status === 401) {
        setDenied(true);
        return;
      }
      const json = await res.json();
      if (json.success) {
        setOverview(json);
        announceNewAlerts(json.alerts);
      }
    } catch {}
  }, [announceNewAlerts]);

  const loadList = useCallback(async () => {
    try {
      if (tab === 'loans') {
        const json = await (await fetch(`/api/admin/list?type=loans&status=${loanFilter}`, { cache: 'no-store' })).json();
        if (json.success) setLoans(json.loans);
      } else if (tab === 'users') {
        const json = await (await fetch(`/api/admin/list?type=users&q=${encodeURIComponent(userQuery)}`, { cache: 'no-store' })).json();
        if (json.success) setUsers(json.users);
      } else if (tab === 'activity') {
        const json = await (await fetch('/api/admin/list?type=activity', { cache: 'no-store' })).json();
        if (json.success) setEvents(json.events);
      } else if (tab === 'alerts' && showHandled) {
        const json = await (await fetch('/api/admin/list?type=alerts&state=all', { cache: 'no-store' })).json();
        if (json.success) setEvents(json.events);
      }
    } catch {}
  }, [tab, loanFilter, userQuery, showHandled]);

  useEffect(() => {
    loadOverview();
    const interval = setInterval(loadOverview, REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadOverview]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const runAction = async (action: string, payload: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const key = `${action}:${JSON.stringify(payload)}`;
    setBusyAction(key);
    try {
      const res = await fetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const json = await res.json();
      setToast({ ok: Boolean(json.success), text: json.message || (json.success ? 'Done.' : 'The action failed.') });
    } catch {
      setToast({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusyAction(null);
      loadOverview();
      loadList();
    }
  };

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') {
      setToast({ ok: false, text: "This browser doesn't support notifications. Alerts still show here with a sound." });
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifyOn(permission === 'granted');
    beep();
  };

  if (denied) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
        <ShieldAlert className="w-10 h-10 text-rose-500" />
        <h1 className="text-lg font-black text-slate-900">Admin access only</h1>
        <p className="text-sm text-slate-500">Sign in with an admin account to open this page.</p>
        <div className="flex gap-2">
          <Link href="/login" className="px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-bold">Sign in</Link>
          <button onClick={() => router.push('/dashboard')} className="px-4 py-2 rounded-xl border border-slate-300 text-sm font-bold text-slate-700">
            Dashboard
          </button>
        </div>
      </div>
    );
  }

  const o = overview;
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'alerts', label: 'Alerts', badge: o?.counts.open_alerts },
    { id: 'slots', label: 'Slots' },
    { id: 'loans', label: 'Loans', badge: o?.counts.overdue_loans || undefined },
    { id: 'users', label: 'Users' },
    { id: 'activity', label: 'Activity' },
  ];

  const btn = 'px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition disabled:opacity-40';
  const isBusy = (action: string, payload: Record<string, unknown>) => busyAction === `${action}:${JSON.stringify(payload)}`;

  const eventRow = (e: AdminEvent, withHandle: boolean) => (
    <div key={e.id} className={`p-3 rounded-xl border-l-4 ${e.kind === 'ALERT' ? severityStyle[e.severity] : 'border-l-slate-300 bg-white'} border border-slate-200/70 space-y-1`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wide">{e.type.replace(/_/g, ' ')}</span>
        <span className="text-[10px] text-slate-400" title={formatStationDateTime(e.created_at)}>{timeAgo(e.created_at)}</span>
      </div>
      <p className="text-xs text-slate-800 leading-relaxed">{e.message}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-slate-400">
          {e.actor ? `by ${e.actor}` : ''}
          {e.handled_at ? ` · handled ${timeAgo(e.handled_at)}${e.handled_by ? ` by ${e.handled_by}` : ''}` : ''}
        </span>
        {withHandle && !e.handled_at && (
          <button
            onClick={() => runAction('alert.handle', { id: e.id })}
            disabled={isBusy('alert.handle', { id: e.id })}
            className={`${btn} border-slate-300 bg-white text-slate-700 hover:bg-slate-100`}
          >
            Mark handled
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col bg-slate-50 overflow-y-auto">
      {/* Header */}
      <div className="p-4 pb-2 space-y-3 bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="p-1.5 rounded-lg hover:bg-slate-100" title="Back to dashboard">
              <ArrowLeft className="w-4 h-4 text-slate-600" />
            </Link>
            <div>
              <h1 className="text-base font-black text-slate-900 leading-tight">Admin panel</h1>
              <p className="text-[10px] text-slate-500">{o ? `Signed in as ${o.admin} · refreshes every 5 s` : 'Loading…'}</p>
            </div>
          </div>
          <button
            onClick={enableNotifications}
            className={`p-2 rounded-xl border ${notifyOn ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500'}`}
            title={notifyOn ? 'Browser notifications on' : 'Turn on browser notifications'}
          >
            {notifyOn ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold transition ${
                tab === t.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {t.label}
              {t.badge ? <span className="ml-1.5 px-1.5 rounded-full bg-rose-500 text-white text-[10px]">{t.badge}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {toast && (
          <div
            onClick={() => setToast(null)}
            className={`p-3 rounded-xl text-xs font-medium cursor-pointer ${toast.ok ? 'bg-emerald-50 text-emerald-900 border border-emerald-200' : 'bg-rose-50 text-rose-900 border border-rose-200'}`}
          >
            {toast.text}
          </div>
        )}

        {o?.events_table_missing && (
          <div className="p-3 rounded-xl text-xs bg-amber-50 text-amber-900 border border-amber-200">
            Alerts and the activity log need the database script <code className="font-mono">supabase/migrations/20261026_admin_panel.sql</code> to be run once in Supabase.
          </div>
        )}

        {!o && <p className="text-xs text-slate-500">Loading the station…</p>}

        {/* ---------------- Overview ---------------- */}
        {o && tab === 'overview' && (
          <>
            <div className={`p-4 rounded-2xl border flex items-center justify-between ${
              o.cabinet.online === false ? 'bg-rose-50 border-rose-200' : o.cabinet.online ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'
            }`}>
              <div className="flex items-center gap-3">
                {o.cabinet.online === false ? <WifiOff className="w-5 h-5 text-rose-600" /> : <Wifi className="w-5 h-5 text-emerald-600" />}
                <div>
                  <p className="text-sm font-black text-slate-900">
                    Station {o.cabinet.online === false ? 'offline' : o.cabinet.online ? 'online' : 'status unknown'}
                  </p>
                  <p className="text-[11px] text-slate-500">Last slot report {timeAgo(o.cabinet.report_at)}</p>
                </div>
              </div>
              <button onClick={loadOverview} className="p-2 rounded-lg hover:bg-white/60" title="Refresh now">
                <RefreshCw className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {[
                ['Open alerts', o.counts.open_alerts],
                ['Open loans', o.counts.open_loans],
                ['Overdue', o.counts.overdue_loans],
                ['Students', o.counts.users],
              ].map(([label, value]) => (
                <div key={label as string} className="p-3 rounded-xl bg-white border border-slate-200">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
                  <p className="text-xl font-black text-slate-900 tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              {o.slots.map((s) => {
                const c = o.cabinet.slots.find((x) => Number(x.slot) === s.slot);
                const loan = o.open_loans.find((l) => l.umbrella_id === s.umbrella_id);
                return (
                  <div key={s.slot} className="p-3 rounded-xl bg-white border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black font-mono text-slate-800">SLOT {s.slot}</span>
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        s.held || s.admin_hold ? 'bg-amber-100 text-amber-800' : s.availability ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                      }`}>
                        {s.held || s.admin_hold ? 'Held' : s.availability ? 'Available' : 'Out'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600">
                      {s.held ? `Held for ${s.borrowed_user}` : loan ? `With ${loan.index_no}${loan.status === 'OVERDUE' ? ' (overdue)' : ''}` : s.availability ? 'In the station' : 'Out, no loan'}
                      {s.admin_hold && ' · held by admin'}
                    </p>
                    <p className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Umbrella className="w-3 h-3" />
                      {c ? (
                        <>
                          {c.busy ? 'busy · ' : ''}
                          {c.docked ? `docked${c.umbrella ? `, umbrella ${c.umbrella}` : c.umbrella === 0 ? ', unknown tag' : ''}` : 'empty'}
                          {c.locked === false ? ' · unlocked' : c.locked ? ' · locked' : ''}
                        </>
                      ) : (
                        'no station report'
                      )}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2">
              <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Open alerts</h2>
              {o.alerts.length === 0 ? <p className="text-xs text-slate-500">Nothing unusual right now.</p> : o.alerts.slice(0, 5).map((a) => eventRow(a, true))}
            </div>

            <div className="space-y-2">
              <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Latest activity</h2>
              {o.activity.length === 0 ? <p className="text-xs text-slate-500">No activity yet.</p> : o.activity.slice(0, 8).map((a) => eventRow(a, false))}
            </div>
          </>
        )}

        {/* ---------------- Alerts ---------------- */}
        {o && tab === 'alerts' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input id="show-handled" type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
                Show handled alerts
              </label>
              {o.alerts.length > 0 && (
                <button onClick={() => runAction('alert.handleAll', {})} className={`${btn} border-slate-300 bg-white text-slate-700`}>
                  Mark all handled
                </button>
              )}
            </div>
            {(showHandled ? events : o.alerts).length === 0 ? (
              <p className="text-xs text-slate-500">No alerts.</p>
            ) : (
              (showHandled ? events : o.alerts).map((a) => eventRow(a, true))
            )}
          </div>
        )}

        {/* ---------------- Slots ---------------- */}
        {o && tab === 'slots' && (
          <div className="space-y-2">
            {o.slots.map((s) => (
              <div key={s.slot} className="p-3 rounded-xl bg-white border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black font-mono">Slot {s.slot}</span>
                  <span className="text-[11px] text-slate-500">
                    {s.held ? `Held for ${s.borrowed_user}` : s.availability ? 'Available' : `Out${s.borrowed_user ? ` (${s.borrowed_user})` : ''}`}
                    {s.admin_hold && <span className="ml-1.5 font-bold text-amber-700">· Held by admin</span>}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => runAction('slot.open', { slot: s.slot })} disabled={isBusy('slot.open', { slot: s.slot })} className={`${btn} border-sky-300 bg-sky-50 text-sky-800`}>
                    <Unlock className="w-3 h-3 inline mr-1" />Open lock
                  </button>
                  <button onClick={() => runAction('slot.close', { slot: s.slot })} disabled={isBusy('slot.close', { slot: s.slot })} className={`${btn} border-slate-300 bg-white text-slate-700`}>
                    <Lock className="w-3 h-3 inline mr-1" />Close lock
                  </button>
                  {s.held && (
                    <button onClick={() => runAction('slot.release', { slot: s.slot })} className={`${btn} border-amber-300 bg-amber-50 text-amber-800`}>
                      Release hold
                    </button>
                  )}
                  {s.admin_hold ? (
                    <button onClick={() => runAction('slot.unhold', { slot: s.slot }, `Release the hold on Slot ${s.slot}? Students will be able to borrow from it again.`)} disabled={isBusy('slot.unhold', { slot: s.slot })} className={`${btn} border-amber-300 bg-amber-50 text-amber-800`}>
                      Release hold
                    </button>
                  ) : (
                    <button onClick={() => runAction('slot.hold', { slot: s.slot }, `Hold Slot ${s.slot}? Students won't be able to borrow from it until you release it. Returns still work.`)} disabled={isBusy('slot.hold', { slot: s.slot })} className={`${btn} border-amber-300 bg-white text-amber-800`}>
                      Hold
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ---------------- Loans ---------------- */}
        {tab === 'loans' && (
          <div className="space-y-2">
            <div className="flex gap-1">
              {(['open', 'returned', 'all'] as const).map((f) => (
                <button key={f} onClick={() => setLoanFilter(f)} className={`${btn} ${loanFilter === f ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-600'}`}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            {loans.length === 0 ? <p className="text-xs text-slate-500">No loans.</p> : loans.map((l) => (
              <div key={l.record_id} className="p-3 rounded-xl bg-white border border-slate-200 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black font-mono">{l.index_no}</span>
                  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    l.status === 'OVERDUE' ? 'bg-rose-100 text-rose-800' : l.status === 'ACTIVE' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'
                  }`}>{l.status}</span>
                </div>
                <p className="text-[11px] text-slate-600">
                  {l.umbrella_id} · borrowed {timeAgo(l.borrowed_time)} · {l.returned_time ? `returned ${timeAgo(l.returned_time)}` : `due ${formatStationDateTime(l.due_time)}`}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {l.status !== 'RETURNED' && (
                    <>
                      <button onClick={() => runAction('loan.close', { record_id: l.record_id }, `Mark ${l.index_no}'s umbrella as returned?`)} className={`${btn} border-emerald-300 bg-emerald-50 text-emerald-800`}>
                        Mark returned
                      </button>
                      <button onClick={() => runAction('loan.extend', { record_id: l.record_id, hours: 24 })} className={`${btn} border-sky-300 bg-sky-50 text-sky-800`}>
                        +24 h
                      </button>
                    </>
                  )}
                  <button onClick={() => runAction('loan.delete', { record_id: l.record_id }, `Delete this loan record of ${l.index_no}? This can't be undone.`)} className={`${btn} border-rose-300 bg-rose-50 text-rose-800`}>
                    Delete record
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ---------------- Users ---------------- */}
        {tab === 'users' && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="user-search"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search index number, name or email"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
              />
            </div>
            {users.length === 0 ? <p className="text-xs text-slate-500">No users found.</p> : users.map((u) => (
              <div key={u.index_no} className="p-3 rounded-xl bg-white border border-slate-200 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black font-mono">{u.index_no}</span>
                  <span className="flex gap-1">
                    {u.is_admin && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">Admin</span>}
                    {u.is_locked && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">Locked</span>}
                    {!u.is_verified && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Unverified</span>}
                  </span>
                </div>
                <p className="text-[11px] text-slate-600">{u.username} · {u.email}</p>
                {u.open_loan && <p className="text-[11px] text-sky-700">Has {u.open_loan.umbrella_id} ({u.open_loan.status.toLowerCase()})</p>}
                {!u.is_admin && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => runAction(u.is_locked ? 'user.unlock' : 'user.lock', { index_no: u.index_no }, u.is_locked ? undefined : `Lock ${u.index_no}? They will be signed out and can't sign in.`)}
                      className={`${btn} ${u.is_locked ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
                    >
                      {u.is_locked ? 'Unlock' : 'Lock'}
                    </button>
                    <button onClick={() => runAction('user.resetPassword', { index_no: u.index_no }, `Email a password reset code to ${u.index_no}?`)} className={`${btn} border-sky-300 bg-sky-50 text-sky-800`}>
                      Send reset code
                    </button>
                    <button onClick={() => runAction('user.delete', { index_no: u.index_no }, `Delete ${u.index_no} and their loan history? This can't be undone.`)} className={`${btn} border-rose-300 bg-rose-50 text-rose-800`}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ---------------- Activity ---------------- */}
        {tab === 'activity' && (
          <div className="space-y-2">
            {events.length === 0 ? <p className="text-xs text-slate-500">No activity yet.</p> : events.map((e) => eventRow(e, false))}
          </div>
        )}
      </div>
    </div>
  );
}
