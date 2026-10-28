'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Umbrella,
  Lock,
  Unlock,
  CheckCircle2,
  Clock,
  Check,
  Wrench,
  AlertCircle,
  Info,
} from 'lucide-react';
import { BottomNav } from '@/components/BottomNav';
import { ContactFooter } from '@/components/ContactFooter';
import type { MeResponse } from '@/lib/types';
import { useViewMode } from '@/components/ViewModeContext';
import { formatStationDueTime } from '@/lib/time';
import { beginStationRequest, clearStationCache, isCurrentStationRequest, restoreStationUser, setStationResponse, useStationCache } from '@/lib/stationCache';
import './dashboard.css';

// The lock takes ~4 s to open (message delivery + 2.7 s servo turn); the countdown
// starts after that. Then the cabinet gives the student 5 checks × ~2.5 s with the
// lock open, and checks twice more while it closes.
const OPENING_MS = 4000;
const TAKE_WINDOW_SECONDS = 12;

interface AssignedSlot {
  slot: number;
  umbrella_number: number;
  umbrella_id: string;
}

interface CabinetReply {
  success?: boolean;
  message?: string;
  reason?: string;
  slot?: number;
  due_time?: string;
  duration?: string;
}

// Big result card shown after a borrow (green), a return (blue) or an error (red)
interface ActionResult {
  tone: 'borrowed' | 'returned' | 'error';
  title: string;
  detail: string;
}

/**
 * What happened and what to do next, from the server's answer
 */
function describeResult(kind: 'borrow' | 'return', reply: CabinetReply): ActionResult {
  const slot = reply.slot;

  if (reply.success) {
    if (kind === 'borrow') {
      return {
        tone: 'borrowed',
        title: `Umbrella ${slot} borrowed`,
        detail: reply.due_time
          ? `Return it to Slot ${slot} by ${formatStationDueTime(reply.due_time)}.`
          : `Return it to Slot ${slot} within 24 hours.`,
      };
    }
    return {
      tone: 'returned',
      title: 'Returned — your loan is closed',
      detail: `Umbrella ${slot} is back in Slot ${slot}.${reply.duration ? ` You had it for ${reply.duration}.` : ''} Thank you!`,
    };
  }

  if (reply.reason === 'NOT_TAKEN') {
    return {
      tone: 'error',
      title: 'Umbrella not taken',
      detail: `Slot ${slot} locked again and no loan was recorded. Tap Borrow to try again, and take the umbrella while the lock is open.`,
    };
  }
  if (reply.reason === 'NO_UMBRELLA') {
    return {
      tone: 'error',
      title: 'Umbrella not detected',
      detail: `Slot ${slot} locked again and your loan is still open. Tap Return, then push the umbrella all the way into Slot ${slot}.`,
    };
  }
  if (reply.reason === 'WRONG_UMBRELLA') {
    return {
      tone: 'error',
      title: `Wrong umbrella in Slot ${slot}`,
      detail: `That isn't Umbrella ${slot}. The slot is left unlocked: take that umbrella out, then tap Return again with your own umbrella.`,
    };
  }
  return {
    tone: 'error',
    title: kind === 'borrow' ? 'Borrow failed' : 'Return failed',
    detail: reply.message || 'The request failed. Please try again.',
  };
}

/**
 * Time left on a loan, or how long it is overdue, e.g. "23h 12m"
 */
function loanTimeLeft(dueIso: string): { overdue: boolean; text: string } {
  const diffMs = new Date(dueIso).getTime() - Date.now();
  const mins = Math.floor(Math.abs(diffMs) / 60000);
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return { overdue: diffMs < 0, text };
}

/**
 * Reads a cabinet API response. Student borrows stream NDJSON: an "assigned" line
 * (which slot this student got) as soon as the slot is reserved, then a "result"
 * line when the cabinet answers. Everything else is a single JSON body.
 */
async function readCabinetResponse(
  res: Response,
  onAssigned: (assigned: AssignedSlot) => void
): Promise<CabinetReply> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson') || !res.body) {
    return res.json();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'assigned') onAssigned(event);
      else if (event.type === 'result') result = event;
    }
  }

  return (
    result ?? {
      success: false,
      message: 'The connection to the station was lost before it answered. Check the dashboard in a moment.',
    }
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { isStudentMode } = useViewMode();
  const station = useStationCache();
  const currentUserName = station.me?.user.username || station.user?.username || '';

  // The last confirmed response is visible immediately when returning to this page.
  const isDevAccount = station.me?.is_dev ?? false;
  const isAdmin = station.me?.is_admin ?? false;
  const cabinetOnline = station.me?.cabinet_online ?? null;
  const cabinetOffline = cabinetOnline === false;
  const slots = station.me?.slots ?? [];

  // Active borrow state (Determines State A vs State B)
  const [loanOverride, setActiveLoan] = useState<{
    record_id?: string;
    umbrella_id: string;
    slot: number | null;
    borrowed_time: string;
    due_time: string;
    is_overdue?: boolean;
  } | null | undefined>(undefined);
  const activeLoan = loanOverride === undefined ? station.me?.active_loan ?? null : loanOverride;

  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<'borrow' | 'return' | null>(null);
  const [unlockCountdown, setUnlockCountdown] = useState<number | null>(null);
  const [lockClosing, setLockClosing] = useState(false); // take window over, the station is closing the lock
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notification, setNotification] = useState<{
    type: 'success' | 'info' | 'error';
    text: string;
  } | null>(null);

  // Dynamic Full-Screen Ambient Glow: 'green' (borrowing), 'blue' (returning), 'red' (error)
  const [screenGlow, setScreenGlow] = useState<'green' | 'blue' | 'red' | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerErrorGlow = useCallback(() => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setScreenGlow('red');
    errorTimerRef.current = setTimeout(() => {
      setScreenGlow((prev) => (prev === 'red' ? null : prev));
    }, 6000);
  }, []);

  const dismissNotification = useCallback(() => {
    setNotification(null);
    if (screenGlow === 'red') setScreenGlow(null);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, [screenGlow]);

  const dismissResult = useCallback(() => {
    setResult(null);
    if (screenGlow === 'red') setScreenGlow(null);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, [screenGlow]);

  // The login response supplies the name, even before the first station fetch.
  useEffect(() => {
    restoreStationUser();
  }, []);

  // Fetch profile, slots and active loan from the server (session cookie)
  const refreshStationData = useCallback(async () => {
    const request = beginStationRequest();
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (!isCurrentStationRequest(request)) return;

      if (res.status === 401) {
        clearStationCache();
        localStorage.removeItem('astrix_user');
        sessionStorage.clear();
        router.replace('/login?notice=session_expired');
        return;
      }

      const json: MeResponse = await res.json();
      if (!res.ok || !json.success) return;
      setStationResponse(json, request);
      setActiveLoan(undefined);
    } catch (err: any) {
      console.warn('Station refresh note:', err.message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    refreshStationData();
    const interval = setInterval(refreshStationData, 5000);
    return () => clearInterval(interval);
  }, [refreshStationData]);

  const stopCountdown = () => {
    if (openingTimerRef.current) clearTimeout(openingTimerRef.current);
    openingTimerRef.current = null;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    setUnlockCountdown(null);
  };

  useEffect(() => {
    return () => {
      stopCountdown();
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // Next available slot calculation (lowest slot where availability = true)
  const availableSlotsList = slots.filter((s) => s.availability);
  const nextAvailableSlot = availableSlotsList.length > 0 ? availableSlotsList[0] : null;

  // Time left on the student's loan (refreshed with the station data every 5 s)
  const loanTime = activeLoan ? loanTimeLeft(activeLoan.due_time) : null;
  const loanOverdue = Boolean(activeLoan?.is_overdue || loanTime?.overdue);

  // How long ago the loan started, e.g. "12 mins ago"
  const getElapsedDuration = (isoString?: string) => {
    if (!isoString) return 'just now';
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m ago`;
  };

  // Start the "take it now" countdown once the lock has had time to open
  const startTakeCountdown = () => {
    openingTimerRef.current = setTimeout(() => {
      let remaining = TAKE_WINDOW_SECONDS;
      setUnlockCountdown(remaining);
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          setUnlockCountdown(remaining);
        } else {
          stopCountdown();
          setLockClosing(true);
        }
      }, 1000);
    }, OPENING_MS);
  };

  // Shared request runner: the server sends the command, waits for the cabinet,
  // records the result, and answers with the cabinet's message.
  // For a borrow, the server first tells us which slot we got (it may not be the
  // one shown as "next free" if someone else borrowed at the same moment).
  const runCabinetAction = async (
    kind: 'borrow' | 'return',
    slotHint: number | null,
    body: Record<string, unknown>
  ) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setResult(null);
    setLockClosing(false);
    setActionInProgress(kind);
    setScreenGlow(kind === 'borrow' ? 'green' : 'blue');
    setPendingSlot(kind === 'borrow' ? null : slotHint);
    setNotification({
      type: 'info',
      text:
        kind === 'borrow'
          ? '🔎 Finding a free slot for you…'
          : `🔓 Opening ${slotHint ? `Slot #${slotHint}` : 'your slot'}… Dock the umbrella and wait for lock confirmation.`,
    });

    try {
      const res = await fetch(`/api/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await readCabinetResponse(res, (assigned) => {
        setPendingSlot(assigned.slot);
        setNotification({
          type: 'info',
          text: `🔓 Take Umbrella ${assigned.umbrella_number} from Slot ${assigned.slot}. The lock is opening now.`,
        });
        startTakeCountdown();
      });

      if (json.success) setScreenGlow(null);
      else triggerErrorGlow();
      setNotification(null);
      setResult(describeResult(kind, json));
    } catch {
      triggerErrorGlow();
      setNotification(null);
      setResult({
        tone: 'error',
        title: 'Could not reach the station',
        detail: 'Please check your connection and try again.',
      });
    } finally {
      stopCountdown();
      setLockClosing(false);
      setPendingSlot(null);
      setActionInProgress(null);
      refreshStationData();
    }
  };

  // Per-slot busy state for independent, non-blocking developer actions
  const [devSlotBusy, setDevSlotBusy] = useState<Record<number, 'borrow' | 'return' | 'open' | 'close' | null>>({});

  // Developer direct non-blocking borrow on any slot
  const handleDevBorrow = async (slot: number) => {
    setDevSlotBusy((prev) => ({ ...prev, [slot]: 'borrow' }));
    setNotification({
      type: 'info',
      text: `🔓 [Slot #${slot}] Sending Borrow command to station…`,
    });

    try {
      const res = await fetch('/api/borrow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setNotification({ type: 'success', text: `✅ [Slot #${slot}] ${json.message}` });
      } else {
        triggerErrorGlow();
        setNotification({ type: 'error', text: `⚠️ [Slot #${slot}] ${json.message || 'Borrow failed.'}` });
      }
    } catch {
      triggerErrorGlow();
      setNotification({ type: 'error', text: `Could not connect to station for Slot #${slot}.` });
    } finally {
      setDevSlotBusy((prev) => ({ ...prev, [slot]: null }));
      refreshStationData();
    }
  };

  // Developer direct non-blocking return on any slot
  const handleDevReturn = async (slot: number) => {
    setDevSlotBusy((prev) => ({ ...prev, [slot]: 'return' }));
    setNotification({
      type: 'info',
      text: `🔒 [Slot #${slot}] Sending Return command to station…`,
    });

    try {
      const res = await fetch('/api/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setNotification({ type: 'success', text: `✅ [Slot #${slot}] ${json.message}` });
      } else {
        triggerErrorGlow();
        setNotification({ type: 'error', text: `⚠️ [Slot #${slot}] ${json.message || 'Return failed.'}` });
      }
    } catch {
      triggerErrorGlow();
      setNotification({ type: 'error', text: `Could not connect to station for Slot #${slot}.` });
    } finally {
      setDevSlotBusy((prev) => ({ ...prev, [slot]: null }));
      refreshStationData();
    }
  };

  // Developer direct lock Open / Close
  const handleDevLock = async (slot: number, action: 'OPEN' | 'CLOSE') => {
    const key = action === 'OPEN' ? 'open' : 'close';
    setDevSlotBusy((prev) => ({ ...prev, [slot]: key }));
    setNotification({
      type: 'info',
      text: `⚡ [Slot #${slot}] Sending ${action} lock command…`,
    });

    try {
      const res = await fetch('/api/dev/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, action }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setNotification({ type: 'success', text: `✅ [Slot #${slot}] ${json.message}` });
      } else {
        triggerErrorGlow();
        setNotification({ type: 'error', text: `⚠️ [Slot #${slot}] ${json.message || 'Lock command failed.'}` });
      }
    } catch {
      triggerErrorGlow();
      setNotification({ type: 'error', text: `Could not connect to station for Slot #${slot}.` });
    } finally {
      setDevSlotBusy((prev) => ({ ...prev, [slot]: null }));
      refreshStationData();
    }
  };

  // Borrow Umbrella (Standard Student View)
  const handleBorrow = async () => {
    if (!nextAvailableSlot) {
      triggerErrorGlow();
      setResult({
        tone: 'error',
        title: 'No umbrellas available',
        detail: 'All umbrellas are in use right now. Please check back soon.',
      });
      return;
    }
    await runCabinetAction('borrow', nextAvailableSlot.slot, {});
  };

  // Return Umbrella (the server picks the slot from the loan)
  const handleReturn = async () => {
    if (!activeLoan) return;
    await runCabinetAction('return', activeLoan.slot, {});
  };

  // Interactive Test State Switcher
  const toggleDemoState = () => {
    if (activeLoan) {
      // Switch to State A
      setActiveLoan(null);
      setNotification({ type: 'info', text: 'Switched to State A (Borrowing View).' });
    } else {
      // Switch to State B
      const slot1 = slots[0];
      if (!slot1) return;
      const borrowedAt = Date.now() - 24 * 60 * 1000; // 24 mins ago
      setActiveLoan({
        umbrella_id: slot1.umbrella_id,
        slot: slot1.slot,
        borrowed_time: new Date(borrowedAt).toISOString(),
        due_time: new Date(borrowedAt + 24 * 60 * 60 * 1000).toISOString(),
      });
      setNotification({ type: 'info', text: 'Switched to State B (Returning View).' });
    }
  };

  const slotTiles = slots.map((s) => {
    const isMine = actionInProgress === 'borrow' && pendingSlot === s.slot;
    const isSelected = activeLoan?.slot === s.slot || (actionInProgress === 'borrow' ? isMine : nextAvailableSlot?.slot === s.slot);
    return (
      <div
        key={s.slot}
        className={`astrix-slot ${s.availability ? 'ready' : 'out'} ${isSelected ? 'selected' : ''}`}
        aria-label={`Slot ${s.slot}: ${isMine ? 'assigned to you' : activeLoan?.slot === s.slot ? 'your loan' : s.availability ? 'ready' : s.admin_hold ? 'on hold' : 'out'}`}
      >
        <span className="astrix-slot-number">#{s.slot}</span>
        <span className="astrix-slot-icon"><Umbrella aria-hidden="true" /></span>
        <span className="astrix-slot-state">
          {isMine || activeLoan?.slot === s.slot ? 'Yours' : s.availability ? 'Ready' : s.admin_hold ? 'Held' : 'Out'}
        </span>
      </div>
    );
  });

  return (
    <div className="astrix-dashboard flex-1 flex flex-col bg-white select-none overflow-y-auto relative">
      {/* ============================================================================== */}
      {/* DYNAMIC SCREEN GLOW AURA (Green on Borrow, Blue on Return, Red on Error)       */}
      {/* ============================================================================== */}
      {screenGlow && (
        <div
          className={`pointer-events-none fixed inset-0 max-w-md mx-auto z-40 transition-all duration-500 ease-in-out ${
            screenGlow === 'green'
              ? 'ring-8 ring-emerald-500/80 shadow-[inset_0_0_60px_15px_rgba(16,185,129,0.45)]'
              : screenGlow === 'blue'
              ? 'ring-8 ring-sky-500/80 shadow-[inset_0_0_60px_15px_rgba(14,165,233,0.45)]'
              : 'ring-8 ring-rose-500/90 shadow-[inset_0_0_60px_15px_rgba(244,63,94,0.55)]'
          }`}
        >
          {/* Top radiant light gradient */}
          <div
            className={`w-full h-36 bg-gradient-to-b opacity-50 animate-pulse ${
              screenGlow === 'green'
                ? 'from-emerald-500 via-emerald-400/20 to-transparent'
                : screenGlow === 'blue'
                ? 'from-sky-500 via-sky-400/20 to-transparent'
                : 'from-rose-500 via-rose-400/30 to-transparent'
            }`}
          />

          {/* Floating Glow Status Pill */}
          <div className="absolute top-3 inset-x-0 flex justify-center px-4 animate-in fade-in slide-in-from-top-2 duration-300">
            <div
              className={`px-4 py-2 rounded-full text-xs font-black shadow-lg backdrop-blur-md flex items-center space-x-2 border ${
                screenGlow === 'green'
                  ? 'bg-emerald-950/85 text-emerald-200 border-emerald-400/40 shadow-emerald-500/25'
                  : screenGlow === 'blue'
                  ? 'bg-sky-950/85 text-sky-200 border-sky-400/40 shadow-sky-500/25'
                  : 'bg-rose-950/90 text-rose-200 border-rose-400/40 shadow-rose-500/25'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full animate-ping ${
                  screenGlow === 'green'
                    ? 'bg-emerald-400'
                    : screenGlow === 'blue'
                    ? 'bg-sky-400'
                    : 'bg-rose-400'
                }`}
              />
              <span className="tracking-wide">
                {screenGlow === 'green' && '🟢 Borrow in Progress… Lock Opening'}
                {screenGlow === 'blue' && '🔵 Return in Progress… Verifying Umbrella Lock'}
                {screenGlow === 'red' && '🔴 Operation Alert / Error'}
              </span>
            </div>
          </div>
        </div>
      )}

      <header className="astrix-masthead">
        <div className="astrix-masthead-inner">
          <div className="astrix-topline">
            <svg className="astrix-umbrella-mark" viewBox="0 0 300 220" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <g stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M75 130c5-42 42-70 86-79 51-11 98 3 117 35" />
                <path d="M75 130c15-14 31-18 51-11 17-14 34-17 51-10 15-15 31-19 50-12 14-16 32-19 51-11" />
                <path d="M161 51c-17 17-27 40-35 68M161 51c26 10 49 26 66 46" />
                <path d="m155 27 6 24 31 130c4 19 31 26 34 7" />
              </g>
            </svg>
          </div>
          <h1>Smart Umbrella<br />Station</h1>
          <p>Welcome back, <strong>{currentUserName || 'Student'}</strong></p>
          {isAdmin && (
            <Link href="/admin" className="astrix-admin-link">Open admin panel</Link>
          )}
          {!isStudentMode && (
            <button type="button" onClick={toggleDemoState} className="astrix-demo-toggle">
              Switch to {activeLoan ? 'State A' : 'State B'}
            </button>
          )}
        </div>
      </header>

      <main className="astrix-sheet space-y-4" aria-busy={loading}>
        {/* Station Offline Banner */}
        {cabinetOffline && (
          <div className="p-3.5 rounded-2xl text-xs bg-slate-800 text-white border border-slate-700 shadow-sm" role="status">
            <p className="font-bold">The umbrella station is offline</p>
            <p className="text-slate-300 mt-0.5">Borrowing and returning are paused until it reconnects. This page updates by itself.</p>
          </div>
        )}

        {/* Result of the last borrow/return: green = borrowed, blue = returned, red = error */}
        {result && (
          <div
            role="status"
            aria-live="polite"
            className={`p-5 rounded-3xl text-white shadow-lg space-y-4 bg-gradient-to-br animate-in fade-in slide-in-from-top-1 ${
              result.tone === 'borrowed'
                ? 'from-emerald-500 to-emerald-600 shadow-emerald-500/30'
                : result.tone === 'returned'
                ? 'from-sky-500 to-sky-600 shadow-sky-500/30'
                : 'from-rose-500 to-rose-600 shadow-rose-500/30'
            }`}
          >
            <div className="flex items-start space-x-3">
              <div className="w-11 h-11 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                {result.tone === 'error' ? <AlertCircle className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
              </div>
              <div className="space-y-1">
                <p className="text-xl font-black leading-tight">{result.title}</p>
                <p className="text-sm leading-relaxed text-white/90">{result.detail}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={dismissResult}
              className="w-full py-2.5 rounded-xl bg-white/20 hover:bg-white/30 text-sm font-bold transition"
            >
              OK
            </button>
          </div>
        )}

        {/* Notifications & Hardware Feedback */}
        {notification && (
          <div
            className={`p-3.5 rounded-2xl text-xs flex items-start space-x-2.5 animate-in fade-in slide-in-from-top-1 shadow-sm ${
              notification.type === 'success'
                ? 'bg-emerald-50 text-emerald-900 border border-emerald-200'
                : notification.type === 'error'
                ? 'bg-rose-50 text-rose-900 border border-rose-200'
                : 'bg-sky-50 text-sky-900 border border-sky-200'
            }`}
          >
            {notification.type === 'success' && (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            )}
            {notification.type === 'error' && (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            )}
            {notification.type === 'info' && (
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-sky-600" />
            )}
            <span className="leading-relaxed flex-1">{notification.text}</span>
            <button
              type="button"
              onClick={dismissNotification}
              className="text-slate-400 hover:text-slate-600 text-xs font-bold px-1 transition"
              title="Dismiss notification"
            >
              ✕
            </button>
          </div>
        )}

        {/* DEV001 Super-User Mode Banner */}
        {isDevAccount && (
          <div className="bg-purple-900/10 border border-purple-500/30 rounded-2xl p-3 flex items-center justify-between text-xs text-purple-900 shadow-sm">
            <div className="flex items-center space-x-2">
              <span className="text-base">🛠️</span>
              <div>
                <p className="font-bold">DEV001 Developer Account Active</p>
                <p className="text-[10px] text-purple-700 font-medium">Multi-borrow allowed & click any slot below to eject/borrow directly</p>
              </div>
            </div>
            <span className="text-[10px] bg-purple-600 text-white px-2 py-0.5 rounded-full font-mono uppercase font-bold">
              DEV MODE
            </span>
          </div>
        )}

        {/* ============================================================================== */}
        {/* DYNAMIC DASHBOARD DISPLAY: DEV001 TEST MATRIX vs STUDENT 2-STATE VIEW          */}
        {/* ============================================================================== */}

        {isDevAccount ? (
          /* ============================================================================ */
          /* DEVELOPER ACCOUNT: DEDICATED HARDWARE CONTROL STATION (DEV001)               */
          /* ============================================================================ */
          <div className="space-y-4">
            {/* Developer Control Header */}
            <div className="bg-gradient-to-br from-purple-700 via-indigo-700 to-purple-800 text-white p-5 rounded-3xl shadow-lg shadow-purple-900/20 space-y-3 relative overflow-hidden">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full bg-white/20 text-white backdrop-blur-sm flex items-center gap-1.5">
                  <Wrench className="w-3 h-3" />
                  <span>Hardware Testing Console</span>
                </span>
                <span className="text-xs text-purple-200 font-mono font-bold">
                  DEV001
                </span>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-purple-200 font-medium">Station Hardware Control</p>
                <div className="text-2xl font-black tracking-tight flex items-center gap-2">
                  <span>ESP32 Diagnostics</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-400 text-emerald-950 font-bold">
                    Zero Loans
                  </span>
                </div>
              </div>

              <p className="text-xs text-purple-200/90 leading-relaxed">
                Click <strong>Borrow</strong> or <strong>Return</strong> on any physical slot below to test lock release and RFID detection freely with zero rental state lockouts.
              </p>
            </div>

            {/* 4 Physical Slots — Direct Hardware Action Matrix */}
            <div className="bg-white p-4 rounded-3xl border border-slate-200/80 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Station Slots (1 - 4) Hardware Controls
                </span>
                <span className="text-[11px] font-mono text-purple-600 font-bold">
                  QoS 0 • Live
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {slots.map((s) => (
                  <div
                    key={s.slot}
                    className={`p-3.5 rounded-2xl border transition flex flex-col justify-between space-y-2.5 ${
                      s.availability
                        ? 'bg-emerald-50/40 border-emerald-200'
                        : 'bg-slate-50/70 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-slate-700 font-mono">
                        SLOT #{s.slot}
                      </span>
                      <span
                        className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded-md ${
                          s.availability
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {s.admin_hold ? 'Held' : s.availability ? 'Docked' : 'Empty'}
                      </span>
                    </div>

                    <div className="flex items-center space-x-2 text-xs">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                          s.availability ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400'
                        }`}
                      >
                        <Umbrella className="w-3.5 h-3.5" />
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 truncate font-semibold">
                        {s.umbrella_id}
                      </span>
                    </div>

                    {/* 4 HARDWARE ACTION BUTTONS: BORROW, RETURN, OPEN, CLOSE (Non-blocking) */}
                    <div className="grid grid-cols-2 gap-1.5 pt-1">
                      {/* 1. Borrow */}
                      <button
                        type="button"
                        onClick={() => handleDevBorrow(s.slot)}
                        disabled={devSlotBusy[s.slot] === 'borrow'}
                        className="py-2 px-1 text-[11px] font-black rounded-xl bg-sky-600 hover:bg-sky-700 text-white transition shadow-sm active:scale-95 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1"
                        title={`Send Borrow command for Slot ${s.slot}`}
                      >
                        {devSlotBusy[s.slot] === 'borrow' ? (
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <Unlock className="w-3 h-3" />
                        )}
                        <span>Borrow</span>
                      </button>

                      {/* 2. Return */}
                      <button
                        type="button"
                        onClick={() => handleDevReturn(s.slot)}
                        disabled={devSlotBusy[s.slot] === 'return'}
                        className="py-2 px-1 text-[11px] font-black rounded-xl bg-amber-600 hover:bg-amber-700 text-white transition shadow-sm active:scale-95 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1"
                        title={`Send Return command for Slot ${s.slot}`}
                      >
                        {devSlotBusy[s.slot] === 'return' ? (
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        <span>Return</span>
                      </button>

                      {/* 3. Open Lock */}
                      <button
                        type="button"
                        onClick={() => handleDevLock(s.slot, 'OPEN')}
                        disabled={devSlotBusy[s.slot] === 'open'}
                        className="py-2 px-1 text-[11px] font-black rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white transition shadow-sm active:scale-95 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1"
                        title={`Directly open lock on Slot ${s.slot}`}
                      >
                        {devSlotBusy[s.slot] === 'open' ? (
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <Unlock className="w-3 h-3" />
                        )}
                        <span>Open</span>
                      </button>

                      {/* 4. Close Lock */}
                      <button
                        type="button"
                        onClick={() => handleDevLock(s.slot, 'CLOSE')}
                        disabled={devSlotBusy[s.slot] === 'close'}
                        className="py-2 px-1 text-[11px] font-black rounded-xl bg-slate-700 hover:bg-slate-800 text-white transition shadow-sm active:scale-95 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1"
                        title={`Directly close lock on Slot ${s.slot}`}
                      >
                        {devSlotBusy[s.slot] === 'close' ? (
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        <span>Close</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : !activeLoan ? (
          /* ============================================================================ */
          /* STATE A: "WHEN BORROWING" (Standard Student View)                            */
          /* ============================================================================ */
          <div className="space-y-4">
            {/* Assigned Slot Card: which umbrella THIS student must take */}
            {actionInProgress === 'borrow' && (
              <div
                className="bg-white border-2 border-emerald-400 rounded-3xl p-5 shadow-lg shadow-emerald-500/20 text-center space-y-1"
                aria-live="polite"
              >
                {pendingSlot ? (
                  <>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Your umbrella</p>
                    <p className="text-4xl font-black text-slate-900 font-mono">Slot {pendingSlot}</p>
                    <p className="text-sm font-bold text-slate-700">
                      Take Umbrella {pendingSlot}, only from this slot
                    </p>
                    <p className="text-xs text-slate-500">
                      {unlockCountdown !== null
                        ? `${unlockCountdown}s left to take it`
                        : lockClosing
                        ? 'The lock is closing. Checking whether you took it…'
                        : 'The lock is opening…'}
                    </p>
                  </>
                ) : (
                  <p className="text-sm font-bold text-slate-600 py-3">Finding a free slot for you…</p>
                )}
              </div>
            )}

            {/* State Banner */}
            <section className="astrix-availability-card" aria-label="Umbrella availability">
              <div className="flex items-center justify-between">
                <span className="astrix-status-pill">
                  {nextAvailableSlot ? 'Ready to borrow' : 'All umbrellas out'}
                </span>
                <span className="astrix-availability-count">
                  {availableSlotsList.length} of {slots.length || 4} available
                </span>
              </div>

              {/* Ready Slot Display */}
              <p className="astrix-card-overline">Next ready umbrella</p>
              <p className="astrix-slot-callout">
                {nextAvailableSlot ? 'Available at ' : ''}
                <strong>{nextAvailableSlot ? `Slot ${nextAvailableSlot.slot}` : 'No slot available'}</strong>
              </p>

              <p className="astrix-card-detail">
                {nextAvailableSlot
                  ? 'An umbrella is docked and ready. Tap Borrow to open the lock.'
                  : 'All umbrellas are currently in use. Please check back soon.'}
                {nextAvailableSlot && <span className="astrix-tag-detail">Umbrella tag: {nextAvailableSlot.umbrella_id}</span>}
              </p>
            </section>

            {/* 4-Slot Visual Matrix */}
            <section className="astrix-slots-section" aria-label="Physical umbrella slots">
              <h2 className="astrix-section-label">Physical slots (1–4)</h2>

              <div className="astrix-slots-grid">
                {slotTiles}
              </div>
            </section>
          </div>
        ) : (
          /* ============================================================================ */
          /* STATE B: "WHEN RETURNING" (User has an active loan)                           */
          /* ============================================================================ */
          <div className="space-y-4">
            <section className={`astrix-availability-card ${loanOverdue ? 'astrix-overdue-card' : ''}`} aria-label="Your active umbrella loan">
              <div className="flex items-center justify-between gap-2">
                <span className="astrix-status-pill">Umbrella on loan</span>
                <span className="astrix-availability-count flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                  {loanOverdue ? 'Overdue' : 'Within 24 hours'}
                </span>
              </div>
              <p className="astrix-card-overline">Your borrowed umbrella</p>
              <p className="astrix-slot-callout">Return to <strong>Slot {activeLoan.slot ?? '?'}</strong></p>
              <div className="astrix-loan-timing">
                <div><span>Due back</span><strong>{formatStationDueTime(activeLoan.due_time)}</strong></div>
                <div><span>{loanTime?.overdue ? 'Overdue by' : 'Time left'}</span><strong>{loanTime?.text}</strong></div>
              </div>
              <p className="astrix-card-detail">
                Borrowed {getElapsedDuration(activeLoan.borrowed_time)}. At the station, tap Return and put the umbrella back in Slot {activeLoan.slot ?? '?'}.
                <span className="astrix-tag-detail">Umbrella tag: {activeLoan.umbrella_id}</span>
              </p>
            </section>
            <section className="astrix-slots-section" aria-label="Physical umbrella slots">
              <h2 className="astrix-section-label">Physical slots (1–4)</h2>
              <div className="astrix-slots-grid">{slotTiles}</div>
            </section>
          </div>
        )}

        {/* ============================================================================== */}
        {/* CORE DUAL BUTTONS (Standard Student Borrow vs Return Matrix)                   */}
        {/* ============================================================================== */}
        {!isDevAccount && (
          <div className="astrix-actions">
            {/* 1. Borrow Button */}
            <button
              type="button"
              onClick={() => handleBorrow()}
              disabled={Boolean(activeLoan) || !nextAvailableSlot || actionInProgress !== null || unlockCountdown !== null || cabinetOffline}
              className={`astrix-action astrix-action-primary ${unlockCountdown !== null ? 'astrix-action-waiting' : ''}`}
            >
              {unlockCountdown !== null ? (
                <>
                  <Unlock className="w-5 h-5 animate-bounce" />
                  <span>Take Umbrella {pendingSlot} from Slot {pendingSlot} ({unlockCountdown}s)</span>
                </>
              ) : actionInProgress === 'borrow' ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : !activeLoan ? (
                <>
                  <Unlock className="w-4 h-4" />
                  <span>{nextAvailableSlot ? 'Borrow Umbrella' : 'Borrow Umbrella (Unavailable)'}</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Borrow (1 Umbrella Limit Reached)</span>
                </>
              )}
            </button>

            {/* 2. Return Button */}
            <button
              type="button"
              onClick={handleReturn}
              disabled={!activeLoan || actionInProgress !== null || cabinetOffline}
              className="astrix-action astrix-action-secondary"
            >
              {actionInProgress === 'return' ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : activeLoan ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>Return Umbrella {activeLoan.slot ?? ''}</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Return (No Active Loan)</span>
                </>
              )}
            </button>
          </div>
        )}

        <ContactFooter className="mt-6 pb-1" />
      </main>

      {/* Persistent Bottom Nav */}
      <BottomNav />
    </div>
  );
}
