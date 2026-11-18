import { Prisma } from '@/generated/prisma/client';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { z } from 'zod';

import {
  authorizeCounterApproval,
  CounterApprovalDenied,
  confirmCounterApproval,
  type CounterApproval,
} from './counter-line-approval';
import { verifyRefundPin } from './refund-authorization';
import {
  VOUCHER_MAX_DISCOUNT_MINOR,
  VOUCHER_MAX_USES,
  VOUCHER_MAX_VALIDITY_DAYS,
  VOUCHER_SECOND_APPROVER_POLICY,
  VOUCHER_SOLE_OWNER_POLICY,
  VOUCHER_WITHIN_CAP_POLICY,
  voucherNeedsSecondApprover,
} from './voucher-controls';

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

const DAY_MS = 24 * 60 * 60 * 1000;

const approvalPin = z
  .object({ staffProfileId: z.string().trim().min(1).max(128), pin: z.string().regex(/^\d{4,8}$/) })
  .strict();

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
    discountMinor: z.number().int().positive().max(VOUCHER_MAX_DISCOUNT_MINOR),
    eligibleCategories: z.array(z.enum(VOUCHER_NON_DRUG_CATEGORIES)).max(10).optional(),
    // DEV-819: a use limit and an expiry are required.
    maxUses: z.number().int().min(1).max(VOUCHER_MAX_USES),
    validUntil: z.date(),
    // DEV-819: above the value cap, a second approver's PIN (or the solo owner's own).
    approval: approvalPin.optional(),
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

export class VoucherApprovalRequired extends MarketingWorkflowError {
  constructor() {
    super(
      'This voucher is above the value cap. A second manager or owner must approve it with their PIN.'
    );
  }
}

/**
 * DEV-819: resolves the second approval for a voucher above the value cap BEFORE the issue
 * transaction opens, so a wrong PIN's lockout strike commits even though the issue fails.
 * Returns null when the voucher is within the cap. `issueVoucher` re-checks the result.
 */
export async function authorizeVoucherIssue(
  db: ScopedDb,
  scope: MarketingScope,
  input: VoucherIssueInput
): Promise<CounterApproval | null> {
  const parsed = voucherIssueInput.parse(input);
  if (!voucherNeedsSecondApprover(parsed)) return null;
  if (!parsed.approval) throw new VoucherApprovalRequired();
  try {
    return await authorizeCounterApproval(db, scope, 'DISCOUNT', parsed.approval);
  } catch (error) {
    if (error instanceof CounterApprovalDenied) throw new VoucherApprovalRequired();
    throw error;
  }
}

export async function issueVoucher(
  db: ScopedDb,
  scope: MarketingScope,
  input: VoucherIssueInput,
  approval: CounterApproval | null = null
) {
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
  const now = Date.now();
  if (parsed.validUntil.getTime() <= now)
    throw new MarketingWorkflowError('Choose an expiry date in the future.');
  if (parsed.validUntil.getTime() > now + VOUCHER_MAX_VALIDITY_DAYS * DAY_MS)
    throw new MarketingWorkflowError(
      `Choose an expiry within ${VOUCHER_MAX_VALIDITY_DAYS} days of today.`
    );
  // DEV-819: above the cap the approval must be a verified second approver, or the solo
  // owner's own fresh PIN. The issuer's session alone never approves it.
  let approvedByUserId = scope.actorId;
  let approvalPolicy = VOUCHER_WITHIN_CAP_POLICY;
  let approvalCredentialId: string | null = null;
  if (voucherNeedsSecondApprover(parsed)) {
    if (!approval || !approval.credentialId) throw new VoucherApprovalRequired();
    const selfApproved = approval.approvedByUserId === scope.actorId;
    if (
      selfApproved !== approval.selfApproved ||
      approval.approvalPolicy !==
        (selfApproved ? VOUCHER_SOLE_OWNER_POLICY : VOUCHER_SECOND_APPROVER_POLICY)
    )
      throw new VoucherApprovalRequired();
    try {
      await confirmCounterApproval(db, scope, 'DISCOUNT', approval);
    } catch (error) {
      if (error instanceof CounterApprovalDenied) throw new VoucherApprovalRequired();
      throw error;
    }
    approvedByUserId = approval.approvedByUserId;
    approvalPolicy = approval.approvalPolicy;
    approvalCredentialId = approval.credentialId;
  }
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
        validUntil: parsed.validUntil,
        maxUses: parsed.maxUses,
        issuedByUserId: scope.actorId,
        approvedByUserId,
        approvalPolicy,
        approvalCredentialId,
      },
    });
    if (approvalCredentialId)
      await db.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'EXECUTE',
          action: 'pharmacy_voucher_approval',
          outcome: 'SUCCESS',
          targetType: 'PharmacyVoucher',
          targetId: voucher.id,
          metadata: {
            branchId: scope.branchId,
            policy: approvalPolicy,
            approvedByUserId,
            selfApproved: approvedByUserId === scope.actorId,
            pinVerified: true,
            credentialId: approvalCredentialId,
            discountMinor: parsed.discountMinor,
            maxUses: parsed.maxUses,
          },
        },
      });
    return { voucher, messages };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new MarketingWorkflowError('A voucher with this code already exists in this branch.');
    throw error;
  }
}

export const voucherRevokeInput = marketingScopeInput
  .extend({
    voucherId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export type VoucherRevokeInput = z.infer<typeof voucherRevokeInput>;

/** DEV-819: revoking a voucher stops every later redemption; it cannot be undone. */
export async function revokeVoucher(
  db: ScopedDb,
  scope: MarketingScope,
  input: VoucherRevokeInput
) {
  const parsed = voucherRevokeInput.parse(input);
  const revoked = await db.pharmacyVoucher.updateMany({
    where: {
      id: parsed.voucherId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      revokedAt: null,
    },
    data: {
      active: false,
      revokedAt: new Date(),
      revokedByUserId: scope.actorId,
      revokeReason: parsed.reason,
    },
  });
  if (revoked.count !== 1)
    throw new MarketingWorkflowError('This voucher was not found or is already revoked.');
  return { voucherId: parsed.voucherId, revoked: true as const };
}

/**
 * DEV-819: the redeeming cashier re-enters their own staff PIN. Verified in its own tenant
 * transaction so a wrong PIN's lockout strike commits even though the sale line is refused.
 */
export async function authenticateVoucherCashierPin(input: {
  organizationId: string;
  actorId: string;
  pin: string | undefined;
}): Promise<boolean> {
  const { pin } = input;
  if (!pin) return false;
  const result = await withTenantDb(
    input.organizationId,
    (db) =>
      verifyRefundPin(db, {
        organizationId: input.organizationId,
        actorId: input.actorId,
        pin,
        action: 'pharmacy.voucherRedemption',
      }),
    { userId: input.actorId, skipDrain: true }
  );
  return 'verified' in result;
}

export async function listVouchers(db: ScopedDb, scope: MarketingScope) {
  const vouchers = await db.pharmacyVoucher.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return vouchers.map((voucher) => ({ ...voucher, messages: voucherMessages(voucher.body) }));
}

export const counterVoucherInput = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/),
  })
  .strict();

export type CounterVoucherStatus = 'READY' | 'REVOKED' | 'EXPIRED' | 'USED_UP';

/**
 * DEV-780: the counter resolves a typed or scanned voucher code to the stored voucher of this
 * branch, so the cashier sees what it is worth and how many uses remain before applying it.
 * This read takes no use and grants nothing: `addSaleLine` re-checks every rule (cashier PIN,
 * expiry, revocation, use limit, issuer and approver, eligible categories) when it redeems.
 */
export async function lookupCounterVoucher(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  code: string,
  now = new Date()
) {
  const parsed = counterVoucherInput.parse({ code });
  const voucher = await db.pharmacyVoucher.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      code: parsed.code.toUpperCase(),
    },
    select: {
      id: true,
      code: true,
      name: true,
      discountMinor: true,
      maxUses: true,
      usedCount: true,
      validUntil: true,
      active: true,
      revokedAt: true,
    },
  });
  if (!voucher) return null;
  const status: CounterVoucherStatus =
    voucher.revokedAt !== null || !voucher.active
      ? 'REVOKED'
      : voucher.validUntil.getTime() <= now.getTime()
        ? 'EXPIRED'
        : voucher.usedCount >= voucher.maxUses
          ? 'USED_UP'
          : 'READY';
  return {
    id: voucher.id,
    code: voucher.code,
    name: voucher.name,
    discountMinor: voucher.discountMinor,
    usesLeft: Math.max(0, voucher.maxUses - voucher.usedCount),
    maxUses: voucher.maxUses,
    validUntil: voucher.validUntil,
    status,
  };
}
