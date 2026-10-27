'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// =====================================================================
// One borrow or return, from tap to verified result.
//
//   requesting → opening (slot known) → take / insert (lock open) → checking → done
//                                                               ↘ uncertain (no answer)
//
// The take window starts when the cabinet confirms it got the command
// (the server streams "opened"), never on a local guess; and the result
// shown is always the cabinet's own answer.
// =====================================================================

export type CabinetKind = 'borrow' | 'return';

export interface CabinetResult {
  success?: boolean;
  uncertain?: boolean;
  message?: string;
  reason?: 'NOT_TAKEN' | 'NO_UMBRELLA' | 'WRONG_UMBRELLA' | string;
  slot?: number;
  due_time?: string;
  duration?: string;
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'requesting'; action: CabinetKind }
  | { kind: 'opening'; action: CabinetKind; slot: number }
  | { kind: 'take'; slot: number; endsAt: number }
  | { kind: 'insert'; slot: number }
  | { kind: 'checking'; action: CabinetKind; slot: number }
  | { kind: 'done'; action: CabinetKind; slot: number | null; result: CabinetResult }
  | { kind: 'uncertain'; action: CabinetKind; slot: number | null };

// The servo takes ~3 s to open; then the cabinet checks for ~12 s with the lock open
const LOCK_OPENING_MS = 3000;
const TAKE_WINDOW_MS = 12000;

function buzz(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // vibration is a progressive enhancement only
  }
}

export function useCabinetAction(onSettled: () => void) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const running = useRef(false);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const run = useCallback(
    async (action: CabinetKind) => {
      if (running.current) return; // one at a time; the server enforces this too
      running.current = true;
      clearTimers();
      setPhase({ kind: 'requesting', action });
      let slot: number | null = null;

      try {
        const res = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let result: CabinetResult | null = null;

        if ((res.headers.get('content-type') || '').includes('application/x-ndjson') && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!result) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line) continue;
              const event = JSON.parse(line);
              if (event.type === 'assigned') {
                slot = event.slot;
                setPhase({ kind: 'opening', action, slot: event.slot });
              } else if (event.type === 'opened' && slot !== null) {
                const s = slot;
                buzz(30);
                if (action === 'borrow') {
                  timers.current.push(
                    setTimeout(() => setPhase({ kind: 'take', slot: s, endsAt: Date.now() + TAKE_WINDOW_MS }), LOCK_OPENING_MS),
                    setTimeout(() => setPhase((p) => (p.kind === 'take' ? { kind: 'checking', action, slot: s } : p)), LOCK_OPENING_MS + TAKE_WINDOW_MS)
                  );
                } else {
                  timers.current.push(setTimeout(() => setPhase({ kind: 'insert', slot: s }), LOCK_OPENING_MS));
                }
              } else if (event.type === 'result') {
                result = event;
              }
            }
          }
        } else {
          result = await res.json().catch(() => null);
        }

        clearTimers();
        if (!result) {
          // The connection dropped before the cabinet answered: find out from the server
          setPhase({ kind: 'uncertain', action, slot });
        } else if (result.uncertain) {
          setPhase({ kind: 'uncertain', action, slot: result.slot ?? slot });
        } else {
          if (result.success) buzz(40);
          setPhase({ kind: 'done', action, slot: result.slot ?? slot, result });
        }
      } catch {
        clearTimers();
        setPhase(slot !== null ? { kind: 'uncertain', action, slot } : { kind: 'done', action, slot: null, result: { success: false, message: 'NETWORK' } });
      } finally {
        running.current = false;
        onSettled();
      }
    },
    [onSettled]
  );

  const reset = useCallback(() => {
    clearTimers();
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, setPhase, run, reset, busy: phase.kind !== 'idle' && phase.kind !== 'done' && phase.kind !== 'uncertain' };
}
