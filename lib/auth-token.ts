import crypto from 'crypto';
import { getAuthSecret } from './secret';
import { safeEqual } from './otp';

export interface PendingSignupPayload {
  index_no: string;
  username: string;
  email: string;
  otp_hash: string; // keyed hash of the code — the code itself never leaves the server
  expires_at: number;
}

/**
 * Keyed hash of a signup code, bound to the index number so a code for one
 * student cannot be reused for another.
 */
export function hashOtp(indexNo: string, otp: string): string {
  return crypto.createHmac('sha256', getAuthSecret()).update(`otp:${indexNo}:${otp}`).digest('hex');
}

/**
 * Keyed hash of a password-reset code, bound to the index number. Only this
 * hash is stored; the code itself is only in the email.
 */
export function hashResetCode(indexNo: string, code: string): string {
  return crypto.createHmac('sha256', getAuthSecret()).update(`reset:${indexNo}:${code}`).digest('hex');
}

/**
 * Creates a tamper-proof signed token containing the pending student signup details
 */
export function createVerificationToken(payload: PendingSignupPayload): string {
  const data = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('hex');
  const envelope = JSON.stringify({ data, sig: hmac });
  return Buffer.from(envelope, 'utf8').toString('base64url');
}

/**
 * Validates the verification token signature and expiration
 */
export function verifyVerificationToken(token: string): PendingSignupPayload | null {
  try {
    const envelopeStr = Buffer.from(token, 'base64url').toString('utf8');
    const envelope = JSON.parse(envelopeStr);

    if (!envelope.data || !envelope.sig) return null;

    const expectedSig = crypto.createHmac('sha256', getAuthSecret()).update(envelope.data).digest('hex');
    if (!safeEqual(envelope.sig, expectedSig)) {
      console.warn('⚠️ [AuthToken] Signature mismatch on verification token.');
      return null;
    }

    const payload: PendingSignupPayload = JSON.parse(envelope.data);

    if (Date.now() > payload.expires_at) {
      console.warn('⚠️ [AuthToken] Verification token has expired.');
      return null;
    }

    return payload;
  } catch (err: any) {
    console.error('❌ [AuthToken] Error decoding verification token:', err.message);
    return null;
  }
}
