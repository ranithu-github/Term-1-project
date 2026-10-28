// =====================================================================
// Who can sign up. Developer and admin accounts are never created through
// signup: they are made with scripts/create-account.mjs.
// =====================================================================

/** A UoM student index number: 6 digits and a letter, e.g. 250373T */
export const STUDENT_INDEX = /^[0-9]{6}[A-Z]$/;

/**
 * Allowed email domains for signup, from SIGNUP_EMAIL_DOMAINS (comma-separated,
 * e.g. "uom.lk"). Empty means any address.
 */
export function allowedEmailDomains(): string[] {
  return (process.env.SIGNUP_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function emailAllowed(email: string): boolean {
  const domains = allowedEmailDomains();
  if (domains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase() || '';
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function emailDomainMessage(): string {
  const domains = allowedEmailDomains();
  return `Please use your university email (${domains.map((d) => '@' + d).join(' or ')}).`;
}

export const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-network limits are generous on purpose: a whole campus can share one public IP.
// The per-account limits are what stop guessing. Signup and reset send an email each,
// so their network limit also protects the mail quota (Gmail allows ~500 a day).
export const LIMITS = {
  loginAccount: [10, 15 * 60 * 1000],
  loginNetwork: [300, 15 * 60 * 1000],
  signupAccount: [3, 15 * 60 * 1000],
  signupNetwork: [200, 15 * 60 * 1000],
  codeAccount: [8, 15 * 60 * 1000],
  codeNetwork: [400, 15 * 60 * 1000],
  forgotAccount: [3, 15 * 60 * 1000],
  forgotNetwork: [200, 15 * 60 * 1000],
  checkIndexNetwork: [300, 15 * 60 * 1000],
} as const satisfies Record<string, readonly [number, number]>;
