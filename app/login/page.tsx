'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useViewMode } from '@/components/ViewModeContext';

// Line-drawn umbrella, tilted, sitting inside the header circle
function UmbrellaMark() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="absolute top-7 right-8 w-28 h-28 -rotate-12"
      fill="none"
      stroke="white"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M50 18 V26" />
      <path d="M10 50 C 14 22, 86 22, 90 50 Q 80 43 70 50 Q 60 43 50 50 Q 40 43 30 50 Q 20 43 10 50 Z" />
      <path d="M50 26 C 42 33 34 41 30 50" strokeOpacity="0.6" />
      <path d="M50 26 C 58 33 66 41 70 50" strokeOpacity="0.6" />
      <path d="M50 50 V 80 a 6 6 0 0 1 -12 0" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isStudentMode } = useViewMode();

  const [indexNo, setIndexNo] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Forgot Password Modal State
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [forgotIndex, setForgotIndex] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  useEffect(() => {
    const isVerified = searchParams.get('verified') === 'true';
    const isReset = searchParams.get('reset') === 'success';
    const paramIndex = searchParams.get('index_no');

    if (paramIndex) {
      setIndexNo(paramIndex.toUpperCase());
    }

    if (isVerified) {
      setSuccess('Email verified and password created. Sign in to continue.');
    } else if (isReset) {
      setSuccess('Password reset. Sign in with your new password.');
    }

    const notice = searchParams.get('notice');
    if (notice === 'session_expired') {
      setError('Your session has ended. Please sign in again.');
    }
  }, [searchParams]);

  const handleOpenForgotModal = () => {
    setForgotIndex(indexNo.trim().toUpperCase());
    setForgotError(null);
    setShowForgotModal(true);
  };

  const handleSendResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError(null);

    const cleanIdx = forgotIndex.trim().toUpperCase();
    if (!cleanIdx) {
      setForgotError('Please enter your University Index Number.');
      return;
    }

    setForgotLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: cleanIdx }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setForgotError(json.message || 'Could not send reset code. Please check your Index Number.');
        setForgotLoading(false);
        return;
      }

      // Successfully dispatched OTP email! Redirect to /verify in reset mode
      setShowForgotModal(false);
      router.push(
        `/verify?mode=reset&index_no=${encodeURIComponent(cleanIdx)}&email=${encodeURIComponent(json.masked_email || '')}`
      );
    } catch (err: any) {
      setForgotError(err.message || 'Failed to connect. Please try again.');
      setForgotLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanIndex = indexNo.trim().toUpperCase();
    if (!cleanIndex || !password) {
      setError('Please enter both your Index Number and Password.');
      return;
    }

    setLoading(true);

    try {
      // Authenticate via backend API
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: cleanIndex, password }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Invalid password. Please check and try again.');
        setLoading(false);
        return;
      }

      const activeUser = json.user;

      // The server set a signed session cookie; this copy is only for showing the name
      localStorage.setItem('astrix_user', JSON.stringify(activeUser));

      setSuccess(`Welcome back, ${activeUser.username}!`);
      setTimeout(() => {
        router.push('/dashboard');
      }, 600);
    } catch (err: any) {
      setError(err.message || 'Failed to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Fills only the developer index number — the password is never stored in code
  const fillDemoStudent = () => {
    setIndexNo('DEV001');
    setError(null);
  };

  const inputClass =
    'w-full px-4 py-3.5 rounded-xl bg-brand-50 border border-brand-100 text-base text-brand-900 placeholder-brand-300 focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-4 focus:ring-brand-100 transition';

  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none">
      {/* Blue header band */}
      <div className="relative px-7 pt-8 pb-20 text-white overflow-hidden">
        {/* One soft circle for depth */}
        <div className="absolute -top-24 -right-20 w-72 h-72 rounded-full bg-white/[0.07]" aria-hidden="true" />

        <UmbrellaMark />

        {!isStudentMode && (
          <button
            type="button"
            onClick={fillDemoStudent}
            className="relative text-[11px] font-semibold bg-white/15 hover:bg-white/25 px-2.5 py-1 rounded-lg transition"
          >
            Fill dev index (DEV001)
          </button>
        )}

        <h1 className="relative mt-20 font-display text-[44px] leading-[1.02] font-semibold">
          Welcome
          <br />
          back.
        </h1>
      </div>

      {/* White form sheet */}
      <div className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-10 pb-8">
        <form onSubmit={handleSignIn} className="space-y-5">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-50 text-rose-700 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="p-3.5 rounded-xl bg-emerald-50 text-emerald-800 text-sm flex items-start gap-2 leading-relaxed">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
              <span>{success}</span>
            </div>
          )}

          {/* Index Number */}
          <div className="space-y-2">
            <label htmlFor="index-no" className="block text-sm font-semibold text-brand-900">
              Index number
            </label>
            <input
              id="index-no"
              type="text"
              value={indexNo}
              onChange={(e) => setIndexNo(e.target.value)}
              placeholder="210042A"
              className={`${inputClass} uppercase tracking-wider font-medium`}
              autoComplete="username"
              required
            />
          </div>

          {/* Password */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-semibold text-brand-900">
                Password
              </label>
              <button
                type="button"
                onClick={handleOpenForgotModal}
                className="text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className={`${inputClass} pr-12`}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 pr-4 flex items-center text-brand-300 hover:text-brand-600"
              >
                {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
              </button>
            </div>
          </div>

          {/* Sign In Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-60 active:scale-[0.99]"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <span>Sign in</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-slate-500">
          New to Astrix?{' '}
          <Link href="/signup" className="font-semibold text-brand-600 hover:text-brand-700">
            Register with your student ID
          </Link>
        </p>
      </div>

      {/* Forgot Password Modal */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-brand-900/40">
          <div className="w-full max-w-sm bg-white rounded-3xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-2xl font-semibold text-brand-900">Reset password</h3>
                <p className="text-sm text-slate-500 mt-1">
                  We'll email a 6-digit code to the address you registered with.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowForgotModal(false)}
                aria-label="Close"
                className="text-slate-400 hover:text-slate-600 p-1 -m-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {forgotError && (
              <div className="p-3 rounded-xl bg-rose-50 text-rose-700 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{forgotError}</span>
              </div>
            )}

            <form onSubmit={handleSendResetCode} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="forgot-index" className="block text-sm font-semibold text-brand-900">
                  Index number
                </label>
                <input
                  id="forgot-index"
                  type="text"
                  value={forgotIndex}
                  onChange={(e) => setForgotIndex(e.target.value.toUpperCase())}
                  placeholder="250373T"
                  className={`${inputClass} uppercase tracking-wider font-medium`}
                  autoFocus
                  required
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowForgotModal(false)}
                  className="flex-1 py-3.5 px-4 rounded-xl text-brand-900 hover:bg-brand-50 font-semibold text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="flex-1 py-3.5 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm flex items-center justify-center gap-1.5 transition disabled:opacity-60"
                >
                  {forgotLoading ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    'Send code'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center bg-white">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
