import { ArrowLeft } from 'lucide-react';

// Shared pieces for the blue-header auth pages (signup steps)

export const authInputClass =
  'w-full px-4 py-3.5 rounded-xl bg-brand-50 border border-brand-100 text-base text-brand-900 placeholder-brand-300 focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-4 focus:ring-brand-100 transition disabled:opacity-60';

// Three short bars showing progress through signup
export function StepBars({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 w-6 rounded-full ${n <= current ? 'bg-white' : 'bg-white/25'}`} />
        ))}
      </div>
      <span className="text-xs font-medium text-brand-100 whitespace-nowrap">Step {current} of 3</span>
    </div>
  );
}

// Blue band with step bars, an optional back button and a two-line headline
export function AuthHeader({
  step,
  lines,
  note,
  onBack,
}: {
  step: 1 | 2 | 3;
  lines: [string, string];
  note?: string;
  onBack?: () => void;
}) {
  return (
    <div className="relative px-7 pt-8 pb-20 text-white overflow-hidden">
      <div className="absolute -top-24 -right-20 w-72 h-72 rounded-full bg-white/[0.07]" aria-hidden="true" />

      <div className="relative flex items-center justify-between">
        <StepBars current={step} />
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="w-9 h-9 -mr-2 rounded-full hover:bg-white/15 flex items-center justify-center transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
      </div>

      <h1 className="relative mt-14 font-display text-[44px] leading-[1.02] font-semibold">
        {lines[0]}
        <br />
        {lines[1]}
      </h1>
      {note && <p className="relative mt-3 text-sm text-brand-100">{note}</p>}
    </div>
  );
}
