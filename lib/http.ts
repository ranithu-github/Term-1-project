import { NextResponse } from 'next/server';

/**
 * Reads a JSON request body. A missing or malformed body is the caller's
 * mistake, not a server error: it gets a 400 instead of a 500 (and no admin alert).
 */
export async function readJson<T = Record<string, unknown>>(
  request: Request
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return { ok: true, body: body as T };
  } catch {
    // fall through
  }
  return {
    ok: false,
    response: NextResponse.json({ success: false, message: 'The request was not valid. Please try again.' }, { status: 400 }),
  };
}

/** A trimmed string field from a JSON body ('' if missing or not a string) */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
