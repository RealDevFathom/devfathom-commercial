import { NextResponse } from 'next/server';

/**
 * REST-05 — parse a JSON request body safely.
 *
 * `await request.json()` throws on a malformed body, which was caught as a
 * generic 500 (wrong status, pollutes 500 metrics). This returns a clean 400
 * instead. Usage:
 *
 *   const parsed = await readJson(request);
 *   if (!parsed.ok) return parsed.response;
 *   const result = schema.safeParse(parsed.data);
 */
export async function readJson(
  request: Request
): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 }),
    };
  }
}
