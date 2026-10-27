import { supabaseAdmin } from './supabase';
import { sendPasswordResetOtpEmail } from './email';
import { generateOtp } from './otp';
import { hashResetCode } from './auth-token';
import { raiseAlert } from './events';

export type ResetResult =
  | { ok: true; maskedEmail: string }
  | { ok: false; status: number; message: string };

/**
 * Masks an email for display, e.g. r***u@gmail.com
 */
export function maskEmail(email: string): string {
  const [namePart, domainPart = ''] = email.split('@');
  const maskedName = namePart.length <= 2 ? namePart[0] + '***' : namePart[0] + '***' + namePart[namePart.length - 1];
  return `${maskedName}@${domainPart}`;
}

/**
 * Creates a 15-minute reset code for a verified account and emails it.
 * Used by "Forgot password" and by the admin panel.
 */
export async function sendResetCode(indexNo: string): Promise<ResetResult> {
  const { data: user, error: dbError } = await supabaseAdmin
    .from('users')
    .select('index_no, username, email, is_verified')
    .eq('index_no', indexNo)
    .maybeSingle();

  if (dbError) {
    console.error('❌ [PasswordReset] DB error:', dbError.message);
    return { ok: false, status: 500, message: 'Database lookup failed.' };
  }

  if (!user) {
    return { ok: false, status: 404, message: `No registered account found for Index Number ${indexNo}. Please sign up first.` };
  }

  if (!user.is_verified) {
    return { ok: false, status: 403, message: 'Your account is not verified yet. Please sign up to verify your account.' };
  }

  if (!user.email) {
    return { ok: false, status: 400, message: 'No registered email found for this account. Please contact support.' };
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update({
      // Only a keyed hash of the code is stored, with a fresh budget of wrong attempts
      reset_code_hash: hashResetCode(indexNo, otp),
      reset_expires: expiresAt,
      reset_attempts: 0,
      verification_code: null,
      verification_expires: null,
      updated_at: new Date().toISOString(),
    })
    .eq('index_no', indexNo);

  if (updateError) {
    console.error('❌ [PasswordReset] Failed to save OTP:', updateError.message);
    return { ok: false, status: 500, message: 'Could not generate reset code. Please try again.' };
  }

  const emailResult = await sendPasswordResetOtpEmail(user.email, user.username || 'Student', indexNo, otp);
  if (!emailResult.success) {
    console.error('❌ [PasswordReset] Email delivery failed:', emailResult.error);
    await raiseAlert('EMAIL_FAILED', 'warning', `A password reset email to ${indexNo} could not be sent.`, {
      index_no: indexNo, actor: 'system', dedupeKey: 'reset-email', details: { error: emailResult.error },
    });
    return { ok: false, status: 502, message: 'Could not send the reset email. Please try again later.' };
  }

  return { ok: true, maskedEmail: maskEmail(user.email) };
}
