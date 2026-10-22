import 'server-only';

import { randomInt, randomUUID } from 'node:crypto';

import { can, type CanOptions, type Subject } from '@/lib/abac';
import { rateLimit } from '@/lib/rate-limit';

export const VOUCHER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const VOUCHER_CODE_LENGTH = 12;
export const VOUCHER_NOT_FOUND = 'VOUCHER_NOT_FOUND' as const;

export type VoucherScope = 'WHOLE_BASKET' | 'NON_DRUG_ONLY';
export type VoucherStatus = 'ISSUED' | 'REDEEMED' | 'EXPIRED' | 'VOID';
type VoucherAuthorization = {
  subject: Subject;
  db: NonNullable<CanOptions['db']>;
  ip?: string | null;
};

async function requireVoucherCapability(
  authorization: VoucherAuthorization,
  action: 'pharmacy:loyalty-manage' | 'pharmacy:counter'
) {
  if (
    !(await can(authorization.subject, action, undefined, {
      db: authorization.db,
      source: 'TRPC',
      ip: authorization.ip,
    }))
  )
    throw new PharmacyVoucherError('OVERRIDE_REQUIRED');
}

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
  voucherScope: VoucherScope;
  voucherValidityDays: number;
  maxIssuedPerCustomerPerPeriod: number;
  maxIssuedPerPhonePerPeriod: number;
  maxRedeemedPerCustomerPerPeriod: number;
  maxRedeemedPerPhonePerPeriod: number;
  abusePeriodDays: number;
  expiryOverrideGraceDays: number;
};

function validateSettings(settings: LoyaltySettings) {
  const values = Object.values(settings).filter(
    (value): value is number => typeof value === 'number'
  );
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    settings.voucherValidityDays < 1 ||
    settings.abusePeriodDays < 1
  )
    throw new RangeError('INVALID_SETTINGS');
}

export async function updateLoyaltySettings(
  store: {
    /** Creates the singleton if absent, locks it, then records its actual predecessor and update. */
    updateSettingsAndAuditLocked(input: {
      organizationId: string;
      actorId: string;
      newValue: LoyaltySettings;
    }): Promise<LoyaltySettings>;
  },
  input: {
    organizationId: string;
    actorId: string;
    authorization: VoucherAuthorization;
    settings: LoyaltySettings;
  }
) {
  await requireVoucherCapability(input.authorization, 'pharmacy:loyalty-manage');
  validateSettings(input.settings);
  return store.updateSettingsAndAuditLocked({
    organizationId: input.organizationId,
    actorId: input.actorId,
    newValue: input.settings,
  });
}

export function generateVoucherCode(
  length = VOUCHER_CODE_LENGTH,
  pick: (maxExclusive: number) => number = randomInt
): string {
  if (!Number.isSafeInteger(length) || length < 10) throw new RangeError('VOUCHER_LENGTH');
  let code = '';
  for (let index = 0; index < length; index += 1)
    code += VOUCHER_ALPHABET[pick(VOUCHER_ALPHABET.length)];
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
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isSafeInteger(line.unitPriceMinor) ||
      line.unitPriceMinor < 0 ||
      !Number.isSafeInteger(line.discountMinor) ||
      line.discountMinor < 0
    )
      throw new RangeError('INVALID_MONEY');
    const grossMinor = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(grossMinor)) throw new RangeError('INVALID_MONEY');
    if (scope === 'NON_DRUG_ONLY' && (line.rx || line.otc)) return total;
    const lineMinor = grossMinor - line.discountMinor;
    if (!Number.isSafeInteger(lineMinor) || lineMinor < 0) throw new RangeError('INVALID_MONEY');
    const next = total + lineMinor;
    if (!Number.isSafeInteger(next)) throw new RangeError('INVALID_MONEY');
    return next;
  }, 0);
}

export function voucherRedemptionMinor(input: {
  valueMinor: number;
  minNextBasketMinor: number;
  scope: VoucherScope;
  lines: readonly VoucherBasketLine[];
}) {
  if (
    !Number.isSafeInteger(input.valueMinor) ||
    input.valueMinor <= 0 ||
    !Number.isSafeInteger(input.minNextBasketMinor) ||
    input.minNextBasketMinor < 0
  )
    throw new RangeError('INVALID_MONEY');
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
    rateLimit(
      `pharmacy:voucher:lookup:branch:${input.organizationId}:${input.branchId}`,
      200,
      60_000
    ),
  ]);
  if (!userAndIp.ok || !branch.ok) throw new PharmacyVoucherError('RATE_LIMITED');
  return { remaining: Math.min(userAndIp.remaining, branch.remaining) };
}

export type VoucherStore = {
  insertVoucher(row: {
    id: string;
    organizationId: string;
    branchId: string;
    code: string;
    valueMinor: number;
    scope: VoucherScope;
    customerId: string | null;
    phone: string | null;
    issuedAt: Date;
    expiresAt: Date;
    minNextBasketMinor: number;
    issuedByActorId: string;
  }): Promise<void>;
  countActivity(input: {
    organizationId: string;
    since: Date;
    customerId: string | null;
    phone: string | null;
    activity: 'ISSUED' | 'REDEEMED';
  }): Promise<{ customer: number; phone: number }>;
  lockSettings(organizationId: string): Promise<LoyaltySettings>;
  branchBelongsToOrganization(organizationId: string, branchId: string): Promise<boolean>;
  /** Transactionally serializes the settings/count/insert sequence for these abuse identities. */
  withAbuseLock<T>(
    input: { organizationId: string; customerId: string | null; phone: string | null },
    operation: () => Promise<T>
  ): Promise<T>;
};

export async function issueVoucher(
  store: VoucherStore,
  input: {
    organizationId: string;
    branchId: string;
    valueMinor: number;
    customerId?: string | null;
    phone?: string | null;
    issuedAt?: Date;
    minNextBasketMinor?: number;
    actorId: string;
    authorization: VoucherAuthorization;
  },
  generate = generateVoucherCode
) {
  await requireVoucherCapability(input.authorization, 'pharmacy:counter');
  if (
    !Number.isSafeInteger(input.valueMinor) ||
    input.valueMinor <= 0 ||
    !Number.isSafeInteger(input.minNextBasketMinor ?? 0) ||
    (input.minNextBasketMinor ?? 0) < 0
  )
    throw new RangeError('INVALID_MONEY');
  const issuedAt = input.issuedAt ?? new Date();
  return store.withAbuseLock(
    {
      organizationId: input.organizationId,
      customerId: input.customerId ?? null,
      phone: input.phone ?? null,
    },
    async () => {
      const settings = await store.lockSettings(input.organizationId);
      validateSettings(settings);
      if (!(await store.branchBelongsToOrganization(input.organizationId, input.branchId)))
        throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
      const since = new Date(issuedAt.getTime() - settings.abusePeriodDays * 86_400_000);
      const counts = await store.countActivity({
        organizationId: input.organizationId,
        since,
        customerId: input.customerId ?? null,
        phone: input.phone ?? null,
        activity: 'ISSUED',
      });
      if (
        (input.customerId && counts.customer >= settings.maxIssuedPerCustomerPerPeriod) ||
        (input.phone && counts.phone >= settings.maxIssuedPerPhonePerPeriod)
      )
        throw new PharmacyVoucherError('ABUSE_LIMIT');
      const expiresAt = new Date(issuedAt.getTime() + settings.voucherValidityDays * 86_400_000);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const row = {
          id: randomUUID(),
          organizationId: input.organizationId,
          branchId: input.branchId,
          code: generate(),
          valueMinor: input.valueMinor,
          scope: settings.voucherScope,
          customerId: input.customerId ?? null,
          phone: input.phone ?? null,
          issuedAt,
          expiresAt,
          minNextBasketMinor: input.minNextBasketMinor ?? 0,
          issuedByActorId: input.actorId,
        };
        try {
          await store.insertVoucher(row);
          return row;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002')
            throw error;
        }
      }
      throw new PharmacyVoucherError('COLLISION_RETRY_EXHAUSTED');
    }
  );
}

/** Unknown, expired, void, redeemed, and another tenant all intentionally collapse. */
export function publicVoucherResult<T extends { status: VoucherStatus; expiresAt: Date }>(
  voucher: T | null,
  now = new Date()
): T {
  if (!voucher || voucher.status !== 'ISSUED' || voucher.expiresAt <= now)
    throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
  return voucher;
}

export type RedeemableVoucher = {
  id: string;
  organizationId: string;
  branchId: string;
  status: VoucherStatus;
  valueMinor: number;
  scope: VoucherScope;
  customerId: string | null;
  phone: string | null;
  expiresAt: Date;
  minNextBasketMinor: number;
  redeemedSaleId: string | null;
};

export type VoucherRedemptionStore = VoucherStore & {
  findRedemption(input: {
    organizationId: string;
    branchId: string;
    saleId: string;
    idempotencyKey: string;
  }): Promise<{
    tenderId: string;
    voucherId: string;
    amountMinor: number;
    scope: VoucherScope;
  } | null>;
  /** Holds voucher, settings, abuse-identity and idempotency locks through the entire callback. */
  withRedemptionLock<T>(
    input: { organizationId: string; code: string; idempotencyKey: string; branchId: string },
    operation: () => Promise<T>
  ): Promise<T>;
  lockVoucher(organizationId: string, code: string): Promise<RedeemableVoucher | null>;
  saleVoucherCount(organizationId: string, saleId: string): Promise<number>;
  saleLines(organizationId: string, branchId: string, saleId: string): Promise<VoucherBasketLine[]>;
  markRedeemed(input: {
    organizationId: string;
    voucherId: string;
    saleId: string;
    actorId: string;
    redeemedAt: Date;
  }): Promise<boolean>;
  createLoyaltyTender(input: {
    organizationId: string;
    branchId: string;
    saleId: string;
    amountMinor: number;
    businessDate: Date;
    actorId: string;
    deviceId: string;
    voucherId: string;
    idempotencyKey: string;
  }): Promise<{ tenderId: string }>;
  recordRedemption(input: {
    organizationId: string;
    branchId: string;
    saleId: string;
    voucherId: string;
    idempotencyKey: string;
    tenderId: string;
    amountMinor: number;
    scope: VoucherScope;
  }): Promise<void>;
  writeOverrideAudit(input: {
    organizationId: string;
    branchId: string;
    voucherId: string;
    saleId: string;
    actorId: string;
    reason: string;
    violations: string[];
  }): Promise<void>;
};

/** Must be called inside the same database transaction that settles the sale. */
export async function redeemVoucher(
  store: VoucherRedemptionStore,
  input: {
    organizationId: string;
    branchId: string;
    saleId: string;
    code: string;
    actorId: string;
    deviceId: string;
    businessDate: Date;
    idempotencyKey: string;
    now?: Date;
    authorization: VoucherAuthorization;
    override?: { reason: string };
  }
) {
  await requireVoucherCapability(input.authorization, 'pharmacy:counter');
  if (!input.idempotencyKey.trim()) throw new RangeError('INVALID_IDEMPOTENCY_KEY');
  const replay = await store.findRedemption(input);
  if (replay) return { ...replay, replayed: true };
  const now = input.now ?? new Date();
  return store.withRedemptionLock(
    {
      organizationId: input.organizationId,
      code: input.code,
      idempotencyKey: input.idempotencyKey,
      branchId: input.branchId,
    },
    async () => {
      const lockedReplay = await store.findRedemption(input);
      if (lockedReplay) return { ...lockedReplay, replayed: true };
      const voucher = await store.lockVoucher(input.organizationId, input.code);
      // Tenant predicate belongs in lockVoucher; this deliberately reveals no cause.
      if (
        !voucher ||
        voucher.organizationId !== input.organizationId ||
        voucher.branchId !== input.branchId ||
        voucher.status !== 'ISSUED'
      )
        throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
      const settings = await store.lockSettings(input.organizationId);
      validateSettings(settings);
      if (await store.saleVoucherCount(input.organizationId, input.saleId))
        throw new PharmacyVoucherError('ALREADY_HAS_VOUCHER');
      const counts = await store.countActivity({
        organizationId: input.organizationId,
        since: new Date(now.getTime() - settings.abusePeriodDays * 86_400_000),
        customerId: voucher.customerId,
        phone: voucher.phone,
        activity: 'REDEEMED',
      });
      if (
        (voucher.customerId && counts.customer >= settings.maxRedeemedPerCustomerPerPeriod) ||
        (voucher.phone && counts.phone >= settings.maxRedeemedPerPhonePerPeriod)
      )
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
        await requireVoucherCapability(input.authorization, 'pharmacy:loyalty-manage');
        const graceEnd = new Date(
          voucher.expiresAt.getTime() + settings.expiryOverrideGraceDays * 86_400_000
        );
        if (!input.override?.reason.trim() || (violations.includes('EXPIRED') && now > graceEnd))
          throw new PharmacyVoucherError('OVERRIDE_REQUIRED');
        await store.writeOverrideAudit({
          ...input,
          voucherId: voucher.id,
          reason: input.override.reason.trim(),
          violations,
        });
      }
      // Conditional transition is a second guard if an adapter cannot provide FOR UPDATE semantics.
      if (
        !(await store.markRedeemed({
          organizationId: input.organizationId,
          voucherId: voucher.id,
          saleId: input.saleId,
          actorId: input.actorId,
          redeemedAt: now,
        }))
      )
        throw new PharmacyVoucherError(VOUCHER_NOT_FOUND);
      const tender = await store.createLoyaltyTender({
        ...input,
        voucherId: voucher.id,
        amountMinor,
      });
      await store.recordRedemption({
        organizationId: input.organizationId,
        branchId: input.branchId,
        saleId: input.saleId,
        voucherId: voucher.id,
        idempotencyKey: input.idempotencyKey,
        tenderId: tender.tenderId,
        amountMinor,
        scope: voucher.scope,
      });
      return {
        ...tender,
        voucherId: voucher.id,
        amountMinor,
        scope: voucher.scope,
        replayed: false,
      };
    }
  );
}
