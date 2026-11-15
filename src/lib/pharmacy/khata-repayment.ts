import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma, type Currency } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { KHATA_REPAYMENT_KEY_PREFIX, postBookkeepingTransaction } from './bookkeeping';
import {
  FamilyKhataError,
  readKhataBalance,
  settleFamilyKhata,
  type FamilyKhataScope,
} from './family-khata';
import { earnKhataCollectionPoints } from './loyalty-khata-earn';
import {
  PharmacySettlementError,
  recordPharmacyCashMovement,
  requirePharmacyDayOpen,
} from './settlement';

/** Counter tenders a khata repayment can arrive in. Cash lands in the open drawer. */
export const KHATA_REPAYMENT_TENDERS = [
  'CASH',
  'BANK_TRANSFER',
  'RAAST',
  'JAZZCASH',
  'EASYPAISA',
] as const;
export type KhataRepaymentTender = (typeof KHATA_REPAYMENT_TENDERS)[number];

export type KhataRepaymentInput = {
  familyAccountId: string;
  amountMinor: number;
  tender: KhataRepaymentTender;
  /** Required for CASH: this counter device's open drawer for the business date gets the money. */
  deviceId?: string;
  /** Required for non-cash tenders: the payer's transfer/wallet reference. */
  payerReference?: string;
  businessDate: Date;
  idempotencyKey: string;
};

export type KhataRepaymentSlip = {
  receiptReference: string;
  familyAccountId: string;
  accountName: string;
  amountMinor: number;
  tender: KhataRepaymentTender;
  payerReference: string | null;
  balanceAfterMinor: number;
  recordedAt: Date;
  currency: string;
  replayed: boolean;
};

const MEMO_PREFIX = 'Khata payment · ';

function repaymentIdentity(scope: FamilyKhataScope, idempotencyKey: string) {
  const digest = createHash('sha256')
    .update(`${scope.organizationId}:${scope.branchId}:${idempotencyKey}`)
    .digest('hex');
  return {
    idempotencyKey: `${KHATA_REPAYMENT_KEY_PREFIX}${digest}`,
    receiptReference: `KP-${digest.slice(0, 10).toUpperCase()}`,
  };
}

/** Active accounts of this branch with their full-ledger balance, for the counter picker. */
export async function searchKhataRepaymentAccounts(
  db: ScopedDb,
  scope: FamilyKhataScope,
  query: string
) {
  const term = query.trim();
  const accounts = await db.pharmacyFamilyAccount.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      ...(term
        ? {
            OR: [
              { displayName: { contains: term, mode: 'insensitive' } },
              ...(/^\d{4}$/.test(term) ? [{ payer: { phoneLast4: term } }] : []),
            ],
          }
        : {}),
    },
    select: {
      id: true,
      displayName: true,
      creditLimitMinor: true,
      payer: { select: { phoneLast4: true } },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  return Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      displayName: account.displayName,
      creditLimitMinor: account.creditLimitMinor,
      phoneLast4: account.payer.phoneLast4 ?? null,
      balanceMinor: await readKhataBalance(db, scope, account.id),
    }))
  );
}

/**
 * K4 (DEV-731): receive money against a khata account at the counter.
 *
 * One transaction: the family account is locked, the payment settles open charges
 * oldest-first on the khata ledger, cash is paid into the counter's open drawer (so
 * the drawer count expects it), and a CUSTOMER_RECEIPT posts Cash/Bank against
 * receivables. The derived idempotency key makes a retried submit return the
 * original slip instead of taking the money twice.
 */
export async function recordKhataRepayment(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: KhataRepaymentInput
): Promise<KhataRepaymentSlip> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new FamilyKhataError('INVALID_AMOUNT');
  const payerReference = input.payerReference?.trim() || null;
  if (input.tender === 'CASH') {
    if (!input.deviceId) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  } else if (!payerReference) {
    throw new FamilyKhataError('REFERENCE_REQUIRED');
  }

  // Same lock the khata charge path takes first, so a sale and a repayment serialize.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${input.familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const account = await db.pharmacyFamilyAccount.findFirst({
    where: {
      id: input.familyAccountId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, displayName: true, active: true },
  });
  if (!account) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');

  const identity = repaymentIdentity(scope, input.idempotencyKey);
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { currency: true },
  });
  // The journal stores a closed currency set; the counter itself defaults to PKR.
  const currency: Currency = organization?.currency === 'USD' ? 'USD' : 'PKR';
  const memo = `${MEMO_PREFIX}${input.tender}`;
  const drawerReason = `Khata payment ${identity.receiptReference}`;

  const prior = await db.pharmacyBookkeepingTransaction.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: identity.idempotencyKey },
    include: { allocations: true },
  });
  if (prior) {
    // A retry must repeat the original request exactly: same account, amount, tender,
    // payer reference and (for cash) the same counter device's drawer.
    const priorDrawer =
      input.tender === 'CASH'
        ? await db.pharmacyDrawerMovement.findFirst({
            where: { organizationId: scope.organizationId, kind: 'PAID_IN', reason: drawerReason },
            select: { drawerSession: { select: { deviceId: true } } },
          })
        : null;
    if (
      prior.kind !== 'CUSTOMER_RECEIPT' ||
      prior.branchId !== scope.branchId ||
      prior.amountMinor !== input.amountMinor ||
      prior.memo !== memo ||
      prior.allocations[0]?.sourceId !== account.id ||
      (prior.bankReference ?? null) !== payerReference ||
      (input.tender === 'CASH' && priorDrawer?.drawerSession.deviceId !== input.deviceId)
    )
      throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
    // Rebuild the original slip: the name it was recorded under and the balance just after.
    return {
      receiptReference: prior.reference,
      familyAccountId: account.id,
      accountName: prior.counterpartyName ?? account.displayName,
      amountMinor: prior.amountMinor,
      tender: input.tender,
      payerReference: prior.bankReference ?? null,
      balanceAfterMinor: await readKhataBalance(db, scope, account.id, prior.occurredAt),
      recordedAt: prior.occurredAt,
      currency: prior.currency,
      replayed: true,
    };
  }

  // A recorded payment still replays above; only new money needs an active account.
  if (!account.active) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');

  if (input.tender === 'CASH') {
    // As for a cash sale tender: the server resolves this device's open drawer for the
    // business date, so cash cannot be credited to another counter's drawer.
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId!,
        businessDate: input.businessDate,
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    // Takes the day lock and refuses a closed day or a drawer that is not open.
    await recordPharmacyCashMovement(db, scope, {
      drawerSessionId: drawer.id,
      kind: 'PAID_IN',
      amountMinor: input.amountMinor,
      reason: drawerReason,
    });
  } else {
    await requirePharmacyDayOpen(db, scope, input.businessDate);
  }

  const recordedAt = new Date();
  // The only place a counter repayment settles khata debt; the receipt posted below does
  // not settle it again.
  const settlement = await settleFamilyKhata(db, scope, {
    familyAccountId: account.id,
    amountMinor: input.amountMinor,
    occurredAt: recordedAt,
    note: drawerReason,
  });
  // DEV-746: khata sales earn loyalty points when their debt is paid. Earned once, here,
  // from the payments just written; a retried submit replays above and never reaches this.
  await earnKhataCollectionPoints(db, scope, settlement.allocations);
  await postBookkeepingTransaction(db, scope, {
    reference: identity.receiptReference,
    kind: 'CUSTOMER_RECEIPT',
    amountMinor: input.amountMinor,
    occurredAt: recordedAt,
    idempotencyKey: identity.idempotencyKey,
    currency,
    counterpartyName: account.displayName,
    memo,
    bankReference: payerReference,
    fundingAccount: input.tender === 'CASH' ? 'CASH' : 'BANK',
    allocations: [
      {
        sourceKind: 'CUSTOMER_KHATA',
        sourceId: account.id,
        sourceReference: account.displayName.slice(0, 160),
        amountMinor: input.amountMinor,
      },
    ],
  });

  return {
    receiptReference: identity.receiptReference,
    familyAccountId: account.id,
    accountName: account.displayName,
    amountMinor: input.amountMinor,
    tender: input.tender,
    payerReference,
    balanceAfterMinor: await readKhataBalance(db, scope, account.id),
    recordedAt,
    currency,
    replayed: false,
  };
}
