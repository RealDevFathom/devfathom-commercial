import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { z } from 'zod';

import {
  marketingScopeInput,
  MarketingWorkflowError,
  validateMarketingBody,
  type MarketingScope,
} from './marketing-service';
import {
  renderVoucherMessage,
  VOUCHER_NON_DRUG_CATEGORIES,
  voucherEligibleCategories,
  VoucherScopeError,
} from './voucher-scope';

/**
 * DEV-27: an owner issues a voucher as a stored record carrying its
 * eligible-category allowlist (non-drug only). The counter redeems it by id;
 * `addSaleLine` enforces the allowlist on the server.
 */
export const voucherIssueInput = marketingScopeInput
  .extend({
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/),
    name: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(1000),
    discountMinor: z.number().int().positive().max(100_000_000),
    eligibleCategories: z.array(z.enum(VOUCHER_NON_DRUG_CATEGORIES)).max(10).optional(),
    validUntil: z.date().optional(),
    reviewed: z.literal(true),
  })
  .strict();

export type VoucherIssueInput = z.infer<typeof voucherIssueInput>;

/** The voucher text for each channel, each with its required footer. */
export function voucherMessages(body: string) {
  return {
    whatsapp: renderVoucherMessage(body, 'WHATSAPP'),
    print: renderVoucherMessage(body, 'PRINT'),
    inApp: renderVoucherMessage(body, 'IN_APP'),
  };
}

export async function issueVoucher(db: ScopedDb, scope: MarketingScope, input: VoucherIssueInput) {
  const parsed = voucherIssueInput.parse(input);
  validateMarketingBody(parsed.body);
  let messages: ReturnType<typeof voucherMessages>;
  let eligibleCategories: readonly string[];
  try {
    messages = voucherMessages(parsed.body);
    eligibleCategories = voucherEligibleCategories(parsed.eligibleCategories);
  } catch (error) {
    if (error instanceof VoucherScopeError)
      throw new MarketingWorkflowError(
        'Vouchers use generic retail copy and apply to non-drug categories only.'
      );
    throw error;
  }
  if (parsed.validUntil && parsed.validUntil.getTime() <= Date.now())
    throw new MarketingWorkflowError('Choose an expiry date in the future.');
  try {
    const voucher = await db.pharmacyVoucher.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        code: parsed.code.toUpperCase(),
        name: parsed.name,
        body: parsed.body,
        discountMinor: parsed.discountMinor,
        eligibleCategories: [...eligibleCategories],
        validUntil: parsed.validUntil ?? null,
        issuedByUserId: scope.actorId,
      },
    });
    return { voucher, messages };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new MarketingWorkflowError('A voucher with this code already exists in this branch.');
    throw error;
  }
}

export async function listVouchers(db: ScopedDb, scope: MarketingScope) {
  const vouchers = await db.pharmacyVoucher.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return vouchers.map((voucher) => ({ ...voucher, messages: voucherMessages(voucher.body) }));
}
