import { supabaseAdmin } from './supabase';

// =====================================================================
// Fixed-window rate limiter backed by Postgres (public.hit_rate_limit),
// so every server instance shares the same counters.
// If the database can't be reached the request is allowed: the routes
// that use this need the database anyway and will fail on their own.
// =====================================================================

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('hit_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_s: Math.ceil(windowMs / 1000),
  });
  if (error) {
    console.warn('⚠️ [RateLimit] Could not check limit:', error.message);
    return true;
  }
  return data === true;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}
