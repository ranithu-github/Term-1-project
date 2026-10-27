import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { hashPassword, isLegacyPlaintext, verifyPassword } from '@/lib/password';
import { createSessionValue, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { logActivity, raiseAlert } from '@/lib/events';
import { isAdminIndex } from '@/lib/admin';
import { isDevIndex } from '@/lib/dev';
import { readJson, str } from '@/lib/http';
import { LIMITS } from '@/lib/signup-rules';

export async function POST(request: Request) {
  try {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const cleanIndex = str(parsed.body.index_no).toUpperCase();
    const cleanPassword = str(parsed.body.password);

    if (!cleanIndex || !cleanPassword) {
      return NextResponse.json(
        { success: false, message: 'Index number and password are required.' },
        { status: 400 }
      );
    }

    // Per account, and (generously, a campus shares one IP) per network
    const ip = clientIp(request);
    if (!(await rateLimit(`login:idx:${cleanIndex}`, ...LIMITS.loginAccount)) || !(await rateLimit(`login:ip:${ip}`, ...LIMITS.loginNetwork))) {
      await raiseAlert('TOO_MANY_LOGIN_ATTEMPTS', 'warning', `Too many sign-in attempts for ${cleanIndex} or from one network.`, {
        index_no: cleanIndex, actor: cleanIndex, dedupeKey: `idx:${cleanIndex}`, details: { ip },
      });
      return NextResponse.json(
        { success: false, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
        { status: 429 }
      );
    }

    // Lookup user in Supabase
    const { data: user, error: dbError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('index_no', cleanIndex)
      .maybeSingle();

    if (dbError) {
      console.error('❌ [API/Auth/Login] DB lookup error:', dbError.message);
      await raiseAlert('SERVER_ERROR', 'critical', `Sign-in failed with a database error: ${dbError.message}`, {
        actor: 'system', dedupeKey: 'route:login',
      });
      return NextResponse.json({ success: false, message: 'Sign-in failed. Please try again.' }, { status: 500 });
    }

    if (!user) {
      return NextResponse.json(
        { success: false, message: 'No account found with this Index Number. Please sign up first.' },
        { status: 404 }
      );
    }

    if (!user.is_verified) {
      return NextResponse.json(
        { success: false, message: 'Your account is not verified yet. Please complete signup verification.' },
        { status: 403 }
      );
    }

    // Verify hashed password
    const isValid = user.password ? verifyPassword(cleanPassword, user.password) : false;
    if (!isValid) {
      await logActivity('LOGIN_FAILED', `Wrong password for ${cleanIndex}`, { index_no: cleanIndex, actor: cleanIndex, details: { ip } });
      if (isAdminIndex(cleanIndex) || isDevIndex(cleanIndex)) {
        const role = isAdminIndex(cleanIndex) ? 'admin' : 'developer';
        await raiseAlert('PRIVILEGED_LOGIN_FAILED', isAdminIndex(cleanIndex) ? 'critical' : 'warning', `Wrong password on the ${role} account ${cleanIndex}.`, {
          index_no: cleanIndex, actor: cleanIndex, dedupeKey: `idx:${cleanIndex}`, details: { ip },
        });
      }
      return NextResponse.json(
        { success: false, message: 'Invalid password. Please check your credentials.' },
        { status: 401 }
      );
    }

    // Locked by an admin
    if (user.is_locked === true) {
      await logActivity('LOGIN_BLOCKED', `${cleanIndex} tried to sign in to a locked account`, { index_no: cleanIndex, actor: cleanIndex });
      return NextResponse.json(
        { success: false, message: 'This account is locked. Please contact the station team.' },
        { status: 403 }
      );
    }

    await logActivity('LOGIN', `${cleanIndex} signed in`, { index_no: cleanIndex, actor: cleanIndex });

    // Upgrade a legacy plaintext password to a salted hash on first successful sign-in
    let storedPassword: string = user.password;
    if (isLegacyPlaintext(user.password)) {
      const upgraded = hashPassword(cleanPassword);
      const { error: upgradeError } = await supabaseAdmin
        .from('users')
        .update({ password: upgraded, updated_at: new Date().toISOString() })
        .eq('index_no', cleanIndex);
      if (!upgradeError) storedPassword = upgraded;
    }

    const response = NextResponse.json({
      success: true,
      message: 'Signed in successfully.',
      user: {
        index_no: user.index_no,
        username: user.username,
        email: user.email,
      },
    });

    // Signed, httpOnly session cookie — the API reads the student from this
    const session = createSessionValue(user.index_no, storedPassword);
    response.cookies.set(SESSION_COOKIE, session.value, {
      ...sessionCookieOptions,
      maxAge: session.maxAgeSeconds,
    });

    return response;
  } catch (error: any) {
    console.error('❌ [API/Auth/Login] Error:', error);
    await raiseAlert('SERVER_ERROR', 'critical', `Sign-in failed with a server error: ${error?.message || error}`, {
      actor: 'system', dedupeKey: 'route:login',
    });
    return NextResponse.json({ success: false, message: 'Login failed. Please try again.' }, { status: 500 });
  }
}
