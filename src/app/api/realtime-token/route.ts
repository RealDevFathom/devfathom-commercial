import crypto from 'node:crypto';
import { auth } from '@/lib/auth';

/**
 * Realtime ticket issuer.
 *
 * The standalone Socket.IO server (socket-server/index.ts) runs as its own
 * process and cannot read NextAuth's session cookie. Instead of leaking the
 * session token to another origin, this route mints a short-lived, HMAC-signed
 * "ticket" that the socket server can verify with a shared secret.
 *
 * The ticket is deliberately DECOUPLED from NextAuth's internal JWT format so a
 * change to NextAuth internals can't silently break (or weaken) socket auth.
 *
 * Flow: browser GET /api/realtime-token -> { ticket } -> client passes it as
 * `socket.handshake.auth.ticket` -> socket server recomputes the HMAC, checks
 * expiry, and trusts the embedded userId.
 */

// Shared signing secret. Prefer a dedicated secret; fall back to AUTH_SECRET so
// existing deployments work out of the box. The socket server resolves the SAME
// pair in the SAME order, so both sides always agree on the key.
// The trailing `|| ''` only makes the type `string` (so the hoisted GET below
// doesn't see `string | undefined`); the guard still throws when neither env
// var is set, exactly as intended.
const TICKET_SECRET = process.env.SOCKET_SHARED_SECRET || process.env.AUTH_SECRET || '';
if (!TICKET_SECRET) {
  // Fail loudly at module load rather than silently issuing unverifiable tickets.
  throw new Error(
    'SOCKET_SHARED_SECRET or AUTH_SECRET must be set to sign realtime tickets'
  );
}

// Tickets are single-use-ish and short-lived: just long enough to complete a
// handshake (and survive a quick reconnect), not long enough to be worth
// exfiltrating. The socket client re-fetches as needed.
const TICKET_TTL_MS = 60_000;

// This endpoint reads the session (cookies) and must never be cached: a cached
// ticket would be stale/expired and shared across users.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  // payload = base64url(JSON.stringify({ userId, exp }))
  const payload = Buffer.from(
    JSON.stringify({ userId: session.user.id, exp: Date.now() + TICKET_TTL_MS })
  ).toString('base64url');

  // sig = base64url(HMAC-SHA256(secret, payload))
  const sig = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(payload)
    .digest('base64url');

  const ticket = `${payload}.${sig}`;

  return Response.json({ ticket });
}
