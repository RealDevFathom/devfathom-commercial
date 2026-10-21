import { z } from 'zod';

import { sendEmail } from '@/lib/email';
import { startEnrollment } from '@/lib/restaurant/wallet/enrollment';
import { admitWalletEnrollment } from '@/lib/restaurant/wallet/enrollment-rate-limit';

import { enrollmentContext, INVALID, limited, tokenSchema } from '../shared';

const inputSchema = z.object({ token: tokenSchema, email: z.email().max(320) }).strict();
const ACCEPTED = { ok: true, message: 'If this link is active, a code is on its way.' } as const;

export async function POST(request: Request) {
  const context = await enrollmentContext(request);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!context || !parsed.success) return Response.json(ACCEPTED, { status: 202 });
  const email = parsed.data.email.trim().toLowerCase();
  const gate = await admitWalletEnrollment({ ip: context.ip, token: parsed.data.token, email });
  if (!gate.ok) return limited(gate.retryAfter);
  const attempt = await startEnrollment({
    organizationId: context.organization.id,
    token: parsed.data.token,
    email,
    sendOtp: async ({ email: to, otp, programName }) => {
      const text = `Your ${programName} enrollment code is ${otp}. It expires in 10 minutes.`;
      await sendEmail({
        to: { email: to },
        subject: `Your ${programName} enrollment code`,
        text,
        html: `<p>Your enrollment code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
      });
    },
  });
  return Response.json(attempt ? { ...ACCEPTED, attemptId: attempt.id } : INVALID, { status: 202 });
}
