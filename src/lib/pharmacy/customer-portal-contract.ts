import { z } from 'zod';

export const portalId = z.string().trim().min(1).max(128);
export const customerPortalSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    otpTtlMinutes: z.number().int().min(1).max(30).default(10),
    otpMaxAttempts: z.number().int().min(1).max(10).default(5),
    sessionMinutes: z.number().int().min(5).max(1440).default(60),
    loyaltyLabel: z.string().trim().min(1).max(80).default('Loyalty points'),
    raastPayeeLabel: z.string().trim().max(120).default(''),
    raastId: z
      .string()
      .trim()
      .max(34)
      .regex(/^(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|\+?\d{10,15})?$/)
      .default(''),
    nonDrugOffersEnabled: z.boolean().default(false),
    deliveryFeeWaived: z.boolean().default(false),
  })
  .strict()
  .refine((value) => Boolean(value.raastId) === Boolean(value.raastPayeeLabel), {
    message: 'Provide both the verified Raast ID and account title, or leave both empty.',
  });
export type CustomerPortalSettings = z.infer<typeof customerPortalSettingsSchema>;

export const customerPortalCommand = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('start'), branchId: portalId, phone: z.string().min(8).max(32) })
    .strict(),
  z
    .object({
      action: z.literal('verify'),
      challengeId: z.uuid(),
      code: z.string().regex(/^\d{6}$/),
    })
    .strict(),
  z.object({ action: z.literal('logout') }).strict(),
  z.object({ action: z.literal('refill'), saleId: portalId, idempotencyKey: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('photo'),
      idempotencyKey: z.uuid(),
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      dataBase64: z
        .string()
        .min(1)
        .max(4 * Math.ceil((5 * 1024 * 1024) / 3)),
    })
    .strict(),
]);

export type CustomerPortalSummary = {
  customerName: string;
  branchName: string;
  currency: string;
  loyaltyLabel: string;
  pointsBalance: number | null;
  offers: string[];
  receipts: { id: string; receiptNumber: number | null; completedAt: string | null }[];
  requests: { id: string; kind: string; status: string; createdAt: string }[];
  accounts: { id: string; displayName: string; balanceMinor: number }[];
  raast: { id: string; payee: string } | null;
};

export const portalStaffCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('settings'),
      branchId: portalId,
      pin: z.string().regex(/^\d{4,8}$/),
      settings: customerPortalSettingsSchema,
    })
    .strict(),
  z
    .object({
      action: z.enum(['APPROVE', 'DECLINE', 'FULFIL']),
      branchId: portalId,
      requestId: z.uuid(),
      pin: z.string().regex(/^\d{4,8}$/),
      saleId: portalId.optional(),
    })
    .strict(),
]);
