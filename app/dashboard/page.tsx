'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Umbrella,
  Lock,
  Unlock,
  CheckCircle2,
  RefreshCw,
  Wrench,
  AlertCircle,
  Info,
  X,
  WifiOff,
} from 'lucide-react';
import { BottomNav } from '@/components/BottomNav';
import type { MeResponse, PublicSlot } from '@/lib/types';
import { useViewMode } from '@/components/ViewModeContext';

// The lock takes ~4 s to open (message delivery + 2.7 s servo turn); the countdown
// starts after that. Then the cabinet gives the student 5 checks × ~2.5 s.
const OPENING_MS = 4000;
const TAKE_WINDOW_SECONDS = 12;

interface AssignedSlot {
  slot: number;
  umbrella_number: number;
  umbrella_id: string;
}

/**
 * Reads a cabinet API response. Student borrows stream NDJSON: an "assigned" line
 * (which slot this student got) as soon as the slot is reserved, then a "result"
 * line when the cabinet answers. Everything else is a single JSON body.
 */
async function readCabinetResponse(
  res: Response,
  onAssigned: (assigned: AssignedSlot) => void
): Promise<{ success?: boolean; message?: string; reason?: string; slot?: number }> {
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
      message: 'The connection to the station was lost before the cabinet answered. Check the dashboard in a moment.',
    }
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { isStudentMode } = useViewMode();
  const [currentUserIndex, setCurrentUserIndex] = useState('');
  const [currentUserName, setCurrentUserName] = useState('');

  // Developer (hardware testing) access is decided by the server
  const [isDevAccount, setIsDevAccount] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Cabinet online/offline from the server (null = not known yet)
  const [cabinetOnline, setCabinetOnline] = useState<boolean | null>(null);
  const cabinetOffline = cabinetOnline === false;

  // Slot states from the server (no placeholder tag IDs)
  const [slots, setSlots] = useState<PublicSlot[]>([]);

  // Active borrow state (Determines State A vs State B)
  const [activeLoan, setActiveLoan] = useState<{
    record_id?: string;
    umbrella_id: string;
    slot: number | null;
    borrowed_time: string;
    is_overdue?: boolean;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<'borrow' | 'return' | null>(null);
  const [unlockCountdown, setUnlockCountdown] = useState<number | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
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

  // Show the cached name instantly while the server confirms the session
  useEffect(() => {
    try {
      const raw = localStorage.getItem('astrix_user');
      if (raw) {
        const parsed = JSON.parse(raw);
        setCurrentUserIndex((parsed.index_no || '').toUpperCase());
        setCurrentUserName(parsed.username || 'Student');
      }
    } catch {}
  }, []);

  // Fetch profile, slots and active loan from the server (session cookie)
  const refreshStationData = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });

      if (res.status === 401) {
        localStorage.removeItem('astrix_user');
        sessionStorage.clear();
        router.replace('/login?notice=session_expired');
        return;
      }

      const json: MeResponse = await res.json();
      if (!res.ok || !json.success) return;

      setCurrentUserIndex(json.user.index_no);
      setCurrentUserName(json.user.username || 'Student');
      setIsDevAccount(json.is_dev);
      setIsAdmin(json.is_admin);
      setCabinetOnline(json.cabinet_online);
      setSlots(json.slots);
      setActiveLoan(json.active_loan);
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

  // Format elapsed time for State B ("Since when")
  const getElapsedDuration = (isoString?: string) => {
    if (!isoString) return 'Just now';
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
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
        if (remaining > 0) setUnlockCountdown(remaining);
        else stopCountdown();
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
    setActionInProgress(kind);
    setScreenGlow(kind === 'borrow' ? 'green' : 'blue');
    setPendingSlot(kind === 'borrow' ? null : slotHint);
    setNotification({
      type: 'info',
      text:
        kind === 'borrow'
          ? 'Finding a free slot...'
          : `Opening ${slotHint ? `slot ${slotHint}` : 'your slot'}. Dock the umbrella and wait for the lock.`,
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
          text: `Take umbrella ${assigned.umbrella_number} from slot ${assigned.slot}.`,
        });
        startTakeCountdown();
      });

      if (json.success) {
        setScreenGlow(null);
        setNotification({ type: 'success', text: json.message || 'Done.' });
      } else if (json.reason === 'WRONG_UMBRELLA') {
        triggerErrorGlow();
        setNotification({
          type: 'error',
          text: `Wrong umbrella in slot ${json.slot}. Take it out and return your own.`,
        });
      } else {
        triggerErrorGlow();
        setNotification({ type: 'error', text: json.message || 'Something went wrong. Please try again.' });
      }
    } catch {
      triggerErrorGlow();
      setNotification({ type: 'error', text: "Can't reach the station. Check your connection." });
    } finally {
      stopCountdown();
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
      text: `🔓 [Slot #${slot}] Sending Borrow command to cabinet…`,
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
      text: `🔒 [Slot #${slot}] Sending Return command to cabinet…`,
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
      setNotification({ type: 'error', text: 'No umbrellas free right now.' });
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
      setActiveLoan({
        umbrella_id: slot1.umbrella_id,
        slot: slot1.slot,
        borrowed_time: new Date(Date.now() - 24 * 60 * 1000).toISOString(), // 24 mins ago
      });
      setNotification({ type: 'info', text: 'Switched to State B (Returning View).' });
    }
  };

  const freeCount = availableSlotsList.length;
  const headline: [string, string] = isDevAccount
    ? ['Hardware', 'console.']
    : activeLoan
    ? ['Return your', 'umbrella.']
    : freeCount > 0
    ? [`${freeCount} umbrella${freeCount === 1 ? '' : 's'}`, 'ready.']
    : ['No umbrellas', 'right now.'];

  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none relative">
      {/* Thin status bar while the cabinet is working, or after an error */}
      {screenGlow && (
        <div
          className={`fixed top-0 inset-x-0 max-w-md mx-auto h-1 z-50 ${
            screenGlow === 'green' ? 'bg-emerald-400 animate-pulse' : screenGlow === 'blue' ? 'bg-white animate-pulse' : 'bg-rose-500'
          }`}
          aria-hidden="true"
        />
      )}

      {/* Blue header band */}
      <div className="relative px-7 pt-8 pb-20 text-white overflow-hidden">
        <div className="absolute -top-24 -right-20 w-72 h-72 rounded-full bg-white/[0.07]" aria-hidden="true" />

        <div className="relative flex items-center justify-between min-h-9">
          <span className="text-sm text-brand-100 truncate">
            Hi, <span className="font-semibold text-white">{currentUserName || 'there'}</span>
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isAdmin && (
              <Link
                href="/admin"
                className="text-xs font-semibold bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-full transition"
              >
                Admin
              </Link>
            )}
            {/* Interactive State Toggle (Visible in Dev Mode) */}
            {!isStudentMode && (
              <button
                type="button"
                onClick={toggleDemoState}
                className="text-xs font-semibold bg-white/15 hover:bg-white/25 px-3 py-1.5 rounded-full transition"
                title="Toggle between State A and State B"
              >
                {activeLoan ? 'State A' : 'State B'}
              </button>
            )}
            <button
              type="button"
              onClick={refreshStationData}
              aria-label="Refresh"
              className="w-9 h-9 -mr-2 rounded-full hover:bg-white/15 flex items-center justify-center transition"
            >
              <RefreshCw className={`w-[18px] h-[18px] ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <h1 className="relative mt-14 font-display text-[44px] leading-[1.02] font-semibold">
          {headline[0]}
          <br />
          {headline[1]}
        </h1>
      </div>

      {/* White sheet */}
      <div className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-9 pb-8 space-y-5">
        {/* Cabinet Offline Banner */}
        {cabinetOffline && (
          <p className="px-4 py-3 rounded-xl bg-slate-100 text-slate-700 text-sm flex items-center gap-2" role="status">
            <WifiOff className="w-4 h-4 shrink-0 text-slate-500" />
            <span>Cabinet offline. Borrowing is paused.</span>
          </p>
        )}

        {/* Notifications & Hardware Feedback */}
        {notification && (
          <div
            className={`px-4 py-3 rounded-xl text-sm flex items-start gap-2 ${
              notification.type === 'success'
                ? 'bg-emerald-50 text-emerald-800'
                : notification.type === 'error'
                ? 'bg-rose-50 text-rose-800'
                : 'bg-brand-50 text-brand-900'
            }`}
          >
            {notification.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />}
            {notification.type === 'error' && <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />}
            {notification.type === 'info' && <Info className="w-4 h-4 shrink-0 mt-0.5 text-brand-500" />}
            <span className="flex-1">{notification.text}</span>
            <button
              type="button"
              onClick={dismissNotification}
              aria-label="Dismiss"
              className="p-1 -m-1 opacity-50 hover:opacity-100 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

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
                <p className="text-xs text-purple-200 font-medium">Cabinet Hardware Control</p>
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
                  Cabinet Slots (1 - 4) Hardware Controls
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
                        {s.availability ? 'Docked' : 'Empty'}
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
          /* STATE A: ready to borrow */
          <>
            {/* Assigned slot: which umbrella THIS student must take */}
            {actionInProgress === 'borrow' && (
              <div className="rounded-2xl bg-brand-600 text-white p-5 text-center" aria-live="polite">
                {pendingSlot ? (
                  <>
                    <p className="text-sm text-brand-100">Take your umbrella from</p>
                    <p className="mt-1 font-display text-5xl font-semibold">Slot {pendingSlot}</p>
                    <p className="mt-2 text-sm text-brand-100">
                      {unlockCountdown !== null ? `${unlockCountdown}s left` : 'Opening the lock...'}
                    </p>
                  </>
                ) : (
                  <p className="py-3 text-sm">Finding a free slot...</p>
                )}
              </div>
            )}

            {/* Slots */}
            <div className="space-y-3">
              <p className="text-sm font-semibold text-brand-900">Slots</p>
              <div className="grid grid-cols-4 gap-2">
                {slots.map((s) => {
                  // While borrowing, highlight the slot the server gave this student
                  const isMine = actionInProgress === 'borrow' && pendingSlot === s.slot;
                  const isNext = actionInProgress === 'borrow' ? isMine : nextAvailableSlot?.slot === s.slot;
                  return (
                    <div
                      key={s.slot}
                      className={`rounded-xl py-3 text-center border transition ${
                        isNext
                          ? 'border-brand-500 bg-brand-50'
                          : s.availability
                          ? 'border-brand-100 bg-white'
                          : 'border-transparent bg-slate-50'
                      }`}
                    >
                      <p className={`text-lg font-semibold ${s.availability ? 'text-brand-900' : 'text-slate-300'}`}>
                        {s.slot}
                      </p>
                      <p
                        className={`mt-0.5 text-xs ${
                          isNext ? 'font-semibold text-brand-600' : s.availability ? 'text-slate-500' : 'text-slate-400'
                        }`}
                      >
                        {isMine ? 'Yours' : s.availability ? 'Ready' : 'Out'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          /* STATE B: has an active loan */
          <div className="rounded-2xl bg-brand-50 divide-y divide-brand-100 text-sm">
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-slate-500">Umbrella</span>
              <span className="font-semibold tracking-wider text-brand-900">{activeLoan.umbrella_id}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-slate-500">Borrowed</span>
              <span className="font-semibold text-brand-900">{getElapsedDuration(activeLoan.borrowed_time)}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-slate-500">Return to</span>
              <span className="font-semibold text-brand-900">Slot {activeLoan.slot ?? '?'}</span>
            </div>
            {activeLoan.is_overdue && (
              <p className="px-4 py-3.5 font-medium text-rose-700">Overdue. Please return it soon.</p>
            )}
          </div>
        )}

        {/* One main action: borrow, or return when there is an active loan */}
        {!isDevAccount &&
          (activeLoan ? (
            <button
              type="button"
              onClick={handleReturn}
              disabled={actionInProgress !== null || cabinetOffline}
              className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
            >
              {actionInProgress === 'return' ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Return umbrella</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleBorrow()}
              disabled={!nextAvailableSlot || actionInProgress !== null || unlockCountdown !== null || cabinetOffline}
              className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
            >
              {unlockCountdown !== null ? (
                <>
                  <Unlock className="w-4 h-4" />
                  <span>
                    Take it from slot {pendingSlot} · {unlockCountdown}s
                  </span>
                </>
              ) : actionInProgress === 'borrow' ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Unlock className="w-4 h-4" />
                  <span>{nextAvailableSlot ? 'Borrow umbrella' : 'None free'}</span>
                </>
              )}
            </button>
          ))}
      </div>

      {/* Persistent Bottom Nav */}
      <BottomNav />
    </div>
  );
}
