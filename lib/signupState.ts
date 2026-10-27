'use client';

// Signup progress across the four steps, kept only for this browser session
// (sessionStorage): nothing about an unfinished signup outlives closing the browser.

export interface SignupState {
  index_no?: string;         // read from the student ID barcode
  username?: string;
  email?: string;
  verification_token?: string; // signed by the server; holds only a hash of the code
  code?: string;             // the 6-digit code the student typed, checked on the last step
}

const KEY = 'astrix_signup';

export function readSignup(): SignupState {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function writeSignup(patch: Partial<SignupState>): SignupState {
  const next = { ...readSignup(), ...patch };
  sessionStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSignup() {
  sessionStorage.removeItem(KEY);
  // older keys from the previous signup screens
  ['astrix_verification_token', 'astrix_pending_index', 'astrix_pending_email', 'astrix_pending_name'].forEach((k) => localStorage.removeItem(k));
  ['astrix_verified_index', 'astrix_verified_code'].forEach((k) => sessionStorage.removeItem(k));
}
