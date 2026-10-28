export type BayState = 'ready' | 'out' | 'target' | 'home';

/** The folded umbrella render (public/brand). Decorative: the cabinet carries the words. */
export function FoldedUmbrella({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <img src="/brand/umbrella-closed.webp" alt="" aria-hidden="true" draggable={false} className={`asset ${className}`} style={style} />
  );
}

/**
 * The four-slot glass cabinet. The bay that matters is marked by an outline, a label
 * and its number, never by color alone. Other bays are context, not choices.
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
    <div
      role="img"
      aria-label={`Umbrella cabinet. ${summary}.`}
      className="rounded-[26px] bg-gradient-to-b from-white/55 to-white/25 p-2 shadow-[inset_0_1px_0_#fff,inset_0_0_0_1px_rgb(255_255_255/0.45)]"
    >
      <div className="grid grid-cols-4 gap-2">
        {bays.map((b) => {
          const marked = b.state === 'target' || b.state === 'home';
          const docked = b.state === 'ready' || (b.state === 'target' && !compact);
          return (
            <div
              key={b.slot}
              className={`relative overflow-hidden rounded-[18px] transition-[box-shadow,background-color] duration-200 ease-out ${compact ? 'h-[78px]' : 'h-[172px]'} ${
                marked
                  ? 'bg-gradient-to-b from-blue/20 to-blue-2/10 shadow-[inset_0_0_0_2px_rgb(var(--blue)),0_0_30px_-6px_rgb(61_90_254/0.6)]'
                  : b.state === 'out'
                    ? 'bg-[repeating-linear-gradient(180deg,rgb(255_255_255/0.16)_0_10px,rgb(255_255_255/0.32)_10px_20px)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.6)]'
                    : 'bg-gradient-to-b from-[#D6DFF0]/60 to-white/65 shadow-[inset_0_2px_10px_rgb(30_45_90/0.16),inset_0_0_0_1px_rgb(255_255_255/0.7)]'
              }`}
            >
              {!compact && <span className={`num absolute left-1/2 top-2 -translate-x-1/2 text-[0.8125rem] font-bold ${marked ? 'text-blue' : 'text-ink-2'}`}>{b.slot}</span>}
              {docked && (
                <FoldedUmbrella
                  className="absolute left-1/2 -translate-x-1/2 drop-shadow-[0_8px_10px_rgb(30_45_90/0.28)]"
                  style={compact ? { height: 34, bottom: 28 } : { height: 108, bottom: 34 }}
                />
              )}
              <span
                className={`absolute inset-x-0 flex items-center justify-center gap-1.5 font-semibold ${compact ? 'bottom-2 text-[0.8125rem]' : 'bottom-2.5 text-[0.75rem]'} ${
                  marked ? 'text-blue' : docked ? 'text-ink' : 'text-ink-3'
                }`}
              >
                {compact ? (
                  marked ? targetLabel : <span className="num">{b.slot}</span>
                ) : (
                  <>
                    <span className={`h-1.5 w-1.5 rounded-full ${marked ? 'bg-blue' : docked ? 'bg-success' : 'bg-ink/25'}`} aria-hidden="true" />
                    {marked ? targetLabel : docked ? 'Ready' : 'Out'}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The slot number students look for at the cabinet: a dark badge */
export function SlotBadge({ slot, className = '' }: { slot: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`num flex h-16 w-16 items-center justify-center rounded-full bg-navy text-[2rem] font-semibold tracking-[-0.04em] text-white shadow-[0_12px_24px_-8px_rgb(11_22_38/0.6),inset_0_1px_0_rgb(255_255_255/0.2)] ${className}`}
    >
      {slot}
    </span>
  );
}

/** The giant slot number for result screens */
export function SlotNumeral({ slot }: { slot: number }) {
  return (
    <div className="flex items-baseline justify-center gap-3" aria-hidden="true">
      <span className="text-[0.9375rem] font-semibold uppercase tracking-[0.12em] text-ink-2">Slot</span>
      <span className="num text-[5.5rem] font-semibold leading-none tracking-[-0.05em] text-ink">{slot}</span>
    </div>
  );
}
