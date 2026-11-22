import { z } from 'zod';

import { readBoundedJson } from '@/lib/http/read-bounded-body';
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
  return result
    ? Response.json({ ok: true, message: 'Your wallet passes are being prepared.' })
    : Response.json(INVALID, { status: 400 });
}
