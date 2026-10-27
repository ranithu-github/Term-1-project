'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { Field, Mark, Notice, Spinner } from '@/components/ui';
import { seedStationUser } from '@/lib/stationCache';

const NOTICES: Record<string, { tone: 'success' | 'info'; text: string }> = {
  verified: { tone: 'success', text: 'Your account is ready. Sign in to continue.' },
  reset: { tone: 'success', text: 'Password changed. Sign in with your new password.' },
  signed_out: { tone: 'info', text: 'Please sign in again to continue.' },
  session_expired: { tone: 'info', text: 'Please sign in again to continue.' },
};

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const [indexNo, setIndexNo] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const idx = params.get('index_no');
    if (idx) setIndexNo(idx.toUpperCase());
  }, [params]);

  const noticeKey = params.get('verified') === 'true' ? 'verified' : params.get('reset') === 'success' ? 'reset' : params.get('notice') || '';
  const notice = NOTICES[noticeKey];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: indexNo.trim().toUpperCase(), password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.message || 'Check your index number and password.');
        setLoading(false);
        return;
      }
      // The server set the session cookie; this copy only shows the name instantly
      localStorage.setItem('astrix_user', JSON.stringify(json.user));
      seedStationUser(json.user);
      router.replace('/dashboard');
    } catch {
      setError('You’re offline. Connect to the internet and try again.');
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col px-6 pb-[calc(var(--safe-bottom)+24px)] pt-[calc(var(--safe-top)+40px)]">
      <div className="enter flex items-center gap-3">
        <Mark className="h-12 w-12" />
        <p className="text-xl font-bold tracking-[-0.01em]">ASTRIX</p>
      </div>
      <h1 className="enter enter-1 mt-8 text-[2rem] font-bold leading-tight tracking-[-0.025em]">Welcome back</h1>
      <p className="enter enter-1 mt-2 text-[1.0625rem] text-ink-2">Sign in with your university index number.</p>

      {notice && <Notice className="enter enter-2 mt-6" tone={notice.tone} title={notice.text} />}

      <form onSubmit={submit} className="enter enter-2 mt-6 flex flex-col gap-5" noValidate>
        <Field
          label="University index number"
          name="username"
          autoComplete="username"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="e.g. 250373T"
          value={indexNo}
          onChange={(e) => setIndexNo(e.target.value)}
          required
        />
        <div>
          <Field
            label="Password"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            trailing={
              <button type="button" onClick={() => setShow(!show)} className="btn btn-plain h-11 w-11 min-h-0 rounded-full p-0 text-ink-2" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                {show ? <EyeOff className="h-5 w-5" strokeWidth={2} aria-hidden="true" /> : <Eye className="h-5 w-5" strokeWidth={2} aria-hidden="true" />}
              </button>
            }
          />
          <div className="mt-1 flex justify-end">
            <Link href={`/verify${indexNo ? `?index_no=${encodeURIComponent(indexNo.trim().toUpperCase())}` : ''}`} className="btn btn-plain -mr-2 text-[0.9375rem]">
              Forgot password?
            </Link>
          </div>
        </div>

        {error && <Notice tone="danger" title={error} live="assertive" />}

        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={loading || !indexNo.trim() || !password}>
          {loading ? <><Spinner className="h-5 w-5" /> Signing in…</> : 'Sign in'}
        </button>
      </form>

      <div className="mt-auto pt-10 text-center">
        <p className="text-[0.9375rem] text-ink-2">New to ASTRIX?</p>
        <Link href="/signup" className="btn btn-secondary btn-lg mt-2 w-full">Register with your student ID</Link>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
