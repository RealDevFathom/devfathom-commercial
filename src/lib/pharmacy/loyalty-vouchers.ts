import 'server-only';

import { randomInt, randomUUID } from 'node:crypto';

import { rateLimit } from '@/lib/rate-limit';

export const VOUCHER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const VOUCHER_CODE_LENGTH = 12;
export const VOUCHER_NOT_FOUND = 'VOUCHER_NOT_FOUND' as const;

export type VoucherScope = 'WHOLE_BASKET' | 'NON_DRUG_ONLY';
export type VoucherStatus = 'ISSUED' | 'REDEEMED' | 'EXPIRED' | 'VOID';

export class PharmacyVoucherError extends Error {
  constructor(
    readonly reason:
      | typeof VOUCHER_NOT_FOUND
      | 'RATE_LIMITED'
      | 'MINIMUM_BASKET'
      | 'NO_ELIGIBLE_VALUE'
      | 'ALREADY_HAS_VOUCHER'
      | 'ABUSE_LIMIT'
      | 'OVERRIDE_REQUIRED'
      | 'COLLISION_RETRY_EXHAUSTED'
  ) {
    super(reason);
  }
}

export type LoyaltySettings = {
  voucherScope: VoucherScope; voucherValidityDays: number; maxIssuedPerCustomerPerPeriod: number;
  maxIssuedPerPhonePerPeriod: number; maxRedeemedPerCustomerPerPeriod: number;
  maxRedeemedPerPhonePerPeriod: number; abusePeriodDays: number; expiryOverrideGraceDays: number;
};

export async function updateLoyaltySettings(
  store: {
    readSettings(organizationId: string): Promise<LoyaltySettings>;
    updateSettingsAndAudit(input: { organizationId: string; actorId: string; oldValue: LoyaltySettings;
      newValue: LoyaltySettings }): Promise<LoyaltySettings>;
  },
  input: { organizationId: string; actorId: string; authorized: boolean; settings: LoyaltySettings }
) {
  if (!input.authorized) throw new PharmacyVoucherError('OVERRIDE_REQUIRED');
  const oldValue = await store.readSettings(input.organizationId);
  return store.updateSettingsAndAudit({ organizationId: input.organizationId, actorId: input.actorId,
    oldValue, newValue: input.settings });
}

export function generateVoucherCode(
  length = VOUCHER_CODE_LENGTH,
  pick: (maxExclusive: number) => number = randomInt
): string {
  if (!Number.isSafeInteger(length) || length < 10) throw new RangeError('VOUCHER_LENGTH');
  let code = '';
  for (let index = 0; index < length; index += 1) code += VOUCHER_ALPHABET[pick(VOUCHER_ALPHABET.length)];
  return code;
}

export type VoucherBasketLine = {
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  rx: boolean;
  otc: boolean;
};

export function voucherEligibleMinor(scope: VoucherScope, lines: readonly VoucherBasketLine[]) {
  return lines.reduce((total, line) => {
    if (scope === 'NON_DRUG_ONLY' && (line.rx || line.otc)) return total;
    const lineMinor = line.quantity * line.unitPriceMinor - line.discountMinor;
    if (!Number.isSafeInteger(lineMinor) || lineMinor < 0) throw new RangeError('INVALID_MONEY');
    return total + lineMinor;
  }, 0);
}

export function voucherRedemptionMinor(input: {
  valueMinor: number;
  minNextBasketMinor: number;
  scope: VoucherScope;
  lines: readonly VoucherBasketLine[];
}) {
  const basketMinor = voucherEligibleMinor('WHOLE_BASKET', input.lines);
  if (basketMinor < input.minNextBasketMinor) throw new PharmacyVoucherError('MINIMUM_BASKET');
  const eligibleMinor = voucherEligibleMinor(input.scope, input.lines);
  if (eligibleMinor <= 0) throw new PharmacyVoucherError('NO_ELIGIBLE_VALUE');
  return Math.min(input.valueMinor, eligibleMinor);
}

export async function admitVoucherLookup(input: {
  organizationId: string;
  branchId: string;
  userId: string;
  ip: string | null;
}) {
  const identity = `${input.organizationId}:${input.userId}:${input.ip ?? 'unknown'}`;
  const [userAndIp, branch] = await Promise.all([
    rateLimit(`pharmacy:voucher:lookup:identity:${identity}`, 20, 60_000),
    rateLimit(`pharmacy:voucher:lookup:branch:${input.organizationId}:${input.branchId}`, 200, 60_000),
  ]);
  if (!userAndIp.ok || !branch.ok) throw new PharmacyVoucherError('RATE_LIMITED');
  return { remaining: Math.min(userAndIp.remaining, branch.remaining) };
}

export type VoucherStore = {
  insertVoucher(row: {
    id: string; organizationId: string; branchId: string; code: string; valueMinor: number;
    scope: VoucherScope; customerId: string | null; phone: string | null; issuedAt: Date;
    expiresAt: Date; minNextBasketMinor: number; issuedByActorId: string;
  }): Promise<void>;
  countActivity(input: {
    organizationId: string; since: Date; customerId: string | null; phone: string | null;
    activity: 'ISSUED' | 'REDEEMED';
  }): Promise<{ customer: number; phone: number }>;
};

export async function issueVoucher(
  store: VoucherStore,
  input: {
    organizationId: string; branchId: string; valueMinor: number; scope?: VoucherScope;
    customerId?: string | null; phone?: string | null; issuedAt?: Date; validityDays?: number;
    minNextBasketMinor?: number; actorId: string; abusePeriodDays?: number;
    maxIssuedPerCustomer?: number; maxIssuedPerPhone?: number;
  },
  generate = generateVoucherCode
) {
  const issuedAt = input.issuedAt ?? new Date();
  const since = new Date(issuedAt.getTime() - (input.abusePeriodDays ?? 30) * 86_400_000);
  const counts = await store.countActivity({
    organizationId: input.organizationId, since, customerId: input.customerId ?? null,
    phone: input.phone ?? null, activity: 'ISSUED',
  });
  if ((input.customerId && counts.customer >= (input.maxIssuedPerCustomer ?? 5)) ||
      (input.phone && counts.phone >= (input.maxIssuedPerPhone ?? 5)))
    throw new PharmacyVoucherError('ABUSE_LIMIT');
  const expiresAt = new Date(issuedAt.getTime() + (input.validityDays ?? 30) * 86_400_000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = {
      id: randomUUID(), organizationId: input.organizationId, branchId: input.branchId,
      code: generate(), valueMinor: input.valueMinor, scope: input.scope ?? 'WHOLE_BASKET' as VoucherScope,
      customerId: input.customerId ?? null, phone: input.phone ?? null, issuedAt, expiresAt,
      minNextBasketMinor: input.minNextBasketMinor ?? 0, issuedByActorId: input.actorId,
    };
    try { await store.insertVoucher(row); return row; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002') throw error;
    }
  }
  throw new PharmacyVoucherError('COLLISION_RETRY_EXHAUSTED');
}

/** Unknown, expired, void, redeemed, and another tenant all intentionally collapse. */
export function publicVoucherResult<T extends { status: VoucherStatus; expiresAt: Date }>(
  voucher: T | null, now = new Date()
): T {
  if (!voucher || voucher.status !== 'ISSUED' || voucher.expiresAt <= now)
    throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
  return voucher;
}

export type RedeemableVoucher = {
  id: string; organizationId: string; branchId: string; status: VoucherStatus; valueMinor: number;
  scope: VoucherScope; customerId: string | null; phone: string | null; expiresAt: Date;
  minNextBasketMinor: number; redeemedSaleId: string | null;
};

export type VoucherRedemptionStore = VoucherStore & {
  lockVoucher(organizationId: string, code: string): Promise<RedeemableVoucher | null>;
  saleVoucherCount(organizationId: string, saleId: string): Promise<number>;
  saleLines(organizationId: string, branchId: string, saleId: string): Promise<VoucherBasketLine[]>;
  markRedeemed(input: {
    organizationId: string; voucherId: string; saleId: string; actorId: string; redeemedAt: Date;
  }): Promise<boolean>;
  createLoyaltyTender(input: {
    organizationId: string; branchId: string; saleId: string; amountMinor: number;
    businessDate: Date; actorId: string; deviceId: string; voucherId: string; idempotencyKey: string;
  }): Promise<{ tenderId: string }>;
  writeOverrideAudit(input: {
    organizationId: string; branchId: string; voucherId: string; saleId: string; actorId: string;
    reason: string; violations: string[];
  }): Promise<void>;
};

/** Must be called inside the same database transaction that settles the sale. */
export async function redeemVoucher(
  store: VoucherRedemptionStore,
  input: {
    organizationId: string; branchId: string; saleId: string; code: string; actorId: string;
    deviceId: string; businessDate: Date; idempotencyKey: string; now?: Date;
    override?: { authorized: boolean; reason: string; expiryGraceDays: number };
    abusePeriodDays?: number; maxRedeemedPerCustomer?: number; maxRedeemedPerPhone?: number;
  }
) {
  const now = input.now ?? new Date();
  const voucher = await store.lockVoucher(input.organizationId, input.code);
  // Tenant predicate belongs in lockVoucher; this deliberately reveals no cause.
  if (!voucher || voucher.organizationId !== input.organizationId || voucher.branchId !== input.branchId ||
      voucher.status !== 'ISSUED') throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
  if (await store.saleVoucherCount(input.organizationId, input.saleId))
    throw new PharmacyVoucherError('ALREADY_HAS_VOUCHER');
  const counts = await store.countActivity({
    organizationId: input.organizationId,
    since: new Date(now.getTime() - (input.abusePeriodDays ?? 30) * 86_400_000),
    customerId: voucher.customerId, phone: voucher.phone, activity: 'REDEEMED',
  });
  if ((voucher.customerId && counts.customer >= (input.maxRedeemedPerCustomer ?? 5)) ||
      (voucher.phone && counts.phone >= (input.maxRedeemedPerPhone ?? 5)))
    throw new PharmacyVoucherError('ABUSE_LIMIT');
  const lines = await store.saleLines(input.organizationId, input.branchId, input.saleId);
  const violations: string[] = [];
  if (voucher.expiresAt <= now) violations.push('EXPIRED');
  let amountMinor: number;
  try {
    amountMinor = voucherRedemptionMinor({ ...voucher, lines });
  } catch (error) {
    if (error instanceof PharmacyVoucherError && error.reason === 'MINIMUM_BASKET') {
      violations.push('MINIMUM_BASKET');
      const eligibleMinor = voucherEligibleMinor(voucher.scope, lines);
      if (eligibleMinor <= 0) throw new PharmacyVoucherError('NO_ELIGIBLE_VALUE');
      amountMinor = Math.min(voucher.valueMinor, eligibleMinor);
    } else throw error;
  }
  if (violations.length) {
    const graceEnd = new Date(voucher.expiresAt.getTime() + (input.override?.expiryGraceDays ?? 0) * 86_400_000);
    if (!input.override?.authorized || !input.override.reason.trim() ||
        (violations.includes('EXPIRED') && now > graceEnd)) throw new PharmacyVoucherError('OVERRIDE_REQUIRED');
    await store.writeOverrideAudit({ ...input, voucherId: voucher.id, reason: input.override.reason.trim(), violations });
  }
  // Conditional transition is a second guard if an adapter cannot provide FOR UPDATE semantics.
  if (!(await store.markRedeemed({ organizationId: input.organizationId, voucherId: voucher.id,
    saleId: input.saleId, actorId: input.actorId, redeemedAt: now })))
    throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
  const tender = await store.createLoyaltyTender({ ...input, voucherId: voucher.id, amountMinor });
  return { ...tender, voucherId: voucher.id, amountMinor, scope: voucher.scope, replayed: false };
}
