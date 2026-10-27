import { NextResponse } from 'next/server';
import { hashOtp, verifyVerificationToken } from '@/lib/auth-token';
import { safeEqual } from '@/lib/otp';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { readJson, str } from '@/lib/http';
import { LIMITS } from '@/lib/signup-rules';

export async function POST(request: Request) {
  try {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const cleanIndex = str(parsed.body.index_no).toUpperCase();
    const cleanCode = str(parsed.body.code);
    const verification_token = str(parsed.body.verification_token);

    if (!cleanIndex || !cleanCode || !verification_token) {
      return NextResponse.json(
        { success: false, message: 'Index number, verification code, and token are required.' },
        { status: 400 }
      );
    }

    // Rate limit code guesses per index and (generously) per network
    const ip = clientIp(request);
    if (
      !(await rateLimit(`check-otp:idx:${cleanIndex}`, ...LIMITS.codeAccount)) ||
      !(await rateLimit(`check-otp:ip:${ip}`, ...LIMITS.codeNetwork))
    ) {
      return NextResponse.json(
        { success: false, message: 'Too many attempts. Please request a new verification code.' },
        { status: 429 }
      );
    }

    const payload = verifyVerificationToken(verification_token);
    if (!payload) {
      return NextResponse.json(
        { success: false, message: 'Verification session has expired. Please send a new OTP.' },
        { status: 400 }
      );
    }

    if (payload.index_no !== cleanIndex) {
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

    return NextResponse.json({
      success: true,
      message: 'OTP verified successfully.',
      data: {
        index_no: cleanIndex,
        username: payload.username,
        email: payload.email,
      },
    });
  } catch (err: any) {
    console.error('❌ [API/Auth/Check-OTP] Exception:', err);
    return NextResponse.json(
      { success: false, message: 'Internal error checking verification code.' },
      { status: 500 }
    );
  }
}
