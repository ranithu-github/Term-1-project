'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { AuthHeader, authInputClass } from '@/components/AuthMarks';

function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [isResetMode, setIsResetMode] = useState(false);
  const [indexNo, setIndexNo] = useState('');
  const [email, setEmail] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [newPassword, setNewPassword] = useState('');
  const [verifyPassword, setVerifyPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showVerifyPassword, setShowVerifyPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // If user visits /verify directly with no index
  const [manualIndexInput, setManualIndexInput] = useState('');
  const [requestingCode, setRequestingCode] = useState(false);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const paramIndex = searchParams.get('index_no');
    const paramEmail = searchParams.get('email');
    const mode = searchParams.get('mode');

    const reset = mode === 'reset';
    setIsResetMode(reset);

    const storedIndex =
      paramIndex ||
      (reset ? sessionStorage.getItem('astrix_reset_index') : localStorage.getItem('astrix_pending_index')) ||
      '';

    const storedEmail =
      paramEmail ||
      (reset ? sessionStorage.getItem('astrix_reset_email') : localStorage.getItem('astrix_pending_email')) ||
      '';


    setIndexNo(storedIndex);
    setEmail(storedEmail);

    // Auto-focus first OTP input if index exists
    if (storedIndex) {
      setTimeout(() => inputRefs.current[0]?.focus(), 150);
    }
  }, [searchParams]);

  const handleOtpChange = (index: number, value: string) => {
    const clean = value.replace(/\D/g, '');
    if (!clean) {
      const copy = [...otpDigits];
      copy[index] = '';
      setOtpDigits(copy);
      return;
    }

    if (clean.length > 1) {
      const pasted = clean.slice(0, 6).split('');
      const copy = [...otpDigits];
      pasted.forEach((char, i) => {
        if (i < 6) copy[i] = char;
      });
      setOtpDigits(copy);
      const nextIndex = Math.min(pasted.length, 5);
      inputRefs.current[nextIndex]?.focus();
      return;
    }

    const copy = [...otpDigits];
    copy[index] = clean[0];
    setOtpDigits(copy);

    if (index < 5 && clean[0]) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  // Resend OTP code
  const handleResendCode = async () => {
    if (!indexNo) return;
    setResending(true);
    setError(null);
    setSuccess(null);

    try {
      if (isResetMode) {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index_no: indexNo }),
        });
        const json = await res.json();
        if (res.ok && json.success) {
          setSuccess(`New code sent to ${json.masked_email || email}.`);
          setEmail(json.masked_email || email);
        } else {
          setError(json.message || 'Could not resend code. Please try again.');
        }
      } else {
        // Resend signup OTP
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            index_no: indexNo,
            username: localStorage.getItem('astrix_pending_name') || 'Student',
            email: localStorage.getItem('astrix_pending_email') || email,
          }),
        });
        const json = await res.json();
        if (res.ok && json.success) {
          if (json.data?.verification_token) {
            localStorage.setItem('astrix_verification_token', json.data.verification_token);
          }
          setSuccess(`New code sent to ${email}.`);
        } else {
          setError(json.message || 'Could not resend code.');
        }
      }
    } catch (e: any) {
      setError(e.message || 'Failed to resend code.');
    } finally {
      setResending(false);
    }
  };

  // Request code when visiting directly without index
  const handleRequestCodeFromIndex = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanIdx = manualIndexInput.trim().toUpperCase();
    if (!cleanIdx) {
      setError('Enter your index number.');
      return;
    }

    setRequestingCode(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index_no: cleanIdx }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Account not found. Please register first.');
        setRequestingCode(false);
        return;
      }

      setIndexNo(cleanIdx);
      setEmail(json.masked_email || '');
      setIsResetMode(true);
      setSuccess(`Code sent to ${json.masked_email}.`);
      setTimeout(() => inputRefs.current[0]?.focus(), 200);
    } catch (err: any) {
      setError(err.message || 'Failed to connect.');
    } finally {
      setRequestingCode(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const fullOtp = otpDigits.join('');
    if (fullOtp.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }

    if (!newPassword || newPassword.length < 6) {
      setError('Use at least 6 characters.');
      return;
    }

    if (newPassword !== verifyPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);

    try {
      const cleanIndex = indexNo.trim().toUpperCase();
      const verificationToken = !isResetMode
        ? localStorage.getItem('astrix_verification_token') || undefined
        : undefined;

      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index_no: cleanIndex,
          code: fullOtp,
          password: newPassword,
          verification_token: verificationToken,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Verification failed. Please check the code and try again.');
        setLoading(false);
        return;
      }

      // Cleanup pending data
      localStorage.removeItem('astrix_verification_token');
      sessionStorage.removeItem('astrix_reset_index');

      if (isResetMode) {
        setSuccess('Password reset. Taking you to sign in...');
        setTimeout(() => {
          router.push(`/login?reset=success&index_no=${encodeURIComponent(cleanIndex)}`);
        }, 700);
      } else {
        const verifiedUser = json.user || {
          index_no: cleanIndex,
          username: localStorage.getItem('astrix_pending_name') || 'Student',
          email: email.trim().toLowerCase(),
        };
        localStorage.setItem('astrix_user', JSON.stringify(verifiedUser));

        setSuccess('Password set. Taking you to sign in...');
        setTimeout(() => {
          router.push(`/login?verified=true&index_no=${encodeURIComponent(cleanIndex)}`);
        }, 700);
      }
    } catch (err: any) {
      setError(err.message || 'Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none">
      <AuthHeader
        lines={isResetMode || !indexNo ? ['Reset your', 'password.'] : ['Verify your', 'email.']}
        note={indexNo ? `Code sent to ${email || 'your email'}` : undefined}
        onBack={() => router.push('/login')}
      />

      {/* White sheet */}
      <div className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-9 pb-8">
        {/* Case A: No Index No. Provided (Prompt User) */}
        {!indexNo ? (
          <form onSubmit={handleRequestCodeFromIndex} className="space-y-5">
            {error && (
              <p className="px-4 py-3 rounded-xl bg-rose-50 text-rose-800 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{error}</span>
              </p>
            )}

            <div className="space-y-2">
              <label htmlFor="reset-index" className="block text-sm font-semibold text-brand-900">
                Index number
              </label>
              <input
                id="reset-index"
                type="text"
                value={manualIndexInput}
                onChange={(e) => setManualIndexInput(e.target.value.toUpperCase())}
                placeholder="250373T"
                className={`${authInputClass} uppercase tracking-wider font-medium`}
                autoFocus
                required
              />
            </div>

            <button
              type="submit"
              disabled={requestingCode}
              className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
            >
              {requestingCode ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span>Send code</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        ) : (
          /* Case B: Main OTP & Password Reset Form */
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <p className="px-4 py-3 rounded-xl bg-rose-50 text-rose-800 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{error}</span>
              </p>
            )}

            {success && (
              <p className="px-4 py-3 rounded-xl bg-emerald-50 text-emerald-800 text-sm flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                <span>{success}</span>
              </p>
            )}

            {/* 6-Digit OTP Input Boxes */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="block text-sm font-semibold text-brand-900">6-digit code</span>
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resending}
                  className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                >
                  {resending ? 'Sending...' : 'Resend'}
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                {otpDigits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    aria-label={`Digit ${i + 1}`}
                    className="w-full h-14 text-center text-xl font-semibold rounded-xl bg-brand-50 border border-brand-100 text-brand-900 focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-4 focus:ring-brand-100 transition"
                  />
                ))}
              </div>
            </div>

            {/* New Password */}
            <div className="space-y-2">
              <label htmlFor="new-password" className="block text-sm font-semibold text-brand-900">
                New password
              </label>
              <div className="relative">
                <input
                  id="new-password"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className={`${authInputClass} pr-12`}
                  autoComplete="new-password"
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

            {/* Verify Password */}
            <div className="space-y-2">
              <label htmlFor="confirm-password" className="block text-sm font-semibold text-brand-900">
                Confirm password
              </label>
              <div className="relative">
                <input
                  id="confirm-password"
                  type={showVerifyPassword ? 'text' : 'password'}
                  value={verifyPassword}
                  onChange={(e) => setVerifyPassword(e.target.value)}
                  placeholder="Type it again"
                  className={`${authInputClass} pr-12`}
                  autoComplete="new-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowVerifyPassword(!showVerifyPassword)}
                  aria-label={showVerifyPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-brand-300 hover:text-brand-600"
                >
                  {showVerifyPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span>{isResetMode ? 'Reset password' : 'Set password'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center bg-white">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <VerifyForm />
    </Suspense>
  );
}
