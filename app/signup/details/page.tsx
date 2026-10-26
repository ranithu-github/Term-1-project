'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AuthHeader, authInputClass } from '@/components/AuthMarks';

export default function SignUpDetailsPage() {
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [indexNo, setIndexNo] = useState('');
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');

  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    // Load verified index from barcode scan
    const storedIndex = sessionStorage.getItem('astrix_verified_index');

    if (!storedIndex) {
      // If no barcode has been scanned, redirect to scan step
      router.replace('/signup');
      return;
    }

    setIndexNo(storedIndex);
    setEmail('');
  }, [router]);

  // Step A: Send OTP to student email
  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    setInfo(null);

    const cleanName = username.trim();
    if (!cleanName || cleanName.length < 3) {
      setError('Enter your name.');
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Enter a valid email.');
      return;
    }

    setSendingOtp(true);

    try {
      const cleanIndex = indexNo.trim().toUpperCase();

      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index_no: cleanIndex,
          username: cleanName,
          email: cleanEmail,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Unable to send verification code. Please try again.');
        setSendingOtp(false);
        return;
      }

      if (json.data?.verification_token) {
        localStorage.setItem('astrix_verification_token', json.data.verification_token);
      }
      localStorage.setItem('astrix_pending_index', cleanIndex);
      localStorage.setItem('astrix_pending_email', cleanEmail);
      localStorage.setItem('astrix_pending_name', cleanName);

      setOtpSent(true);
      setInfo(`Code sent to ${cleanEmail}.`);
    } catch (err: any) {
      console.warn('Signup OTP request failed:', err.message);
      setError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setSendingOtp(false);
    }
  };

  // Step B: Verify the 6-digit OTP code and proceed to Password Setup
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    const cleanCode = otpCode.trim();
    if (!cleanCode || cleanCode.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }

    setVerifyingOtp(true);

    try {
      const cleanIndex = indexNo.trim().toUpperCase();
      const token = localStorage.getItem('astrix_verification_token') || '';

      const res = await fetch('/api/auth/check-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index_no: cleanIndex,
          code: cleanCode,
          verification_token: token,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Invalid verification code. Please try again.');
        setVerifyingOtp(false);
        return;
      }

      // Store verified OTP for the password setup step
      sessionStorage.setItem('astrix_verified_code', cleanCode);

      // Navigate to dedicated password setup screen
      router.push('/signup/password');
    } catch (err: any) {
      console.warn('Verify OTP failed:', err.message);
      setError('Could not connect to the verification server. Please try again.');
    } finally {
      setVerifyingOtp(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none">
      <AuthHeader step={2} lines={['Your', 'details.']} onBack={() => router.push('/signup')} />

      {/* White sheet */}
      <div className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-9 pb-8 space-y-5">
        {error && (
          <p className="px-4 py-3 rounded-xl bg-rose-50 text-rose-800 text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            <span>{error}</span>
          </p>
        )}

        {info && (
          <p className="px-4 py-3 rounded-xl bg-emerald-50 text-emerald-800 text-sm flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            <span>{info}</span>
          </p>
        )}

        {/* Index No. (Locked from Barcode Scan) */}
        <div className="flex items-center justify-between px-4 py-3.5 rounded-xl bg-brand-50">
          <span className="text-sm text-slate-500">Index number</span>
          <span className="flex items-center gap-2 text-[15px] font-semibold tracking-wider text-brand-900">
            {indexNo}
            <Lock className="w-3.5 h-3.5 text-brand-300" />
          </span>
        </div>

        {/* Name */}
        <div className="space-y-2">
          <label htmlFor="name" className="block text-sm font-semibold text-brand-900">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="H. S. S. Liyanage"
            disabled={otpSent}
            className={authInputClass}
            autoComplete="name"
            required
          />
        </div>

        {/* Email */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="email" className="block text-sm font-semibold text-brand-900">
              Email
            </label>
            {otpSent && (
              <button
                type="button"
                onClick={() => setOtpSent(false)}
                className="text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Change
              </button>
            )}
          </div>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="student@gmail.com"
            disabled={otpSent}
            className={authInputClass}
            autoComplete="email"
            required
          />
        </div>

        {!otpSent ? (
          <button
            type="button"
            onClick={() => handleSendOtp()}
            disabled={sendingOtp || !username.trim() || !email.trim()}
            className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
          >
            {sendingOtp ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <span>Send code</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        ) : (
          /* Code entry, shown once the email is sent */
          <form onSubmit={handleVerifyOtp} className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="code" className="block text-sm font-semibold text-brand-900">
                  6-digit code
                </label>
                <button
                  type="button"
                  onClick={() => handleSendOtp()}
                  disabled={sendingOtp}
                  className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                >
                  {sendingOtp ? 'Sending...' : 'Resend'}
                </button>
              </div>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className={`${authInputClass} text-center text-2xl tracking-[0.5em] font-semibold`}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={verifyingOtp || otpCode.length !== 6}
              className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
            >
              {verifyingOtp ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <span>Verify</span>
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
