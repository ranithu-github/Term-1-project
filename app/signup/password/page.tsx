'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { Field, Notice, Spinner, StepBar, StepHeading, TopBar } from '@/components/ui';
import { clearSignup, readSignup } from '@/lib/signupState';
import { seedStationUser } from '@/lib/stationCache';

const MIN_PASSWORD = 8;

// Signup step 4: set a password; the account is created and the student is signed in
export default function SignupPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const s = readSignup();
    if (!s.index_no || !s.verification_token || !s.code) router.replace('/signup/details');
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const s = readSignup();
    setBusy(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: s.index_no, code: s.code, password, verification_token: s.verification_token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.message || 'We couldn’t create your account. Try again.');
        setBusy(false);
        return;
      }
      clearSignup();
      localStorage.setItem('astrix_user', JSON.stringify(json.user));
      seedStationUser(json.user);
      setDone(json.user?.username?.split(' ')[0] || '');
    } catch {
      setError('You’re offline. Connect to the internet and try again.');
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <div className="flex min-h-[100dvh] flex-col px-6 pb-[calc(var(--safe-bottom)+24px)] pt-[calc(var(--safe-top)+64px)]">
        <div className="flex flex-1 flex-col items-center text-center" role="status">
          <CheckCircle2 className="enter h-16 w-16 text-success" strokeWidth={1.75} aria-hidden="true" />
          <h1 className="enter enter-1 mt-5 text-[2rem] font-bold leading-tight tracking-[-0.025em]">You&apos;re ready to borrow{done ? `, ${done}` : ''}</h1>
          <p className="enter enter-2 mt-3 text-[1.0625rem] leading-relaxed text-ink-2">At the umbrella station, open ASTRIX and tap Borrow. Return it within 24 hours.</p>
        </div>
        <button type="button" className="btn btn-primary btn-lg w-full" onClick={() => router.replace('/dashboard')}>Go to home</button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar title="Create account" back={{ href: '/signup/details', label: 'Back to email code' }} />
      <form onSubmit={submit} className="flex flex-1 flex-col gap-6 px-6 pb-[calc(var(--safe-bottom)+24px)] pt-5" noValidate>
        <StepBar step={4} of={4} />
        <StepHeading step={4} of={4} title="Set your password">You&apos;ll use it with your index number to sign in.</StepHeading>
        <Field
          label="Password"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters. A password manager suggestion works too.`}
          autoFocus
          trailing={
            <button type="button" onClick={() => setShow(!show)} className="btn btn-plain h-11 w-11 min-h-0 rounded-full p-0 text-ink-2" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
              {show ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
            </button>
          }
        />
        {error && <Notice tone="danger" title={error} live="assertive" />}
        <button type="submit" className="btn btn-primary btn-lg mt-auto w-full" disabled={busy || password.trim().length < MIN_PASSWORD}>
          {busy ? <><Spinner className="h-5 w-5" /> Creating account…</> : 'Create account'}
        </button>
      </form>
    </div>
  );
}
