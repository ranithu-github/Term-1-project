import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { hashOtp, hashResetCode, verifyVerificationToken } from '@/lib/auth-token';
import { hashPassword } from '@/lib/password';
import { sendWelcomeSignupEmail } from '@/lib/email';
import { safeEqual } from '@/lib/otp';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { logActivity, raiseAlert } from '@/lib/events';
import { createSessionValue, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { readJson, str } from '@/lib/http';
import { LIMITS, STUDENT_INDEX } from '@/lib/signup-rules';

const MIN_PASSWORD = 8;

export async function POST(request: Request) {
  try {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const cleanIndex = str(parsed.body.index_no).toUpperCase();
    const cleanCode = str(parsed.body.code);
    const newPassword = str(parsed.body.password);
    const verificationToken = str(parsed.body.verification_token);

    if (!cleanIndex || !cleanCode || !newPassword) {
      return NextResponse.json(
        { success: false, message: 'Index number, verification code, and password are required.' },
        { status: 400 }
      );
    }

    if (newPassword.length < MIN_PASSWORD) {
      return NextResponse.json(
        { success: false, message: `Password must be at least ${MIN_PASSWORD} characters.` },
        { status: 400 }
      );
    }

    // Per account and (generously) per network. Reset codes also have their own
    // budget of wrong attempts in the database (consume_reset).
    const ip = clientIp(request);
    if (!(await rateLimit(`verify:idx:${cleanIndex}`, ...LIMITS.codeAccount)) || !(await rateLimit(`verify:ip:${ip}`, ...LIMITS.codeNetwork))) {
      await raiseAlert('TOO_MANY_CODE_ATTEMPTS', 'warning', `Too many wrong verification/reset codes for ${cleanIndex} or from one network.`, {
        index_no: cleanIndex, actor: cleanIndex, dedupeKey: `idx:${cleanIndex}`, details: { ip },
      });
      return NextResponse.json(
        { success: false, message: 'Too many attempts. Please wait 15 minutes and request a new code.' },
        { status: 429 }
      );
    }

    // ------------------------------------------------------------------
    // 1. Signup: verify via signed token (no unverified rows in the database)
    // ------------------------------------------------------------------
    if (verificationToken) {
      const payload = verifyVerificationToken(verificationToken);
      if (!payload) {
        return NextResponse.json(
          { success: false, message: 'Verification session has expired. Please sign up again.' },
          { status: 400 }
        );
      }

      if (payload.index_no !== cleanIndex || !STUDENT_INDEX.test(cleanIndex)) {
        return NextResponse.json(
          { success: false, message: 'Index number mismatch. Please try again.' },
          { status: 400 }
        );
      }

      if (!safeEqual(payload.otp_hash, hashOtp(cleanIndex, cleanCode))) {
        return NextResponse.json(
          { success: false, message: 'Invalid verification code. Please check your email and try again.' },
          { status: 400 }
        );
      }

      // Hash only once the code is known to be right (scrypt is deliberately slow)
      const hashedPassword = hashPassword(newPassword);
      const account = {
        username: payload.username,
        email: payload.email,
        password: hashedPassword,
        is_verified: true,
        verification_code: null,
        verification_expires: null,
        updated_at: new Date().toISOString(),
      };

      // Create the account. If a row exists it may only be taken over while it is
      // unverified, so a verified account is never overwritten (even by two
      // signups for the same index finishing at the same moment).
      const { error: insertError } = await supabaseAdmin.from('users').insert({ index_no: payload.index_no, ...account });
      if (insertError?.code === '23505') {
        const { data: taken } = await supabaseAdmin
          .from('users')
          .update(account)
          .eq('index_no', payload.index_no)
          .eq('is_verified', false)
          .select('index_no');
        if (!taken?.length) {
          return NextResponse.json(
            { success: false, message: 'This account is already verified. Please sign in, or use Forgot Password.' },
            { status: 409 }
          );
        }
      } else if (insertError) {
        console.error('❌ [API/Auth/Verify] Account insert error:', insertError.message);
        return NextResponse.json(
          { success: false, message: 'Failed to save your account. Please try again.' },
          { status: 500 }
        );
      }

      after(async () => {
        try {
          await sendWelcomeSignupEmail(payload.email, payload.username, payload.index_no);
        } catch (emailErr: any) {
          console.warn('⚠️ [API/Auth/Verify] Welcome email warning:', emailErr?.message);
        }
      });

      await logActivity('ACCOUNT_CREATED', `New account ${payload.index_no} (${payload.username})`, {
        index_no: payload.index_no, actor: payload.index_no,
      });

      const response = NextResponse.json({
        success: true,
        message: 'Account verified successfully and password set.',
        is_reset: false,
        user: { index_no: payload.index_no, username: payload.username, email: payload.email },
      });

      // Sign the new student in straight away: the signup page continues to the dashboard
      const session = createSessionValue(payload.index_no, hashedPassword);
      response.cookies.set(SESSION_COOKIE, session.value, { ...sessionCookieOptions, maxAge: session.maxAgeSeconds });
      return response;
    }

    // ------------------------------------------------------------------
    // 2. Password reset: the code (stored as a keyed hash by forgot-password) is
    //    checked and used up in one database step, with a budget of wrong attempts
    // ------------------------------------------------------------------
    const { data: rows, error: resetError } = await supabaseAdmin.rpc('consume_reset', {
      p_index: cleanIndex,
      p_hash: hashResetCode(cleanIndex, cleanCode),
      p_password: hashPassword(newPassword),
    });
    const outcome = rows?.[0] as { status: string; attempts_left: number } | undefined;

    if (resetError || !outcome) {
      console.error('❌ [API/Auth/Verify] consume_reset error:', resetError?.message);
      return NextResponse.json({ success: false, message: 'Failed to reset your password. Please try again.' }, { status: 500 });
    }

    if (outcome.status !== 'OK') {
      const messages: Record<string, string> = {
        NONE: 'No reset code found for this account. Please request a new code.',
        EXPIRED: 'That code has expired. Please request a new reset code.',
        LOCKED: 'Too many wrong codes. That code no longer works: please request a new one.',
        WRONG: `Invalid code. Please check your email and try again (${outcome.attempts_left} ${outcome.attempts_left === 1 ? 'try' : 'tries'} left).`,
      };
      if (outcome.status === 'LOCKED') {
        await raiseAlert('TOO_MANY_CODE_ATTEMPTS', 'warning', `A password reset code for ${cleanIndex} was cancelled after too many wrong attempts.`, {
          index_no: cleanIndex, actor: cleanIndex, dedupeKey: `reset:${cleanIndex}`, details: { ip },
        });
      }
      return NextResponse.json({ success: false, message: messages[outcome.status] || messages.NONE }, { status: 400 });
    }

    const { data: user } = await supabaseAdmin.from('users').select('index_no, username, email').eq('index_no', cleanIndex).maybeSingle();
    await logActivity('PASSWORD_RESET', `${cleanIndex} reset their password`, { index_no: cleanIndex, actor: cleanIndex });

    return NextResponse.json({
      success: true,
      message: 'Password reset successfully! You can now sign in with your new password.',
      is_reset: true,
      user: user ?? { index_no: cleanIndex },
    });
  } catch (error: any) {
    console.error('❌ [API/Auth/Verify] Error:', error);
    await raiseAlert('SERVER_ERROR', 'critical', `Verification failed with a server error: ${error?.message || error}`, {
      actor: 'system', dedupeKey: 'route:verify',
    });
    return NextResponse.json({ success: false, message: 'Verification failed. Please try again.' }, { status: 500 });
  }
}
