'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { CodeField, Field, Notice, Spinner, StepHeading, TopBar } from '@/components/ui';

const RESEND_AFTER_S = 30;
const MIN_PASSWORD = 8;

// Forgot password: 1. confirm the index number (a code is emailed), 2. code + new password
function ResetPassword() {
  const router = useRouter();
  const params = useSearchParams();
  const [indexNo, setIndexNo] = useState(params.get('index_no')?.toUpperCase() || '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: indexNo.trim().toUpperCase() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.message || 'We couldn’t send a code. Try again.');
      } else {
        setSentTo(json.masked_email || 'your email');
        setCode('');
        setResendIn(RESEND_AFTER_S);
      }
    } catch {
      setError('You’re offline. Connect to the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: indexNo.trim().toUpperCase(), code, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.message || 'That didn’t work. Check the code and try again.');
        setBusy(false);
        return;
      }
      router.replace(`/login?reset=success&index_no=${encodeURIComponent(indexNo.trim().toUpperCase())}`);
    } catch {
      setError('You’re offline. Connect to the internet and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar
        title="Reset password"
        back={sentTo ? { onClick: () => { setSentTo(null); setError(null); }, label: 'Back to index number' } : { href: '/login', label: 'Back to sign in' }}
      />
      <main className="flex flex-1 flex-col px-6 pb-[calc(var(--safe-bottom)+24px)] pt-6">
        {!sentTo ? (
          <form onSubmit={sendCode} className="flex flex-1 flex-col gap-6" noValidate>
            <StepHeading step={1} of={2} title="Forgot your password?">
              We&apos;ll email a 6-digit code to the address on your account.
            </StepHeading>
            <Field
              label="University index number"
              autoComplete="username"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="e.g. 250373T"
              value={indexNo}
              onChange={(e) => setIndexNo(e.target.value)}
              autoFocus={!indexNo}
            />
            {error && <Notice tone="danger" title={error} live="assertive" />}
            <button type="submit" className="btn btn-primary btn-lg mt-auto w-full" disabled={busy || !indexNo.trim()}>
              {busy ? <><Spinner className="h-5 w-5" /> Sending…</> : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form onSubmit={reset} className="flex flex-1 flex-col gap-6" noValidate>
            <StepHeading step={2} of={2} title="Check your email">
              We sent a code to <span className="font-semibold text-ink">{sentTo}</span>. It works for 15 minutes.
            </StepHeading>
            <CodeField value={code} onChange={setCode} autoFocus />
            <Field
              label="New password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={`At least ${MIN_PASSWORD} characters.`}
              trailing={
                <button type="button" onClick={() => setShow(!show)} className="btn btn-plain h-11 w-11 min-h-0 rounded-full p-0 text-ink-2" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                  {show ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                </button>
              }
            />
            {error && <Notice tone="danger" title={error} live="assertive" />}
            <div className="mt-auto flex flex-col gap-2">
              <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy || code.length !== 6 || password.trim().length < MIN_PASSWORD}>
                {busy ? <><Spinner className="h-5 w-5" /> Saving…</> : 'Set new password'}
              </button>
              <button type="button" className="btn btn-plain w-full" onClick={() => sendCode()} disabled={busy || resendIn > 0}>
                {resendIn > 0 ? <span className="num">Send a new code in {resendIn}s</span> : 'Send a new code'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
