import { z } from 'zod';

import { portalCodeSender } from '@/lib/pharmacy/customer-portal';
import { normalizeWhatsAppNumber } from '@/lib/pharmacy/whatsapp/messages';
import { createWhatsAppProvider, readWhatsAppConfig } from '@/lib/pharmacy/whatsapp/provider';
import { sendEmail } from '@/lib/email';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { startEnrollment } from '@/lib/restaurant/wallet/enrollment';
import { admitWalletEnrollment } from '@/lib/restaurant/wallet/enrollment-rate-limit';

import { enrollmentContext, INVALID, limited, tokenSchema } from '../shared';

const inputSchema = z.union([
  z.object({ token: tokenSchema, email: z.email().max(320) }).strict(),
  z
    .object({
      token: tokenSchema,
      phone: z
        .string()
        .max(24)
        .regex(/^[+0-9 ()-]+$/),
    })
    .strict(),
]);
const ACCEPTED = { ok: true, message: 'If this link is active, a code is on its way.' } as const;

export async function POST(request: Request) {
  const context = await enrollmentContext(request);
  const body = await readBoundedJson(request, 4 * 1024).catch(() => null);
  if (body?.tooLarge) return Response.json(INVALID, { status: 413 });
  const parsed = inputSchema.safeParse(body?.value);
  if (!context || !parsed.success) return Response.json(ACCEPTED, { status: 202 });
  if ('phone' in parsed.data) {
    const digits = normalizeWhatsAppNumber(parsed.data.phone);
    if (!digits) return Response.json(INVALID, { status: 400 });
    const phone = '+' + digits,
      token = parsed.data.token;
    const gate = await admitWalletEnrollment({ ip: context.ip, token, phone });
    if (!gate.ok) return limited(gate.retryAfter);
    const attempt = await startEnrollment({
      organizationId: context.organization.id,
      token,
      phone,
      sendOtp: async ({ otp }) => {
        const config =
          process.env.WALLET_OTP_LIVE_SEND === 'approved'
            ? readWhatsAppConfig({
                PHARMACY_WHATSAPP_PROVIDER: 'meta',
                PHARMACY_WHATSAPP_LIVE_SEND: 'approved',
                PHARMACY_WHATSAPP_ORGANIZATION_ID: context.organization.id,
                PHARMACY_WHATSAPP_ACCESS_TOKEN: process.env.WALLET_OTP_ACCESS_TOKEN,
                PHARMACY_WHATSAPP_PHONE_NUMBER_ID: process.env.WALLET_OTP_PHONE_NUMBER_ID,
                PHARMACY_WHATSAPP_TEMPLATE_PORTAL_SIGN_IN_CODE: process.env.WALLET_OTP_TEMPLATE,
                PHARMACY_WHATSAPP_TEMPLATE_LANGUAGE: process.env.WALLET_OTP_LANGUAGE,
              })
            : readWhatsAppConfig();
        // An OTP must reach a separately controlled phone. A mock acknowledgement is never proof.
        if (
          config.provider !== 'meta' ||
          !config.liveSendApproved ||
          config.organizationId !== context.organization.id
        )
          throw new Error('Phone delivery unavailable.');
        await portalCodeSender(
          config,
          createWhatsAppProvider(config),
          context.organization.id
        )({ to: digits, otp, body: 'Your wallet enrollment code is ' + otp });
      },
    });
    return Response.json(
      attempt
        ? { ...ACCEPTED, attemptId: attempt.id }
        : { ok: false, message: 'Phone verification is unavailable. Ask the business for help.' },
      { status: attempt ? 202 : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
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
