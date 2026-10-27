'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, ArrowRight, AlertCircle } from 'lucide-react';
import { AuthHeader, authInputClass } from '@/components/AuthMarks';

export default function SignUpPasswordPage() {
  const router = useRouter();

  const [indexNo, setIndexNo] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const storedIndex = localStorage.getItem('astrix_pending_index') || sessionStorage.getItem('astrix_verified_index') || '';
    const storedName = localStorage.getItem('astrix_pending_name') || '';
    const storedEmail = localStorage.getItem('astrix_pending_email') || '';
    const storedCode = sessionStorage.getItem('astrix_verified_code') || '';

    if (!storedIndex || !storedCode) {
      // If no verified OTP session exists, redirect back to details
      router.replace('/signup/details');
      return;
    }

    setIndexNo(storedIndex);
    setUsername(storedName);
    setEmail(storedEmail);
    setCode(storedCode);
  }, [router]);

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanPass = password.trim();
    if (!cleanPass || cleanPass.length < 6) {
      setError('Use at least 6 characters.');
      return;
    }

    if (cleanPass !== confirmPassword.trim()) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);

    try {
      const token = localStorage.getItem('astrix_verification_token') || undefined;

      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index_no: indexNo,
          code: code,
          password: cleanPass,
          verification_token: token,
        }),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.message || 'Registration failed. Please try again.');
        setLoading(false);
        return;
      }

      // Cleanup signup storage
      localStorage.removeItem('astrix_verification_token');
      localStorage.removeItem('astrix_pending_index');
      localStorage.removeItem('astrix_pending_email');
      localStorage.removeItem('astrix_pending_name');
      sessionStorage.removeItem('astrix_verified_code');
      sessionStorage.removeItem('astrix_verified_index');

      // Cache user info for instant display
      if (json.user) {
        localStorage.setItem('astrix_user', JSON.stringify(json.user));
      }

      // Direct redirect to Dashboard!
      router.push('/dashboard');
    } catch (err: any) {
      console.warn('Account creation failed:', err.message);
      setError('Could not connect to the server. Please check your connection.');
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-brand-600 font-body select-none">
      <AuthHeader
        step={3}
        lines={['Set a', 'password.']}
        note={[username, indexNo].filter(Boolean).join(' · ')}
        onBack={() => router.push('/signup/details')}
      />

      {/* White sheet */}
      <form
        onSubmit={handleCreateAccount}
        className="flex-1 -mt-10 bg-white rounded-tl-[40px] px-7 pt-9 pb-8 space-y-5"
      >
        {error && (
          <p className="px-4 py-3 rounded-xl bg-rose-50 text-rose-800 text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            <span>{error}</span>
          </p>
        )}

        {/* New Password */}
        <div className="space-y-2">
          <label htmlFor="new-password" className="block text-sm font-semibold text-brand-900">
            Password
          </label>
          <div className="relative">
            <input
              id="new-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className={`${authInputClass} pr-12`}
              autoComplete="new-password"
              required
              minLength={6}
              autoFocus
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

        {/* Confirm Password */}
        <div className="space-y-2">
          <label htmlFor="confirm-password" className="block text-sm font-semibold text-brand-900">
            Confirm password
          </label>
          <div className="relative">
            <input
              id="confirm-password"
              type={showConfirm ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Type it again"
              className={`${authInputClass} pr-12`}
              autoComplete="new-password"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              aria-label={showConfirm ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 pr-4 flex items-center text-brand-300 hover:text-brand-600"
            >
              {showConfirm ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || password.length < 6 || password !== confirmPassword}
          className="w-full !mt-7 py-4 px-4 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-[15px] flex items-center justify-center gap-2 transition disabled:opacity-50 active:scale-[0.99]"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              <span>Create account</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
