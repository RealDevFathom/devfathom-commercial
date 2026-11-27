import { z } from 'zod';

import { readBoundedJson } from '@/lib/http/read-bounded-body';
import {
  issueVerifiedWallet,
  WalletDemoAccountRequired,
  WalletProviderUnavailable,
} from '@/lib/wallet/issue';
import { verifyEnrollment } from '@/lib/restaurant/wallet/enrollment';
import {
  admitWalletEnrollment,
  admitWalletOtpAttempt,
} from '@/lib/restaurant/wallet/enrollment-rate-limit';

import { enrollmentContext, INVALID, limited, tokenSchema } from '../shared';

const inputSchema = z
  .object({
    token: tokenSchema,
    attemptId: z.string().trim().min(1).max(191),
    consent: z.literal(true).optional(),
    cardCode: z.string().min(1).max(64).optional(),
    otp: z.string().regex(/^\d{6}$/),
  })
  .strict();

export async function POST(request: Request) {
  const context = await enrollmentContext(request);
  const body = await readBoundedJson(request, 4 * 1024).catch(() => null);
  if (body?.tooLarge) return Response.json(INVALID, { status: 413 });
  const parsed = inputSchema.safeParse(body?.value);
  if (!context || !parsed.success) return Response.json(INVALID, { status: 400 });
  const broadGate = await admitWalletEnrollment({ ip: context.ip, token: parsed.data.token });
  const attemptGate = await admitWalletOtpAttempt(parsed.data.attemptId);
  const blocked = !broadGate.ok ? broadGate : !attemptGate.ok ? attemptGate : null;
  if (blocked) return limited(blocked.retryAfter);
  const result = await verifyEnrollment({
    organizationId: context.organization.id,
    ...parsed.data,
  });
  if (result?.phoneJoin) {
    let wallet;
    try {
      wallet = await issueVerifiedWallet(context.organization.id, result);
    } catch (error) {
      if (error instanceof WalletDemoAccountRequired)
        return Response.json(
          { ok: false, message: 'A Google Wallet test account is required.' },
          { status: 403 }
        );
      if (!(error instanceof WalletProviderUnavailable))
        return Response.json(INVALID, { status: 400 });
      // A provider failure happens after enrollment commits. Hand the verified shopper their
      // card so a retry can recover this same balance without replacing or duplicating it.
      return Response.json(
        {
          ok: true,
          cardCode: result.alias,
          message:
            'Your card is ready. Keep its code and verify your phone again to retry adding it to a wallet.',
        },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    }
    return Response.json(
      { ok: true, wallet },
      { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }
    );
  }
  return result
    ? Response.json({ ok: true, message: 'Your wallet passes are being prepared.' })
    : Response.json(INVALID, { status: 400 });
}
