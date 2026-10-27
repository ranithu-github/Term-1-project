'use client';

import { useState } from 'react';
import { Lock, Unlock, Wrench } from 'lucide-react';
import { Notice, Spinner, TabBar } from '@/components/ui';
import type { MeResponse } from '@/lib/types';

type Act = 'borrow' | 'return' | 'OPEN' | 'CLOSE';

/**
 * Hardware testing console for developer accounts (DEV_INDEXES). Sends cabinet
 * commands to any slot; no loans are recorded. Every command is in the activity log.
 */
export function DevConsole({ me, refresh }: { me: MeResponse; refresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<Record<number, Act | null>>({});
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (slot: number, act: Act) => {
    setBusy((b) => ({ ...b, [slot]: act }));
    const url = act === 'borrow' || act === 'return' ? `/api/${act}` : '/api/dev/lock';
    const body = act === 'borrow' || act === 'return' ? { slot } : { slot, action: act };
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      setLog({ ok: res.ok && json.success, text: `Slot ${slot} · ${act.toLowerCase()}: ${json.message || res.statusText}` });
    } catch {
      setLog({ ok: false, text: `Slot ${slot}: couldn’t reach the server.` });
    } finally {
      setBusy((b) => ({ ...b, [slot]: null }));
      void refresh();
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <main className="flex flex-1 flex-col gap-4 px-4 pb-6 pt-[calc(var(--safe-top)+20px)]">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-blue"><Wrench className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" /> Hardware testing</p>
          <h1 className="mt-1 text-[1.75rem] font-bold tracking-[-0.02em]">Cabinet console</h1>
          <p className="mt-1 text-[0.9375rem] text-ink-2">Signed in as {me.user.index_no}. Commands go straight to the cabinet; no loans are recorded, and every command is logged.</p>
        </div>

        {log && <Notice tone={log.ok ? 'success' : 'danger'} title={log.text} />}

        <div className="grid grid-cols-2 gap-3">
          {me.slots.map((s) => (
            <section key={s.slot} className="card p-3" aria-label={`Slot ${s.slot}`}>
              <div className="flex items-center justify-between px-1">
                <span className="num text-lg font-bold">Slot {s.slot}</span>
                <span className={`pill ${s.availability ? 'pill-ok' : 'pill-quiet'}`}>{s.availability ? 'Docked' : 'Out'}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {(['borrow', 'return', 'OPEN', 'CLOSE'] as Act[]).map((act) => (
                  <button
                    key={act}
                    type="button"
                    disabled={!!busy[s.slot]}
                    onClick={() => send(s.slot, act)}
                    className={`btn min-h-[44px] px-2 text-[0.875rem] ${act === 'borrow' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    {busy[s.slot] === act ? <Spinner className="h-4 w-4" /> : act === 'OPEN' ? <Unlock className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" /> : act === 'CLOSE' ? <Lock className="h-4 w-4" strokeWidth={2.25} aria-hidden="true" /> : null}
                    {act === 'borrow' ? 'Borrow' : act === 'return' ? 'Return' : act === 'OPEN' ? 'Open' : 'Close'}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
      <TabBar />
    </div>
  );
}
