import { passwordResetRequestInput } from '@/lib/auth/anonymous-inputs';
import { enqueuePasswordReset } from '@/lib/auth/password-reset-request';
import { rateLimit } from '@/lib/rate-limit';
import { requestHost } from '@/lib/tenancy/host';
import { ipFromHeaders } from '@/server/audit';

/** Byte-identical for every outcome, so it can never probe for accounts. */
const NEUTRAL = { ok: true };

export async function POST(request: Request) {
  const ip = ipFromHeaders(request.headers) ?? 'unknown';

  let email: string;
  try {
    email = passwordResetRequestInput.parse(await request.json()).email;
  } catch {
    return Response.json(NEUTRAL);
  }

  // Throttle per IP (broad) and per address so the endpoint cannot be used to
  // flood inboxes or probe. Both hit and miss paths are throttled identically,
  // and a throttled request returns the same body as a delivered one.
  const ipGate = await rateLimit(`pwreset:ip:${ip}`, 10, 15 * 60_000);
  const emailGate = await rateLimit(`pwreset:email:${email}`, 5, 15 * 60_000);
  if (!ipGate.ok || !emailGate.ok) return Response.json(NEUTRAL);

  await enqueuePasswordReset(email, { host: requestHost(request) });
  return Response.json(NEUTRAL);
}
