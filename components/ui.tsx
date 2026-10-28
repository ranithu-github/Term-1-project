'use client';

import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronLeft, Home, Info, TriangleAlert, User } from 'lucide-react';
import { usePathname } from 'next/navigation';

// =====================================================================
// ASTRIX UI kit. Tokens live in app/globals.css; everything here is
// built from them so every screen looks and behaves the same.
// =====================================================================

export function Spinner({ className = 'h-5 w-5', label }: { className?: string; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex">
      <svg className={`${className} motion-safe:animate-[spin_0.8s_linear_infinite]`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/** The ASTRIX mark: the rendered umbrella on a glass tile */
export function Mark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[30%] bg-white/70 shadow-[inset_0_1px_0_#fff,0_6px_14px_-6px_rgb(30_45_90/0.35)] ${className}`}>
      <img src="/brand/umbrella-open.webp" alt="" draggable={false} className="asset w-[86%] -rotate-6" />
    </span>
  );
}

/** A frosted round icon button (back, torch) */
export const roundBtn = 'glass flex h-11 w-11 min-h-0 items-center justify-center rounded-full p-0 text-ink transition-[scale] duration-150 ease-out active:scale-[0.96]';

/** Top bar over the sky: a frosted round back button, a title, and a right-hand slot */
export function TopBar({ title, back, right }: { title?: ReactNode; back?: { href: string; label: string } | { onClick: () => void; label: string }; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-[60px] items-center gap-1 px-4 pt-[var(--safe-top)]">
      <div className="flex w-12 justify-start">
        {back &&
          ('href' in back ? (
            <Link href={back.href} aria-label={back.label} className={roundBtn}>
              <ChevronLeft className="h-5 w-5" strokeWidth={2.5} aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" onClick={back.onClick} aria-label={back.label} className={roundBtn}>
              <ChevronLeft className="h-5 w-5" strokeWidth={2.5} aria-hidden="true" />
            </button>
          ))}
      </div>
      <div className="min-w-0 flex-1 text-center text-[1rem] font-semibold tracking-[-0.01em]">{title}</div>
      <div className="flex w-12 justify-end">{right}</div>
    </header>
  );
}

/** Floating glass tab bar: Home and Profile */
export function TabBar() {
  const path = usePathname();
  const tabs = [
    { href: '/dashboard', label: 'Home', icon: Home },
    { href: '/profile', label: 'Profile', icon: User },
  ];
  return (
    <nav aria-label="Main" className="pointer-events-none sticky bottom-0 z-30 mt-auto px-4 pb-[calc(var(--safe-bottom)+12px)] pt-2">
      <div className="glass pointer-events-auto flex gap-1 rounded-full p-1.5">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = path === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[0.75rem] font-semibold transition-[background-color,color] duration-150 ease-out ${
                active ? 'bg-white/80 text-ink shadow-[inset_0_1px_0_#fff,0_2px_8px_-2px_rgb(30_45_90/0.18)]' : 'text-ink-3'
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 2} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** A glass dock pinned to the bottom of the screen for the screen's main action(s) */
export function ActionDock({ children, aboveTabBar = false }: { children: ReactNode; aboveTabBar?: boolean }) {
  return (
    <div className={`sticky z-20 px-4 ${aboveTabBar ? 'bottom-[calc(var(--safe-bottom)+84px)]' : 'bottom-0 pb-[calc(var(--safe-bottom)+16px)]'} pt-3`}>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

type Tone = 'info' | 'success' | 'caution' | 'danger';
const TONES: Record<Tone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: 'bg-white/60', icon: Info, iconClass: 'text-blue bg-blue/10' },
  success: { box: 'bg-white/60', icon: CheckCircle2, iconClass: 'text-success bg-success/10' },
  caution: { box: 'bg-[#FFF6EF]/80', icon: TriangleAlert, iconClass: 'text-caution bg-caution/10' },
  danger: { box: 'bg-[#FFF3F1]/85', icon: AlertCircle, iconClass: 'text-danger bg-danger/10' },
};

/** What happened → what to do. Persistent, never a toast. */
export function Notice({ tone = 'info', title, children, action, live = 'polite', className = '' }: {
  tone?: Tone; title: ReactNode; children?: ReactNode; action?: ReactNode; live?: 'polite' | 'assertive' | 'off'; className?: string;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div role={live === 'assertive' ? 'alert' : 'status'} aria-live={live === 'off' ? undefined : live} className={`rounded-[22px] p-4 text-ink shadow-[inset_0_1px_0_#fff,inset_0_0_0_1px_rgb(255_255_255/0.4),0_10px_28px_-14px_rgb(30_45_90/0.25)] backdrop-blur-xl ${t.box} ${className}`}>
      <div className="flex gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] ${t.iconClass}`} aria-hidden="true"><Icon className="h-5 w-5" strokeWidth={2.25} /></span>
        <div className="min-w-0 flex-1">
          <p className="pt-1.5 font-semibold leading-snug">{title}</p>
          {children && <div className="mt-1 text-[0.9375rem] leading-relaxed text-ink-2">{children}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/** Labeled text field with hint and error wired up for screen readers */
export function Field({ label, hint, error, trailing, ...input }: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string; hint?: ReactNode; error?: string | null; trailing?: ReactNode;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="relative">
        <input id={id} className={`field ${trailing ? 'pr-14' : ''}`} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {hint && !error && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="field-error">
          <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One field for a 6-digit email code: the phone can fill it from the email,
 * pasting the whole code works, and it reads as six spaced digits.
 */
export function CodeField({ value, onChange, error, label = 'Verification code', autoFocus }: {
  value: string; onChange: (v: string) => void; error?: string | null; label?: string; autoFocus?: boolean;
}) {
  return (
    <Field
      label={label}
      error={error}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="123456"
      autoFocus={autoFocus}
      className="field num text-center text-[1.75rem] font-semibold tracking-[0.5em] placeholder:tracking-[0.5em]"
      style={{ textIndent: '0.5em' }}
    />
  );
}

/** Signup/reset step header: "Step 2 of 4", a title and a short line */
export function StepHeading({ step, of, title, children }: { step?: number; of?: number; title: string; children?: ReactNode }) {
  return (
    <div className="enter">
      {step && of && <p className="text-[0.8125rem] font-semibold tracking-[0.02em] text-ink-3">Step {step} of {of}</p>}
      <h1 className="mt-1.5 text-[2.125rem] font-semibold leading-[1.06] tracking-[-0.035em]" tabIndex={-1}>{title}</h1>
      {children && <p className="mt-3 text-[1.0625rem] leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}

/** Thin progress bar for the 4 signup steps */
export function StepBar({ step, of }: { step: number; of: number }) {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      {Array.from({ length: of }, (_, k) => (
        <span key={k} className={`h-1 flex-1 rounded-full transition-[background-color] duration-300 ease-out ${k < step ? 'bg-ink' : 'bg-ink/[0.12]'}`} />
      ))}
    </div>
  );
}
