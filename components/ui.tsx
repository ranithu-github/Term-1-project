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

/** The ASTRIX umbrella mark (original artwork) */
export function Mark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="rgb(var(--navy))" />
      <path d="M12 33c1.6-10.4 9.8-17.5 20-17.5S50.4 22.6 52 33c-2.6-2.4-5.6-3.6-8.9-3.6-3.2 0-6 1.2-8.4 3.4-2.3-2.2-5.1-3.4-8.3-3.4-3.3 0-6.3 1.2-8.9 3.6-1.4-1.3-3.2-2.1-5.5-2.1z" fill="#fff" />
      <path d="M32 15.5V12" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 33v13.5a4.5 4.5 0 0 1-9 0" fill="none" stroke="#8FB2F0" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

/** Sticky glass top bar: optional back link, a title, and a right-hand slot */
export function TopBar({ title, back, right }: { title?: ReactNode; back?: { href: string; label: string } | { onClick: () => void; label: string }; right?: ReactNode }) {
  return (
    <header className="glass sticky top-0 z-30 flex h-14 items-center gap-1 rounded-none border-x-0 border-t-0 px-2 pt-[var(--safe-top)]" style={{ boxShadow: 'inset 0 -0.5px 0 rgb(var(--line) / 0.12)' }}>
      <div className="flex w-12 justify-start">
        {back &&
          ('href' in back ? (
            <Link href={back.href} aria-label={back.label} className="btn btn-plain h-11 w-11 min-h-0 rounded-full p-0">
              <ChevronLeft className="h-6 w-6" strokeWidth={2.25} aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" onClick={back.onClick} aria-label={back.label} className="btn btn-plain h-11 w-11 min-h-0 rounded-full p-0">
              <ChevronLeft className="h-6 w-6" strokeWidth={2.25} aria-hidden="true" />
            </button>
          ))}
      </div>
      <div className="min-w-0 flex-1 text-center text-[1.0625rem] font-semibold">{title}</div>
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
    <nav aria-label="Main" className="pointer-events-none sticky bottom-0 z-30 mt-auto flex justify-center px-6 pb-[calc(var(--safe-bottom)+12px)] pt-2">
      <div className="glass pointer-events-auto flex gap-1 rounded-full p-1.5">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = path === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex h-12 min-w-[108px] items-center justify-center gap-2 rounded-full px-4 text-[0.9375rem] font-semibold transition-[background-color,color] duration-150 ease-out ${
                active ? 'bg-navy text-white' : 'text-ink-2'
              }`}
            >
              <Icon className="h-[19px] w-[19px]" strokeWidth={active ? 2.25 : 2} aria-hidden="true" />
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
      <div className="glass flex flex-col gap-2 rounded-[26px] p-2">{children}</div>
    </div>
  );
}

type Tone = 'info' | 'success' | 'caution' | 'danger';
const TONES: Record<Tone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: 'bg-sky text-ink', icon: Info, iconClass: 'text-blue' },
  success: { box: 'bg-success-bg text-ink', icon: CheckCircle2, iconClass: 'text-success' },
  caution: { box: 'bg-caution-bg text-ink', icon: TriangleAlert, iconClass: 'text-caution' },
  danger: { box: 'bg-danger-bg text-ink', icon: AlertCircle, iconClass: 'text-danger' },
};

/** What happened → what to do. Persistent, never a toast. */
export function Notice({ tone = 'info', title, children, action, live = 'polite', className = '' }: {
  tone?: Tone; title: ReactNode; children?: ReactNode; action?: ReactNode; live?: 'polite' | 'assertive' | 'off'; className?: string;
}) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div role={live === 'assertive' ? 'alert' : 'status'} aria-live={live === 'off' ? undefined : live} className={`rounded-md p-4 ${t.box} ${className}`}>
      <div className="flex gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${t.iconClass}`} strokeWidth={2.25} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">{title}</p>
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
      {step && of && <p className="text-sm font-semibold text-blue">Step {step} of {of}</p>}
      <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.02em]" tabIndex={-1}>{title}</h1>
      {children && <p className="mt-2 text-[1.0625rem] leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}

/** Thin progress bar for the 4 signup steps */
export function StepBar({ step, of }: { step: number; of: number }) {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      {Array.from({ length: of }, (_, k) => (
        <span key={k} className={`h-1 flex-1 rounded-full transition-[background-color] duration-300 ease-out ${k < step ? 'bg-blue' : 'bg-ink/10'}`} />
      ))}
    </div>
  );
}
