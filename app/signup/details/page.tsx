'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IdCard } from 'lucide-react';
import { CodeField, Field, Notice, Spinner, StepBar, StepHeading, TopBar } from '@/components/ui';
import { readSignup, writeSignup } from '@/lib/signupState';

const RESEND_AFTER_S = 30;

// Signup steps 2 and 3: name + university email, then the emailed code
export default function SignupDetailsPage() {
  const router = useRouter();
  const [indexNo, setIndexNo] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: 'name' | 'email' | 'code'; text: string } | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    const s = readSignup();
    if (!s.index_no) {
      router.replace('/signup'); // the index number must come from scanning the ID
      return;
    }
    setIndexNo(s.index_no);
    setName(s.username || '');
    setEmail(s.email || '');
    if (s.verification_token && s.email) setStep(3);
  }, [router]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (name.trim().length < 3) return setError({ field: 'name', text: 'Enter your name as it appears on your student ID.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError({ field: 'email', text: 'Enter a valid email address.' });

    setBusy(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: indexNo, username: name.trim(), email: email.trim().toLowerCase() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError({ field: /email/i.test(json.message || '') ? 'email' : undefined, text: json.message || 'We couldn’t send the code. Try again.' });
        return;
      }
      writeSignup({ username: name.trim(), email: json.data.email, verification_token: json.data.verification_token, code: undefined });
      setCode('');
      setStep(3);
      setResendIn(RESEND_AFTER_S);
    } catch {
      setError({ text: 'You’re offline. Connect to the internet and try again.' });
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/check-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: indexNo, code, verification_token: readSignup().verification_token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError({ field: 'code', text: json.message || 'That code didn’t work. Check your email and try again.' });
        setBusy(false);
        return;
      }
      writeSignup({ code });
      router.push('/signup/password');
    } catch {
      setError({ text: 'You’re offline. Connect to the internet and try again.' });
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar
        title="Create account"
        back={step === 3 ? { onClick: () => { setStep(2); setError(null); }, label: 'Change email' } : { href: '/signup', label: 'Back to scanning' }}
      />
      <main className="flex flex-1 flex-col gap-6 px-6 pb-[calc(var(--safe-bottom)+24px)] pt-5">
        <StepBar step={step} of={4} />

        {step === 2 ? (
          <form onSubmit={sendCode} className="flex flex-1 flex-col gap-5" noValidate>
            <StepHeading step={2} of={4} title="Your details">We&apos;ll email a code to check your address.</StepHeading>
            <div className="flex items-center gap-3 rounded-md bg-sky px-4 py-3">
              <IdCard className="h-5 w-5 text-blue" strokeWidth={2} aria-hidden="true" />
              <p className="text-[0.9375rem] text-ink-2">Index number <span className="num ml-1 font-semibold text-ink">{indexNo}</span></p>
            </div>
            <Field label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={error?.field === 'name' ? error.text : null} placeholder="e.g. H. S. S. Liyanage" />
            <Field label="University email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} error={error?.field === 'email' ? error.text : null} hint="Use an email you can open now: the code goes there." />
            {error && !error.field && <Notice tone="danger" title={error.text} live="assertive" />}
            <button type="submit" className="btn btn-primary btn-lg mt-auto w-full" disabled={busy}>
              {busy ? <><Spinner className="h-5 w-5" /> Sending code…</> : 'Send verification code'}
            </button>
          </form>
        ) : (
          <form onSubmit={checkCode} className="flex flex-1 flex-col gap-5" noValidate>
            <StepHeading step={3} of={4} title="Check your email">
              Enter the 6-digit code we sent to <span className="font-semibold text-ink">{email}</span>.
            </StepHeading>
            <CodeField value={code} onChange={setCode} error={error?.field === 'code' ? error.text : null} autoFocus />
            {error && !error.field && <Notice tone="danger" title={error.text} live="assertive" />}
            <div className="mt-auto flex flex-col gap-2">
              <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy || code.length !== 6}>
                {busy ? <><Spinner className="h-5 w-5" /> Checking…</> : 'Verify email'}
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
