// Shared pieces for the blue-header auth pages (signup steps)

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
