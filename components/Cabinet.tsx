import { Umbrella } from 'lucide-react';

export type BayState = 'ready' | 'out' | 'target' | 'home';

/**
 * The four-slot cabinet. The bay that matters is marked by an outline, a label
 * and its number, never by color alone. Other bays are context, not choices.
 * (Shown as a row of four; match it to the real cabinet's layout if that differs.)
 */
export function Cabinet({ bays, targetLabel = 'Open', compact = false }: {
  bays: { slot: number; state: BayState }[];
  targetLabel?: string;
  compact?: boolean;
}) {
  const summary = bays
    .map((b) => `Slot ${b.slot}: ${b.state === 'target' || b.state === 'home' ? targetLabel.toLowerCase() : b.state === 'ready' ? 'umbrella ready' : 'empty'}`)
    .join(', ');
  return (
    <div role="img" aria-label={`Umbrella cabinet. ${summary}.`} className="rounded-[20px] bg-navy/[0.06] p-2">
      <div className="grid grid-cols-4 gap-2">
        {bays.map((b) => {
          const marked = b.state === 'target' || b.state === 'home';
          const docked = b.state === 'ready' || b.state === 'target';
          return (
            <div
              key={b.slot}
              className={`relative flex flex-col items-center justify-between rounded-[12px] bg-card py-2.5 transition-[box-shadow] duration-200 ease-out ${compact ? 'h-[76px]' : 'h-[104px]'} ${
                marked ? 'shadow-[0_0_0_2.5px_rgb(var(--blue)),0_6px_16px_rgb(36_87_197/0.25)]' : 'shadow-[0_1px_2px_rgb(16_35_64/0.06)]'
              }`}
            >
              <span className={`num text-[0.8125rem] font-bold ${marked ? 'text-blue' : 'text-ink-2'}`}>{b.slot}</span>
              {docked ? (
                <Umbrella className={`${compact ? 'h-6 w-6' : 'h-7 w-7'} ${marked ? 'text-blue' : 'text-ink'}`} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <span className={`${compact ? 'h-6 w-6' : 'h-7 w-7'} rounded-full border-2 border-dashed border-ink/20`} aria-hidden="true" />
              )}
              <span className={`text-[0.6875rem] font-semibold uppercase tracking-[0.04em] ${marked ? 'text-blue' : 'text-ink-3'}`}>
                {marked ? targetLabel : docked ? 'Ready' : 'Out'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The giant slot number students look for at the cabinet */
export function SlotNumeral({ slot }: { slot: number }) {
  return (
    <div className="flex items-baseline justify-center gap-3" aria-hidden="true">
      <span className="text-[0.9375rem] font-semibold uppercase tracking-[0.12em] text-ink-2">Slot</span>
      <span className="num text-[5.5rem] font-bold leading-none tracking-[-0.04em] text-navy">{slot}</span>
    </div>
  );
}
