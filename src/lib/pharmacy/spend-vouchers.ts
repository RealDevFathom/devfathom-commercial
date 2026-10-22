import 'server-only';

import { randomUUID } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { generateVoucherCode } from './loyalty-vouchers';
import { claimMessageLogInTransaction } from './whatsapp/message-log';

export type SpendVoucherTier = { thresholdMinor: number; valueMinor: number };
export const MAX_DATABASE_MINOR = 2_147_483_647;
type IssuedVoucher = { id: string; code: string; valueMinor: number; status: string } & Record<string, unknown>;
type SpendVoucherSettings = {
  spendVoucherTiers: unknown; spendVoucherMinBasketMinor: number;
  voucherValidityDays: number; voucherScope: 'WHOLE_BASKET' | 'NON_DRUG_ONLY';
};

export const DEFAULT_SPEND_VOUCHER_TIERS: readonly SpendVoucherTier[] = [
  { thresholdMinor: 1_000_000, valueMinor: 50_000 },
  { thresholdMinor: 2_000_000, valueMinor: 100_000 },
];

export function validateSpendVoucherTiers(value: unknown): SpendVoucherTier[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new RangeError('INVALID_SPEND_VOUCHER_TIERS');
  const tiers = value.map((tier) => {
    if (!tier || typeof tier !== 'object') throw new RangeError('INVALID_SPEND_VOUCHER_TIERS');
    const keys = Object.keys(tier);
    if (keys.length !== 2 || !keys.includes('thresholdMinor') || !keys.includes('valueMinor'))
      throw new RangeError('INVALID_SPEND_VOUCHER_TIERS');
    const { thresholdMinor, valueMinor } = tier as Record<string, unknown>;
    if (!Number.isSafeInteger(thresholdMinor) || Number(thresholdMinor) <= 0 ||
        !Number.isSafeInteger(valueMinor) || Number(valueMinor) <= 0 ||
        Number(valueMinor) > MAX_DATABASE_MINOR)
      throw new RangeError('INVALID_SPEND_VOUCHER_TIERS');
    return { thresholdMinor: Number(thresholdMinor), valueMinor: Number(valueMinor) };
  }).sort((a, b) => a.thresholdMinor - b.thresholdMinor);
  if (tiers.some((tier, index) => index > 0 && tier.thresholdMinor === tiers[index - 1]!.thresholdMinor))
    throw new RangeError('INVALID_SPEND_VOUCHER_TIERS');
  return tiers;
}

/** Exactly one voucher qualifies: the tier with the greatest threshold at or below eligible spend. */
export function qualifyingSpendVoucherTier(netPaidMinor: number, value: unknown) {
  if (!Number.isSafeInteger(netPaidMinor) || netPaidMinor < 0) throw new RangeError('INVALID_MONEY');
  return validateSpendVoucherTiers(value).filter((tier) => tier.thresholdMinor <= netPaidMinor).at(-1) ?? null;
}

function uniqueConstraintTarget(error: unknown): string[] | null {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002') return null;
  const target = 'meta' in error && error.meta && typeof error.meta === 'object' &&
    'target' in error.meta ? error.meta.target : undefined;
  if (typeof target === 'string') return [target];
  return Array.isArray(target) && target.every((part) => typeof part === 'string') ? target : [];
}

function isIssuedSaleConflict(target: string[]) {
  return target.includes('pharmacy_vouchers_issued_sale_key') ||
    (target.includes('organizationId') && target.includes('issuedSaleId'));
}

function isVoucherCodeConflict(target: string[]) {
  return target.includes('pharmacy_vouchers_org_code_key') ||
    target.includes('pharmacy_vouchers_organizationId_code_key') ||
    (target.includes('organizationId') && target.includes('code'));
}

/**
 * Called by checkout completion while its sale transaction is open. Eligible spend is money
 * actually paid after line discounts and voucher/loyalty tenders; refunds are not spend.
 * The issuedSaleId unique key makes completion retries return the original voucher.
 */
export async function issueSpendVoucherForCompletedSale(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  issuedAt = new Date()
) {
  // These casts bridge checked-in Prisma output until the normal migration deploy regenerates it.
  const voucherStore = db.pharmacyVoucher as unknown as {
    findFirst(args: unknown): Promise<IssuedVoucher | null>;
    create(args: unknown): Promise<IssuedVoucher>;
  };
  const settingsStore = db.pharmacyLoyaltySettings as unknown as {
    findUnique(args: unknown): Promise<SpendVoucherSettings | null>;
  };
  const prior = await voucherStore.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, issuedSaleId: saleId },
  });
  if (prior) return { voucher: prior, replayed: true };
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      tenders: { select: { type: true, amountMinor: true } },
      customer: { include: { patient: { select: { phone: true } } } },
    },
  });
  if (!sale?.customer) return null;
  const settings = await settingsStore.findUnique({
    where: { organizationId: scope.organizationId },
  });
  const tiers = settings?.spendVoucherTiers ?? DEFAULT_SPEND_VOUCHER_TIERS;
  const netPaidMinor = sale.tenders
    .filter((tender) => tender.type !== 'LOYALTY')
    .reduce((sum, tender) => sum + tender.amountMinor, 0);
  const tier = qualifyingSpendVoucherTier(netPaidMinor, tiers);
  if (!tier) return null;
  const validityDays = settings?.voucherValidityDays ?? 30;
  const expiresAt = new Date(issuedAt.getTime() + validityDays * 86_400_000);
  let voucher;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      voucher = await voucherStore.create({ data: {
        id: randomUUID(), organizationId: scope.organizationId, branchId: scope.branchId,
        code: generateVoucherCode(), valueMinor: tier.valueMinor,
        scope: settings?.voucherScope ?? 'WHOLE_BASKET', customerId: sale.customerId,
        phone: sale.customer.patient.phone, issuedAt, expiresAt,
        minNextBasketMinor: settings?.spendVoucherMinBasketMinor ?? 0,
        issuedByActorId: scope.actorId, issuedSaleId: sale.id,
      } });
      break;
    } catch (error) {
      const target = uniqueConstraintTarget(error);
      if (!target) throw error;
      if (isIssuedSaleConflict(target)) {
        const replay = await voucherStore.findFirst({
          where: { organizationId: scope.organizationId, branchId: scope.branchId,
            issuedSaleId: sale.id },
        });
        if (replay) return { voucher: replay, replayed: true };
        // A sale identifier claimed outside this branch must never disclose or reuse that voucher.
        throw new Error('VOUCHER_ISSUED_SALE_SCOPE_CONFLICT');
      }
      if (!isVoucherCodeConflict(target)) throw error;
    }
  }
  if (!voucher) throw new Error('VOUCHER_COLLISION_RETRY_EXHAUSTED');

  // Transactional queue only. The existing provider's production live-send block remains intact.
  if (sale.customer.whatsappOptIn === true) {
    const consent = await db.patientConsent.findFirst({
      where: { organizationId: scope.organizationId, patientId: sale.customer.patientId,
        purpose: 'LOYALTY', channel: 'WHATSAPP', granted: true, revokedAt: null,
        recordedAt: { lte: issuedAt } },
      orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
      select: { granted: true, revokedAt: true },
    });
    if (consent?.granted && !consent.revokedAt)
      await claimMessageLogInTransaction(db, {
        organizationId: scope.organizationId, branchId: scope.branchId,
        customerId: sale.customer.id, patientId: sale.customer.patientId,
        phoneLast4: sale.customer.phoneLast4, kind: 'SPEND_VOUCHER',
        dedupeKey: `spend-voucher:${sale.id}`, direction: 'OUTBOUND', status: 'PENDING',
        templateName: 'spend_voucher_transactional',
      });
  }
  return { voucher, replayed: false };
}

export async function voidUnredeemedSpendVoucherForRefund(
  db: ScopedDb, scope: LedgerScope, saleId: string
) {
  const voucherStore = db.pharmacyVoucher as unknown as {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  return voucherStore.updateMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId,
      issuedSaleId: saleId, status: 'ISSUED' },
    data: { status: 'VOID' },
  });
}
