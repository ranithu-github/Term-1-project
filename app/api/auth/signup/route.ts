import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendVerificationOtpEmail } from '@/lib/email';
import { createVerificationToken, hashOtp } from '@/lib/auth-token';
import { generateOtp } from '@/lib/otp';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { logActivity, raiseAlert } from '@/lib/events';
import { readJson, str } from '@/lib/http';
import { EMAIL_FORMAT, LIMITS, STUDENT_INDEX, emailAllowed, emailDomainMessage } from '@/lib/signup-rules';

export async function POST(request: Request) {
  try {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const cleanIndex = str(parsed.body.index_no).toUpperCase();
    const cleanEmail = str(parsed.body.email).toLowerCase();
    const cleanName = str(parsed.body.username).slice(0, 100) || 'Student';

    if (!cleanIndex || !cleanEmail) {
      return NextResponse.json(
        { success: false, message: 'Index Number and Email are required.' },
        { status: 400 }
      );
    }

    // Students only: developer/admin accounts are created with scripts/create-account.mjs
    if (!STUDENT_INDEX.test(cleanIndex)) {
      return NextResponse.json(
        { success: false, message: 'Invalid Student ID format. A valid Moratuwa Index is 6 digits followed by a letter (e.g. 250373T).' },
        { status: 400 }
      );
    }

    if (!EMAIL_FORMAT.test(cleanEmail)) {
      return NextResponse.json({ success: false, message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!emailAllowed(cleanEmail)) {
      return NextResponse.json({ success: false, message: emailDomainMessage() }, { status: 400 });
    }

    // Per index (stops inbox flooding), and generously per network
    const ip = clientIp(request);
    if (!(await rateLimit(`signup:idx:${cleanIndex}`, ...LIMITS.signupAccount)) || !(await rateLimit(`signup:ip:${ip}`, ...LIMITS.signupNetwork))) {
      await raiseAlert('SIGNUP_FLOOD', 'warning', `Too many signup codes requested for ${cleanIndex} or from one network.`, {
        index_no: cleanIndex, actor: cleanIndex, dedupeKey: `idx:${cleanIndex}`, details: { ip },
      });
      return NextResponse.json(
        { success: false, message: 'Too many verification codes requested. Please wait 15 minutes and try again.' },
        { status: 429 }
      );
    }

    // Refuse signup for an index number that already has a verified account
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('users')
      .select('is_verified')
      .eq('index_no', cleanIndex)
      .maybeSingle();

    if (lookupError) {
      console.error('❌ [API/Auth/Signup] Lookup error:', lookupError.message);
      return NextResponse.json({ success: false, message: 'Signup failed. Please try again.' }, { status: 500 });
    }

    if (existing?.is_verified) {
      return NextResponse.json(
        {
          success: false,
          message: `Account already exists for Index Number ${cleanIndex}. Please sign in, or use Forgot Password.`,
        },
        { status: 409 }
      );
    }

    // Generate secure 6-digit OTP
    const otp = generateOtp();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Signed token holds only a keyed hash of the code — the code itself is only in the email
    const verificationToken = createVerificationToken({
      index_no: cleanIndex,
      username: cleanName,
      email: cleanEmail,
      otp_hash: hashOtp(cleanIndex, otp),
      expires_at: expiresAt,
    });

    const emailResult = await sendVerificationOtpEmail(cleanEmail, cleanName, otp);
    if (!emailResult.success) {
      console.error('❌ [API/Auth/Signup] Email delivery failed:', emailResult.error);
      await raiseAlert('EMAIL_FAILED', 'warning', `A signup verification email for ${cleanIndex} could not be sent.`, {
        index_no: cleanIndex, actor: 'system', dedupeKey: 'signup-email', details: { error: emailResult.error },
      });
      return NextResponse.json(
        { success: false, message: 'Could not send the verification email. Please check the address and try again.' },
        { status: 502 }
      );
    }

    await logActivity('SIGNUP_CODE_SENT', `Signup code sent for ${cleanIndex}`, { index_no: cleanIndex, actor: cleanIndex });

    return NextResponse.json({
      success: true,
      message: 'Verification code sent to your email.',
      data: {
        index_no: cleanIndex,
        email: cleanEmail,
        verification_token: verificationToken,
      },
    });
  } catch (error: any) {
    console.error('❌ [API/Auth/Signup] Error:', error);
    await raiseAlert('SERVER_ERROR', 'critical', `Signup failed with a server error: ${error?.message || error}`, {
      actor: 'system', dedupeKey: 'route:signup',
    });
    return NextResponse.json({ success: false, message: 'Signup failed. Please try again.' }, { status: 500 });
  }
}
