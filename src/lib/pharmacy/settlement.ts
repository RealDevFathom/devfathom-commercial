import { pricePrepaidSale } from './prepaid-discount';
import { assertPrepaidPin, movePrepaid, PREPAID_PROVIDER } from './prepaid-tiers';
import { requestCounterEvidence } from './counter-evidence';
import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceToday } from '@/lib/timezone';
import { assertPostingPeriodsOpen } from '@/lib/finance/journal';

import { reverseRefundedEarnedPoints } from './customer-loyalty-earned-reversal';
import { accrueSalePoints, restoreRefundedLoyaltyPoints } from './customer-loyalty';
import { returnedLineValue } from './sales';
import { postDailyCloseEntry, postTenderEntry, postTenderRefundEntry } from './finance-postings';
import { firstCloseIsFinal } from './migration/first-close';
import { assertSaleBatchesSellable } from './sale-batch-safety';
import { completePaidPharmacySale, completionSaleInclude } from './sale-completion';
import { assertRxSaleAllowed } from './rx-sale-gate';
import { assertRxLinesPrescribed } from './rx-prescription-reference';
import { assertStoredPharmacyMayOperate } from './regulatory';
import type { LedgerScope } from './stock-ledger';
import { paymentSandboxAdmitted } from './payment-sandbox-admission';
import { authenticatePharmacyCommand, validateLeasedReceiptReplay } from './sales';
import type { PharmacyCommandAuthentication, PharmacyLeasedReceipt } from './sales';
import {
  isManualTender,
  validateManualTender,
  type ManualTenderType,
  aggregateTenderTotals,
  MANUAL_CARD_PROVIDER,
  manualCardCaptureSchema,
  bankTransferCaptureSchema,
} from './manual-payments';
import { readManualPaymentSettings } from './manual-payment-settings';
import { counterOperatorDenial } from './counter-capability';

export type PharmacyTenderType = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT' | ManualTenderType;

export class PharmacySettlementError extends Error {
  constructor(
    readonly reason:
      | 'DAY_CLOSED'
      | 'BUSINESS_DATE_NOT_CURRENT'
      | 'INVALID_RECEIPT_LEASE'
      | 'LEASE_REQUIRES_SETTLEMENT'
      | 'SALE_NOT_OPEN'
      | 'INVALID_AMOUNT'
      | 'OVER_TENDER'
      | 'DRAWER_NOT_OPEN'
      | 'DRAWER_NOT_YOURS'
      | 'CASHIER_NOT_ASSIGNED'
      | 'REFUND_EXCEEDS_TENDER'
      | 'IDEMPOTENCY_CONFLICT'
      | 'UNCERTIFIED_PROVIDER'
      | 'MOCK_PROVIDER_IN_RELEASE'
      | 'OPEN_DRAWER'
      | 'REOPEN_REASON_REQUIRED'
      | 'INVALID_MANUAL_CAPTURE'
      | 'DAY_NOT_CLOSED'
      | 'REOPEN_NOT_TODAY'
      | 'PREPAID_REFUND_RESTORES_BALANCE'
      | 'TENDER_ATTEMPT_DISCARDED'
  ) {
    super(reason);
  }
}

export interface PharmacyPaymentAdapter {
  readonly name: string;
  readonly certified: boolean;
  readonly localSandbox?: true;
  execute(input: {
    capability: 'SALE' | 'REFUND';
    amountMinor: number;
    operationRef: string;
    priorRef?: string;
  }): Promise<{ approved: boolean; providerRef: string }>;
}

export function requireReleaseSafeAdapter(
  adapter: PharmacyPaymentAdapter,
  environment = process.env.NODE_ENV
) {
  if (adapter.localSandbox) {
    if (adapter.name !== 'LOCAL_TOKEN_SANDBOX' || !paymentSandboxAdmitted())
      throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    return adapter;
  }
  if (environment === 'production' && adapter.name.toUpperCase() === 'MOCK')
    throw new PharmacySettlementError('MOCK_PROVIDER_IN_RELEASE');
  if (!adapter.certified) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
  return adapter;
}

export function saleTotalMinor(
  lines: readonly {
    quantity: number;
    unitPriceMinor: number;
    grossMinor?: number;
    discountMinor: number;
  }[]
) {
  return lines.reduce(
    (total, line) =>
      total + (line.grossMinor ?? line.quantity * line.unitPriceMinor) - line.discountMinor,
    0
  );
}

export function assertPositiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const tenderResultSchema = z
  .object({
    tenderId: z.string().min(1),
    settled: z.boolean(),
    receiptNumber: z.number().int().positive().nullable(),
    remainingMinor: z.number().int().nonnegative(),
  })
  .strict()
  .refine((result) =>
    result.settled
      ? result.receiptNumber !== null && result.remainingMinor === 0
      : result.receiptNumber === null && result.remainingMinor > 0
  );

export type PharmacyTenderOutcome =
  | { status: 'ACCEPTED'; replayUnsafe: true; result: z.infer<typeof tenderResultSchema> }
  | { status: 'NOT_FOUND' | 'UNKNOWN'; replayUnsafe: true };

/** Reads evidence of this exact attempt; absence never authorizes another tender. */
export async function readPharmacyTenderOutcome(
  db: ScopedDb,
  scope: LedgerScope,
  input: Omit<Parameters<typeof applyPharmacyTender>[2], 'adapter'>
): Promise<PharmacyTenderOutcome> {
  const unknown = { status: 'UNKNOWN', replayUnsafe: true } as const;
  try {
    // Check sale access before even looking up a device/key, including completed sales.
    const sale = await db.pharmacySale.findFirst({
      where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
      select: { id: true, organizationId: true, branchId: true },
    });
    if (
      !sale ||
      sale.id !== input.saleId ||
      sale.organizationId !== scope.organizationId ||
      sale.branchId !== scope.branchId
    )
      return unknown;

    const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
      where: {
        organizationId_deviceId_key: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId,
          key: input.idempotencyKey,
        },
      },
      select: {
        organizationId: true,
        deviceId: true,
        key: true,
        commandType: true,
        payloadHash: true,
        resultPayload: true,
      },
    });
    // Rolled-back and in-flight attempts can both be invisible here.
    if (!prior) return { status: 'NOT_FOUND', replayUnsafe: true };
    if (
      prior.organizationId !== scope.organizationId ||
      prior.deviceId !== input.deviceId ||
      prior.key !== input.idempotencyKey ||
      prior.commandType !== 'tender' ||
      prior.payloadHash !== hash(input)
    )
      return unknown;

    const parsed = tenderResultSchema.safeParse(prior.resultPayload);
    if (!parsed.success) return unknown;
    const result = parsed.data;
    const tender = await db.pharmacyTender.findFirst({
      where: {
        id: result.tenderId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: input.saleId,
      },
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        saleId: true,
        deviceId: true,
        type: true,
        amountMinor: true,
        businessDate: true,
        cashReceivedMinor: true,
        changeGivenMinor: true,
        provider: true,
        providerRef: true,
        payerName: true,
        referenceSkipped: true,
        approvalCode: true,
        confirmedById: true,
      },
    });
    const cashReceivedMinor =
      input.type === 'CASH' ? (input.cashReceivedMinor ?? input.amountMinor) : null;
    if (
      !tender ||
      tender.id !== result.tenderId ||
      tender.organizationId !== scope.organizationId ||
      tender.branchId !== scope.branchId ||
      tender.saleId !== input.saleId ||
      tender.deviceId !== input.deviceId ||
      tender.type !== input.type ||
      tender.amountMinor !== input.amountMinor ||
      // businessDate is @db.Date; the hash above still binds the original timestamp.
      tender.businessDate.toISOString().slice(0, 10) !==
        input.businessDate.toISOString().slice(0, 10) ||
      tender.cashReceivedMinor !== cashReceivedMinor ||
      tender.changeGivenMinor !==
        (cashReceivedMinor === null ? null : cashReceivedMinor - input.amountMinor)
    )
      return unknown;

    if (isManualTender(input.type) && (tender.provider !== 'MANUAL_MERCHANT' ||
      tender.providerRef !== (input.providerRef ?? null) || tender.payerName !== input.payerName?.trim() ||
      tender.referenceSkipped !== (input.referenceSkipped ?? false))) return unknown;
    if (input.approvalCode !== undefined && (tender.provider !== MANUAL_CARD_PROVIDER ||
      tender.providerRef !== input.providerRef?.trim() ||
      tender.approvalCode !== input.approvalCode.trim())) return unknown;

    if (input.type === 'BANK_TRANSFER' &&
      (tender.providerRef ?? null) !== (input.providerRef?.trim() ?? null)) return unknown;

    return { status: 'ACCEPTED', replayUnsafe: true, result };
  } catch {
    // This path only reads. A failed read is uncertainty, never proof of rejection.
    return unknown;
  }
}

/** DEV-712: the idempotency record a supervisor's discard leaves on the attempt's key. */
export const DISCARDED_TENDER_COMMAND = 'tender-discard';

export type PharmacyTenderDiscardRecord = {
  reason: string;
  approvedByUserId: string;
  approvalPolicy: string;
  selfApproved: boolean;
};

export type PharmacyTenderDiscard =
  | { status: 'DISCARDED' }
  | { status: 'ACCEPTED'; result: z.infer<typeof tenderResultSchema> };

/**
 * DEV-712: a supervisor discards a counter payment attempt whose outcome is unknown.
 *
 * The attempt's key is claimed with a `tender-discard` record (who approved it and why), in
 * the same `(organization, device, key)` slot the tender itself binds. An attempt still in
 * flight therefore either commits first, and is returned here as ACCEPTED so the counter
 * records it instead of forgetting it, or finds the discard record and is refused with
 * IDEMPOTENCY_CONFLICT. No money moves here, and a discarded attempt can never land later.
 */
export async function discardPharmacyTenderAttempt(
  db: ScopedDb,
  scope: LedgerScope,
  input: Omit<Parameters<typeof applyPharmacyTender>[2], 'adapter'>,
  record: PharmacyTenderDiscardRecord
): Promise<PharmacyTenderDiscard | null> {
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true },
  });
  if (!sale || sale.id !== input.saleId) return null;
  const payloadHash = hash(input);
  const evidence = {
    saleId: input.saleId,
    type: input.type,
    amountMinor: input.amountMinor,
    discardedByActorId: scope.actorId,
    approvedByUserId: record.approvedByUserId,
    approvalPolicy: record.approvalPolicy,
    selfApproved: record.selfApproved,
    reason: record.reason,
  };
  // Waits on the row lock of a tender holding this key, so its commit or rollback decides.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO pharmacy_money_idempotency_keys
      (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "resultPayload", "createdAt")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${input.deviceId}, ${input.idempotencyKey}, ${DISCARDED_TENDER_COMMAND}, ${payloadHash}, ${JSON.stringify(evidence)}::jsonb, now())
    ON CONFLICT ("organizationId", "deviceId", key) DO NOTHING`);
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: {
      organizationId_deviceId_key: {
        organizationId: scope.organizationId,
        deviceId: input.deviceId,
        key: input.idempotencyKey,
      },
    },
    select: { commandType: true, payloadHash: true },
  });
  if (!prior) throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  // A tender bound to this exact attempt committed: it is a payment, never discarded.
  if (prior.commandType === 'tender' && prior.payloadHash === payloadHash) {
    const outcome = await readPharmacyTenderOutcome(db, scope, input);
    if (outcome.status === 'ACCEPTED') return { status: 'ACCEPTED', result: outcome.result };
    throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  }
  // A discard record, or a key bound to another payload: this attempt can never be accepted.
  return { status: 'DISCARDED' };
}

async function bindIdempotency(
  db: ScopedDb,
  organizationId: string,
  deviceId: string,
  key: string,
  commandType: string,
  payloadHash: string
) {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO pharmacy_money_idempotency_keys
      (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "createdAt")
    VALUES (${randomUUID()}, ${organizationId}, ${deviceId}, ${key}, ${commandType}, ${payloadHash}, now())
    ON CONFLICT ("organizationId", "deviceId", key) DO NOTHING`);
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: { organizationId_deviceId_key: { organizationId, deviceId, key } },
  });
  // DEV-712: a supervisor discarded this attempt; it rolls back and is never recorded.
  if (prior?.commandType === DISCARDED_TENDER_COMMAND)
    throw new PharmacySettlementError('TENDER_ATTEMPT_DISCARDED');
  if (!prior || prior.commandType !== commandType || prior.payloadHash !== payloadHash)
    throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  return prior;
}

/** Shared transaction lock: closing cannot race a new tender or drawer write. */
export async function lockPharmacyDay(db: ScopedDb, scope: LedgerScope, date: Date) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope.organizationId}:${scope.branchId}:${date.toISOString().slice(0, 10)}`}))`
  );
}

/**
 * DEV-631: a day is closed for trading while its latest close stands. An owner's
 * reopen of that close opens the day again until the next close supersedes it.
 * Reads without the day lock: callers that write take it first.
 */
export async function pharmacyDayClosedForTrading(db: ScopedDb, scope: LedgerScope, date: Date) {
  const close = await db.pharmacyDailyClose.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, businessDate: date },
    orderBy: { sequence: 'desc' },
    select: { id: true, reopen: { select: { id: true } } },
  });
  return Boolean(close && !close.reopen);
}

export async function requirePharmacyDayOpen(db: ScopedDb, scope: LedgerScope, date: Date) {
  await lockPharmacyDay(db, scope, date);
  if (await pharmacyDayClosedForTrading(db, scope, date))
    throw new PharmacySettlementError('DAY_CLOSED');
}

/**
 * DEV-631: a counter bill is not opened, and no line reserves stock, while today's
 * business day (in the workspace zone) is closed for trading. Hold the same day
 * lock as close/reopen and money writes through the caller's transaction so a
 * close cannot race bill creation or stock reservation.
 */
export async function requirePharmacyTodayOpenForTrading(
  db: ScopedDb,
  scope: LedgerScope,
  now: Date = new Date()
) {
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const today = new Date(`${workspaceToday(organization?.timezone, now)}T00:00:00.000Z`);
  await requirePharmacyDayOpen(db, scope, today);
}

/**
 * DEV-630: an online money write (drawer open, tender, refund) books on the branch's
 * current business day: today in the workspace zone, the day the counter stamps and the
 * close opens on. A client-sent future or earlier date is refused, so cash cannot be
 * moved out of the day being counted. Offline replay keeps its audited original date
 * and does not call this.
 */
export async function requireCurrentPharmacyBusinessDate(
  db: ScopedDb,
  scope: { organizationId: string },
  date: Date,
  now: Date = new Date()
) {
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  if (date.toISOString().slice(0, 10) !== workspaceToday(organization?.timezone, now))
    throw new PharmacySettlementError('BUSINESS_DATE_NOT_CURRENT');
}

/**
 * DEV-821: who is putting cash into, or taking it out of, a drawer. A counter user
 * may use only a drawer they run; a manager or owner may use any open drawer of the
 * branch. An enrolled offline counter replays under its own authenticated device.
 */
export type PharmacyDrawerOperator =
  { kind: 'COUNTER'; actorIsManager: boolean } | { kind: 'REGISTERED_DEVICE_REPLAY' };

/** Options for an online counter call; replay and delivery paths omit them. */
export type PharmacySettlementOptions = {
  requireCurrentBusinessDate?: boolean;
  /** Omitted: the caller is treated as a counter user who is not a manager. */
  drawerOperator?: PharmacyDrawerOperator;
  /**
   * DEV-863: the customer's own prepaid spend PIN. One-time evidence: never part of the
   * idempotent payload. A prepaid WALLET payment without the right PIN is refused.
   */
  prepaidPin?: string;
  /**
   * DEV-863: the bill's prepaid tier prices were frozen earlier (a COD rider's first
   * collection), so this payment must settle that same total and never reprice it.
   */
  prepaidPricingFrozen?: boolean;
};

/** The cashier who runs a drawer. Drawers opened before DEV-821 are run by their opener. */
export function drawerOperatingCashierId(drawer: {
  operatingCashierId?: string | null;
  openedByActorId: string;
}) {
  return drawer.operatingCashierId ?? drawer.openedByActorId;
}

/**
 * DEV-821: refuses cash into or out of a drawer the actor does not run. Fails closed:
 * without an operator, only the drawer's own cashier passes.
 */
export function assertDrawerOperator(
  drawer: { operatingCashierId?: string | null; openedByActorId: string },
  scope: { actorId: string },
  operator?: PharmacyDrawerOperator
) {
  if (operator?.kind === 'REGISTERED_DEVICE_REPLAY') return;
  if (operator?.kind === 'COUNTER' && operator.actorIsManager) return;
  if (drawerOperatingCashierId(drawer) !== scope.actorId)
    throw new PharmacySettlementError('DRAWER_NOT_YOURS');
}

/**
 * DEV-821: the one server-side drawer resolver for cash. The client-sent device id
 * reaches only that device's OPEN drawer for the business date on the caller's own
 * branch, and only when the caller runs it or is a manager/owner.
 */
export async function resolveOperatingPharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { deviceId: string; businessDate: Date },
  operator?: PharmacyDrawerOperator
) {
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      businessDate: input.businessDate,
      status: 'OPEN',
    },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  assertDrawerOperator(drawer, scope, operator);
  return drawer;
}

async function lockDrawerDay(db: ScopedDb, scope: LedgerScope, drawerSessionId: string) {
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: { id: drawerSessionId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { businessDate: true },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  await requirePharmacyDayOpen(db, scope, drawer.businessDate);
}

export async function applyPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId: string;
    deviceId: string;
    businessDate: Date;
    type: PharmacyTenderType;
    amountMinor: number;
    cashReceivedMinor?: number;
    providerRef?: string;
    payerName?: string;
    referenceSkipped?: boolean;
    /** Manual card: the approval code on the standalone terminal slip. */
    approvalCode?: string;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
    leasedReceipt?: PharmacyLeasedReceipt;
  },
  authentication?: PharmacyCommandAuthentication,
  options: PharmacySettlementOptions = {}
) {
  assertPositiveMinor(input.amountMinor);
  if (input.leasedReceipt) {
    await authenticatePharmacyCommand(
      db,
      scope,
      input.deviceId,
      input.leasedReceipt,
      authentication
    );
    validateLeasedReceiptReplay(scope, input.deviceId, input.leasedReceipt);
  }
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'tender',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };
  // Every settlement path (counter, Khata, offline replay, delivery, sandbox) shares this gate.
  await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
    name: 'pharmacy.sale.tender',
  });
  // After the replay above, so a recorded attempt retried past midnight still answers.
  if (options.requireCurrentBusinessDate)
    await requireCurrentPharmacyBusinessDate(db, scope, input.businessDate);
  await requirePharmacyDayOpen(db, scope, input.businessDate);

  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id = ${input.saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
  let sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: completionSaleInclude,
  });
  if (!sale || sale.status !== 'OPEN') throw new PharmacySettlementError('SALE_NOT_OPEN');
  // DEV-86: a regulated line added inside pharmacist-presence hours cannot be paid for,
  // and the sale completed, after those hours close.
  if (
    sale.lines.some(({ medicine }) => medicine?.rx || medicine?.restricted || medicine?.controlled)
  )
    await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
      name: 'pharmacy.sale.tender_regulated',
      requiresQualifiedPerson: true,
      requiresPharmacistPresence: true,
    });
  // #518: a line added earlier cannot be paid for by someone who may not sell it.
  await assertRxSaleAllowed(
    db,
    scope,
    sale.lines.map((line) => line.medicine)
  );
  // DEV-629: an Rx/restricted line is never paid for without a pharmacist-attached prescription
  // and a pharmacist's signed review of that line.
  await assertRxLinesPrescribed(db, sale.lines, scope);
  // #659: before any lease, provider charge, tender or posting. A batch recalled,
  // quarantined or expired since add-to-cart refuses the payment.
  await assertSaleBatchesSellable(db, scope, sale.id);
  if (!options.prepaidPricingFrozen) sale = await pricePrepaidSale(db, sale, true);
  const totalMinor = saleTotalMinor(sale.lines);
  const tenderedMinor = sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (input.amountMinor > totalMinor - tenderedMinor)
    throw new PharmacySettlementError('OVER_TENDER');

  const settled = tenderedMinor + input.amountMinor === totalMinor;
  if (input.leasedReceipt && !settled)
    throw new PharmacySettlementError('LEASE_REQUIRES_SETTLEMENT');

  // Same owning transaction as the sale/tender/event. UPDATE locks and rechecks
  // the cursor, so a second command cannot consume the same number. Reserved
  // numbers never return to the online sequence, including on rejection.
  let receiptNumber: number | null = null;
  if (input.leasedReceipt) {
    const { leaseId, receiptNumber: leasedNumber } = input.leasedReceipt;
    const consumed = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      UPDATE pharmacy_receipt_number_leases AS lease
      SET "nextNumber" = ${leasedNumber} + 1
      WHERE lease.id = ${leaseId}
        AND lease."organizationId" = ${scope.organizationId}
        AND lease."branchId" = ${scope.branchId}
        AND lease."deviceId" = ${input.deviceId}
        AND lease."nextNumber" = ${leasedNumber}
        AND ${leasedNumber} BETWEEN lease."blockStart" AND lease."blockEnd"
        AND lease."issuedAt" <= ${new Date(input.leasedReceipt.originalSaleAt)}
        AND EXISTS (
          SELECT 1 FROM pharmacy_registered_devices AS device
          WHERE device.id = lease."deviceId"
            AND device."organizationId" = lease."organizationId"
            AND device."branchId" = lease."branchId"
            AND device.status = 'ACTIVE' AND device."revokedAt" IS NULL
        )
      RETURNING lease."nextNumber" - 1 AS receipt_number`);
    if (!consumed[0]) throw new PharmacySettlementError('INVALID_RECEIPT_LEASE');
    receiptNumber = consumed[0].receipt_number;
  }

  let drawerSessionId: string | undefined;
  let cashReceivedMinor: number | undefined;
  let changeGivenMinor: number | undefined;
  let provider: string | undefined;
  let providerRef: string | undefined;
  let providerPostingAt: Date | undefined;
  let payerName: string | undefined;
  let referenceSkipped: boolean | undefined;
  let approvalCode: string | undefined;
  let confirmedById: string | undefined;
  // DEV-713: a card taken on a standalone terminal is the default card path.
  // The integrated provider path runs only when a provider adapter is supplied.
  const manualCard = input.type === 'CARD' && !input.adapter;
  const bankTransfer = input.type === 'BANK_TRANSFER';
  if (manualCard || bankTransfer) {
    if (input.payerName !== undefined || input.referenceSkipped !== undefined ||
        input.cashReceivedMinor !== undefined)
      throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
  }
  if (!manualCard && input.approvalCode !== undefined) {
    throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
  }
  if (!isManualTender(input.type) && !manualCard && !bankTransfer &&
      (input.providerRef !== undefined || input.payerName !== undefined || input.referenceSkipped !== undefined))
    throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
  if (input.type === 'CASH') {
    cashReceivedMinor = input.cashReceivedMinor ?? input.amountMinor;
    if (!Number.isSafeInteger(cashReceivedMinor) || cashReceivedMinor < input.amountMinor)
      throw new PharmacySettlementError('INVALID_AMOUNT');
    changeGivenMinor = cashReceivedMinor - input.amountMinor;
    const drawer = await resolveOperatingPharmacyDrawer(
      db,
      scope,
      input,
      options.drawerOperator
    );
    drawerSessionId = drawer.id;
  } else if (isManualTender(input.type)) {
    if (input.cashReceivedMinor !== undefined) throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
    // Policy and capture are checked in the money transaction. Saving policy
    // takes UPDATE on the same branch row, so a concurrent skip-policy change
    // cannot slip between this read and the committed tender.
    await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_branches
      WHERE id=${scope.branchId} AND "organizationId"=${scope.organizationId} FOR SHARE`);
    const branch = await readManualPaymentSettings(db, scope);
    try {
      const capture = validateManualTender(branch.settings, {
        type: input.type, providerRef: input.providerRef,
        payerName: input.payerName, referenceSkipped: input.referenceSkipped,
      });
      provider = 'MANUAL_MERCHANT';
      providerRef = capture.providerRef;
      payerName = capture.payerName;
      referenceSkipped = capture.referenceSkipped;
      // The signed-in cashier attests the money reached the merchant account.
      confirmedById = scope.actorId;
    } catch { throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE'); }
  } else if (manualCard) {
    const capture = manualCardCaptureSchema.safeParse({
      providerRef: input.providerRef, approvalCode: input.approvalCode,
    });
    if (!capture.success) throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
    provider = MANUAL_CARD_PROVIDER;
    providerRef = capture.data.providerRef;
    approvalCode = capture.data.approvalCode;
    // The signed-in cashier attests the terminal slip shows an approval.
    confirmedById = scope.actorId;
  } else if (input.type === 'WALLET' && !input.adapter) {
    // DEV-863: an adapter-less wallet tender spends the linked customer's prepaid balance,
    // and only with that customer's own spend PIN.
    if (!sale.customerId) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    await assertPrepaidPin(db, scope.organizationId, sale.customerId, options.prepaidPin);
    provider = PREPAID_PROVIDER;
  } else if (bankTransfer) {
    const capture = bankTransferCaptureSchema.safeParse({ providerRef: input.providerRef });
    if (!capture.success) throw new PharmacySettlementError('INVALID_MANUAL_CAPTURE');
    providerRef = capture.data.providerRef;
    // The signed-in cashier confirms the transfer reached the bank account.
    confirmedById = scope.actorId;
  } else if (input.type === 'CARD' || input.type === 'WALLET') {
    if (!input.adapter) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    // Refuse before a provider can move money outside the database transaction.
    // Use the same instant for the persisted posting, including across midnight.
    providerPostingAt = new Date();
    await assertPostingPeriodsOpen(db, scope.organizationId, providerPostingAt, scope.branchId);
    const result = await adapter.execute({
      capability: 'SALE',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    provider = adapter.name;
    providerRef = result.providerRef;
  }

  const tender = await db.pharmacyTender.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      type: input.type,
      amountMinor: input.amountMinor,
      cashReceivedMinor,
      changeGivenMinor,
      drawerSessionId,
      provider,
      providerRef,
      payerName,
      referenceSkipped,
      approvalCode,
      confirmedById,
      createdAt: providerPostingAt,
      businessDate: input.businessDate,
      actorId: scope.actorId,
      deviceId: input.deviceId,
    },
  });
  if (provider === PREPAID_PROVIDER)
    await movePrepaid(db, scope, {
      customerId: sale.customerId!,
      kind: 'SPEND',
      amountMinor: input.amountMinor,
      tenderId: tender.id,
      idempotencyKey: `prepaid:spend:${tender.id}`,
    });
  await postTenderEntry(db, scope, { tenderId: tender.id, at: tender.createdAt });
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_SALE',
        amountMinor: input.amountMinor,
        actorId: scope.actorId,
      },
    });

  if (settled) {
    // F2: a leased offline receipt number was consumed above in this transaction; online
    // sales (receiptNumber still null) draw the next number from the device sequence.
    receiptNumber = await completePaidPharmacySale(
      db,
      scope,
      sale,
      input,
      receiptNumber,
      providerPostingAt
    );
    if (sale.customerId) await accrueSalePoints(db, scope, sale.id);
  }
  await requestCounterEvidence(db, scope, { kind: 'TENDER', subjectId: tender.id });
  const result = {
    tenderId: tender.id,
    settled,
    receiptNumber,
    remainingMinor: totalMinor - tenderedMinor - input.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export function assertRefundWithinTender(
  tenderedMinor: number,
  refundedMinor: number,
  requestedMinor: number
) {
  assertPositiveMinor(requestedMinor);
  if (refundedMinor + requestedMinor > tenderedMinor)
    throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
}

export async function refundPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    originalTenderId: string;
    deviceId: string;
    businessDate: Date;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
    manualCashFallback?: boolean;
    /** Settled sales are always capped; true also caps refunds on a sale that is not settled. */
    requireReturnedValue?: boolean;
  },
  options: PharmacySettlementOptions = {}
) {
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'refund',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };
  if (options.requireCurrentBusinessDate)
    await requireCurrentPharmacyBusinessDate(db, scope, input.businessDate);
  await requirePharmacyDayOpen(db, scope, input.businessDate);
  // Same sale-before-customer protocol as redemption; serialize refunds across tenders.
  await db.$queryRaw(Prisma.sql`SELECT s.id FROM pharmacy_sales s
    JOIN pharmacy_tenders t ON t."saleId"=s.id AND t."organizationId"=s."organizationId"
    WHERE t.id=${input.originalTenderId} AND s."organizationId"=${scope.organizationId}
      AND s."branchId"=${scope.branchId} FOR UPDATE OF s`);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_tenders WHERE id=${input.originalTenderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`
  );
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: input.originalTenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { refunds: true, sale: { select: { customerId: true, status: true } } },
  });
  if (!tender) throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  // DEV-764: voiding a sale releases its points tenders in full (points back, settlement
  // reversed). Nothing is left on a released tender to refund.
  if (tender.type === 'LOYALTY' && tender.sale.status === 'VOID')
    throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  assertRefundWithinTender(
    tender.amountMinor,
    tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0),
    input.amountMinor
  );
  // Returned-value cap (F13 c62a34f3 + bbb71a5d, reconciled with the tip's failed-delivery flow):
  // serialize refunds across all tenders of this sale, then cap every refund on a settled
  // (COMPLETED) sale at the value of goods actually returned, including unidentified return holds,
  // whatever the caller sends. A refund on a sale that is not settled (the tip cancels an OPEN
  // failed-delivery sale and returns its cash) has no returned goods to value; it stays limited by
  // the tender alone unless the caller explicitly asks for the cap with requireReturnedValue.
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${tender.saleId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: tender.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'COMPLETED',
    },
    include: {
      lines: { include: { returnLines: true, unidentifiedReturnHolds: true } },
      refunds: true,
    },
  });
  const unsettledExempt =
    !sale &&
    !input.requireReturnedValue &&
    (await db.pharmacySale.count({
      where: {
        id: tender.saleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: { not: 'COMPLETED' },
      },
    })) > 0;
  if (!unsettledExempt) {
    const returnValue =
      sale?.lines.reduce(
        (sum, line) =>
          sum +
          returnedLineValue(
            line,
            line.returnLines.reduce((n, row) => n + row.canonicalUnits, 0) +
              line.unidentifiedReturnHolds.reduce((n, row) => n + row.canonicalUnits, 0)
          ),
        0
      ) ?? 0;
    if (
      !sale ||
      sale.refunds.reduce((sum, row) => sum + row.amountMinor, 0) + input.amountMinor > returnValue
    )
      throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  }
  // DEV-863: a prepaid tender is always restored to the customer's prepaid balance. Cash is
  // never paid out for it, so a manual cash fallback is refused rather than ignored.
  if (tender.provider === PREPAID_PROVIDER && input.manualCashFallback === true)
    throw new PharmacySettlementError('PREPAID_REFUND_RESTORES_BALANCE');
  const manualReversalRequired =
    tender.provider !== PREPAID_PROVIDER &&
    (tender.type === 'CARD' || tender.type === 'WALLET') &&
    !input.adapter &&
    input.manualCashFallback === true;
  const refundReason = manualReversalRequired
    ? `[CASH; MANUAL REVERSAL REQUIRED] ${input.reason.trim()}`
    : input.reason.trim();
  let providerRef: string | undefined;
  let providerPostingAt: Date | undefined;
  let drawerSessionId: string | undefined;
  if (tender.provider === PREPAID_PROVIDER) {
    if (!tender.sale.customerId) throw new PharmacySettlementError('INVALID_AMOUNT');
  } else if ((tender.type === 'CARD' || tender.type === 'WALLET') && !manualReversalRequired) {
    if (!input.adapter || !tender.providerRef)
      throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    // Refuse before a provider can move money outside the database transaction.
    // Use the same instant for the persisted posting, including across midnight.
    providerPostingAt = new Date();
    await assertPostingPeriodsOpen(db, scope.organizationId, providerPostingAt, scope.branchId);
    const result = await adapter.execute({
      capability: 'REFUND',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
      priorRef: tender.providerRef,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    providerRef = result.providerRef;
  } else if (tender.type === 'CASH' || manualReversalRequired) {
    const drawer = await resolveOperatingPharmacyDrawer(
      db,
      scope,
      input,
      options.drawerOperator
    );
    drawerSessionId = drawer.id;
  }
  const refund = await db.pharmacyRefund.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: tender.saleId,
      originalTenderId: tender.id,
      createdAt: providerPostingAt,
      amountMinor: input.amountMinor,
      providerRef,
      drawerSessionId,
      businessDate: input.businessDate,
      reason: refundReason,
      actorId: scope.actorId,
    },
  });
  if (tender.provider === PREPAID_PROVIDER)
    await movePrepaid(db, scope, {
      customerId: tender.sale.customerId!,
      kind: 'RESTORE',
      amountMinor: input.amountMinor,
      tenderId: tender.id,
      refundId: refund.id,
      idempotencyKey: `prepaid:restore:${refund.id}`,
    });
  await postTenderRefundEntry(db, scope, { refundId: refund.id, at: refund.createdAt });
  if (tender.type === 'LOYALTY' && tender.sale.customerId) {
    await restoreRefundedLoyaltyPoints(db, scope, {
      refundId: refund.id,
      tenderId: tender.id,
      saleId: tender.saleId,
      customerId: tender.sale.customerId,
    });
  }
  if (tender.type !== 'LOYALTY' && tender.sale.customerId)
    await reverseRefundedEarnedPoints(db, scope, refund.id);
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_REFUND',
        amountMinor: input.amountMinor,
        reason: refundReason,
        actorId: scope.actorId,
      },
    });
  await requestCounterEvidence(db, scope, { kind: 'REFUND', subjectId: refund.id });
  const result = {
    refundId: refund.id,
    manualReversalRequired,
    originalTenderId: tender.id,
    amountMinor: refund.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export type CloseSource = {
  sales: readonly { id: string; totalMinor: number }[];
  refunds: readonly { id: string; amountMinor: number }[];
  drawers: readonly { id: string; expectedMinor: number; countedMinor: number }[];
  tenders?: readonly { id: string; type: string; amountMinor: number }[];
};

export function computePharmacyClose(source: CloseSource) {
  const ordered = {
    sales: [...source.sales].sort((a, b) => a.id.localeCompare(b.id)),
    refunds: [...source.refunds].sort((a, b) => a.id.localeCompare(b.id)),
    drawers: [...source.drawers].sort((a, b) => a.id.localeCompare(b.id)),
    ...(source.tenders ? { tenders: [...source.tenders].sort((a, b) => a.id.localeCompare(b.id)) } : {}),
  };
  const grossSalesMinor = ordered.sales.reduce((sum, row) => sum + row.totalMinor, 0);
  const refundTotalMinor = ordered.refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  const cashExpectedMinor = ordered.drawers.reduce((sum, row) => sum + row.expectedMinor, 0);
  const cashCountedMinor = ordered.drawers.reduce((sum, row) => sum + row.countedMinor, 0);
  return {
    grossSalesMinor,
    refundTotalMinor,
    netSalesMinor: grossSalesMinor - refundTotalMinor,
    cashExpectedMinor,
    cashCountedMinor,
    cashVarianceMinor: cashCountedMinor - cashExpectedMinor,
    sourceHash: hash(ordered),
  };
}

export type DrawerMovement = {
  kind: 'OPENING_FLOAT' | 'CASH_SALE' | 'CASH_REFUND' | 'PAID_IN' | 'PAID_OUT';
  amountMinor: number;
};

export function foldExpectedCash(movements: readonly DrawerMovement[]) {
  return movements.reduce((total, movement) => {
    assertPositiveMinor(movement.amountMinor);
    return movement.kind === 'CASH_REFUND' || movement.kind === 'PAID_OUT'
      ? total - movement.amountMinor
      : total + movement.amountMinor;
  }, 0);
}

/**
 * DEV-821: a drawer's operating cashier must pass the counter's own operator gate:
 * the `pharmacy:counter` grant, an active membership of this organization with a
 * deny-wins counter ALLOW, and an active assignment to the drawer's branch. The
 * caller decides who may name someone other than themselves (a manager or owner).
 */
async function assertBranchCashier(db: ScopedDb, scope: LedgerScope, cashierId: string) {
  const cashier = await db.user.findFirst({
    where: { id: cashierId, organizationId: scope.organizationId },
    select: { id: true, role: true, department: true, status: true },
  });
  if (
    !cashier ||
    (await counterOperatorDenial(db, cashier, scope.organizationId, scope.branchId, {
      source: 'TRPC',
    }))
  )
    throw new PharmacySettlementError('CASHIER_NOT_ASSIGNED');
}

export async function openPharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    deviceId: string;
    businessDate: Date;
    openingFloatMinor: number;
    /** DEV-821: who runs the till; defaults to the opener. Naming another is a manager's. */
    operatingCashierId?: string;
  },
  options: PharmacySettlementOptions = {}
) {
  if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  if (options.requireCurrentBusinessDate)
    await requireCurrentPharmacyBusinessDate(db, scope, input.businessDate);
  await requirePharmacyDayOpen(db, scope, input.businessDate);
  const operatingCashierId = input.operatingCashierId ?? scope.actorId;
  if (operatingCashierId !== scope.actorId) await assertBranchCashier(db, scope, operatingCashierId);
  // One OPEN drawer per counter device (the partial unique index
  // `pharmacy_one_open_drawer_per_device`). The pre-check answers the ordinary
  // second click with the typed reason; the P2002 translation below is the
  // backstop for two opens racing past it, so neither surfaces as a 500.
  const alreadyOpen = await db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      status: 'OPEN',
    },
    select: { id: true },
  });
  if (alreadyOpen) throw new PharmacySettlementError('OPEN_DRAWER');
  let drawer;
  try {
    drawer = await db.pharmacyDrawerSession.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        openingFloatMinor: input.openingFloatMinor,
        openedByActorId: scope.actorId,
        operatingCashierId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new PharmacySettlementError('OPEN_DRAWER');
    throw error;
  }
  if (input.openingFloatMinor > 0)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId: drawer.id,
        kind: 'OPENING_FLOAT',
        amountMinor: input.openingFloatMinor,
        actorId: scope.actorId,
      },
    });
  return drawer;
}

/** The OPEN drawer for a counter device, if any: what the counter offers instead of "Open drawer". */
export async function readOpenPharmacyDrawer(db: ScopedDb, scope: LedgerScope, deviceId: string) {
  return db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId,
      status: 'OPEN',
    },
    select: {
      id: true,
      businessDate: true,
      openedAt: true,
      openingFloatMinor: true,
      openedByActorId: true,
      operatingCashierId: true,
    },
    orderBy: { openedAt: 'desc' },
  });
}

/**
 * DEV-725: this device's OPEN drawer, re-checked under its business-day lock (the
 * lock drawer and day close take), so a close cannot commit between this check and
 * the caller's write in the same transaction.
 */
export async function lockOpenPharmacyDrawer(db: ScopedDb, scope: LedgerScope, deviceId: string) {
  const drawer = await readOpenPharmacyDrawer(db, scope, deviceId);
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  await lockPharmacyDay(db, scope, drawer.businessDate);
  const stillOpen = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: drawer.id,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    select: { id: true },
  });
  if (!stillOpen) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  return drawer;
}

export async function recordPharmacyCashMovement(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    drawerSessionId: string;
    kind: 'PAID_IN' | 'PAID_OUT';
    amountMinor: number;
    reason: string;
  },
  /** DEV-821: omitted, only the drawer's own cashier may move its cash. */
  operator?: PharmacyDrawerOperator
) {
  assertPositiveMinor(input.amountMinor);
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  await lockDrawerDay(db, scope, input.drawerSessionId);
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  assertDrawerOperator(drawer, scope, operator);
  return db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: input.kind,
      amountMinor: input.amountMinor,
      reason: input.reason.trim(),
      actorId: scope.actorId,
    },
  });
}

/**
 * DEV-821: a manager or owner hands an open till to another cashier of the branch.
 * The handover is recorded append-only, with who did it and why, under the same
 * day lock a close takes.
 */
export async function handoverPharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { drawerSessionId: string; toCashierId: string; reason: string }
) {
  const reason = input.reason.trim();
  if (!reason) throw new PharmacySettlementError('INVALID_AMOUNT');
  await lockDrawerDay(db, scope, input.drawerSessionId);
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  const fromCashierId = drawerOperatingCashierId(drawer);
  if (fromCashierId === input.toCashierId) return { drawer, handover: null };
  await assertBranchCashier(db, scope, input.toCashierId);
  const handover = await db.pharmacyDrawerHandover.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      fromCashierId,
      toCashierId: input.toCashierId,
      actorId: scope.actorId,
      reason,
    },
  });
  const updated = await db.pharmacyDrawerSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: drawer.id } },
    data: { operatingCashierId: input.toCashierId },
  });
  return { drawer: updated, handover };
}

export type DrawerOperatorMovement = {
  id: string;
  kind: string;
  amountMinor: number;
  actorId: string;
  createdAt: Date;
};

/**
 * DEV-821: cash movements made by someone other than the cashier running the till
 * at that moment, for the drawer-close and day-close reports. The handovers give
 * the run of cashiers: before the first handover the till was its first cashier's.
 * The opening float and the closing count are the open and the close themselves,
 * made by whoever opened or closed the till, so they are left out.
 */
export function movementsByOtherThanOperator(
  drawer: { operatingCashierId?: string | null; openedByActorId: string },
  movements: readonly DrawerOperatorMovement[],
  handovers: readonly { fromCashierId: string; toCashierId: string; createdAt: Date }[]
): DrawerOperatorMovement[] {
  const shifts = [...handovers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const firstCashier = shifts[0]?.fromCashierId ?? drawerOperatingCashierId(drawer);
  const cashierAt = (at: Date) =>
    shifts.reduce(
      (cashier, handover) =>
        handover.createdAt.getTime() <= at.getTime() ? handover.toCashierId : cashier,
      firstCashier
    );
  return movements
    .filter((movement) => movement.kind !== 'OPENING_FLOAT' && movement.kind !== 'CLOSING_COUNT')
    .filter((movement) => movement.actorId !== cashierAt(movement.createdAt))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function closePharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { drawerSessionId: string; countedCashMinor: number; controlledCountHook?: unknown }
) {
  if (!Number.isSafeInteger(input.countedCashMinor) || input.countedCashMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  await lockDrawerDay(db, scope, input.drawerSessionId);
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    include: { movements: true, handovers: true },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  const expectedCashMinor = foldExpectedCash(drawer.movements as DrawerMovement[]);
  // DEV-821: the drawer-close report names cash moved by anyone but the till's cashier.
  const otherOperatorMovements = movementsByOtherThanOperator(
    drawer,
    drawer.movements,
    drawer.handovers ?? []
  );
  await db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: 'CLOSING_COUNT',
      amountMinor: input.countedCashMinor,
      actorId: scope.actorId,
    },
  });
  const closed = await db.pharmacyDrawerSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: drawer.id } },
    data: {
      status: 'CLOSED',
      countedCashMinor: input.countedCashMinor,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      closedByActorId: scope.actorId,
      closedAt: new Date(),
    },
  });
  return {
    drawer: closed,
    expectedCashMinor,
    varianceMinor: input.countedCashMinor - expectedCashMinor,
    otherOperatorMovements,
  };
}

export async function cutPharmacyDailyClose(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    businessDate: Date;
    reopenReason?: string;
    /** The operator's explanation of a counted variance; never stands in for a reopen reason. */
    varianceNote?: string;
    controlledCountHook?: unknown;
  }
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope.organizationId}:${scope.branchId}:${input.businessDate.toISOString().slice(0, 10)}`}))`
  );
  const openDrawers = await db.pharmacyDrawerSession.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      status: 'OPEN',
    },
  });
  if (openDrawers > 0) throw new PharmacySettlementError('OPEN_DRAWER');
  const prior = await db.pharmacyDailyClose.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
    },
    orderBy: { sequence: 'desc' },
    include: { reopen: { select: { id: true } } },
  });
  // DEV-631: closing a day the owner reopened for trading is a normal close; the
  // reopen already carries its reason. Re-cutting a standing close still needs one.
  if (prior && !prior.reopen && !input.reopenReason?.trim())
    throw new PharmacySettlementError('REOPEN_REASON_REQUIRED');
  const [sales, refunds, drawers, tenders] = await Promise.all([
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
        status: 'COMPLETED',
      },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
      include: { originalTender: { select: { type: true } } },
    }),
    db.pharmacyDrawerSession.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
      include: { movements: true },
    }),
    db.pharmacyTender.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
      select: { id: true, type: true, amountMinor: true, confirmedById: true },
    }),
  ]);
  const aggregate = computePharmacyClose({
    tenders,
    sales: sales.map((sale) => ({ id: sale.id, totalMinor: saleTotalMinor(sale.lines) })),
    refunds: refunds.map((refund) => ({ id: refund.id, amountMinor: refund.amountMinor })),
    drawers: drawers.map((drawer) => ({
      id: drawer.id,
      expectedMinor: foldExpectedCash(
        drawer.movements.filter((row) => row.kind !== 'CLOSING_COUNT') as DrawerMovement[]
      ),
      countedMinor: drawer.countedCashMinor ?? 0,
    })),
  });
  // MIG-05: a switching branch's first close is not final until the parallel run
  // reconciles. One helper, consulted here and nowhere else in the close.
  const isFinal = await firstCloseIsFinal(db, scope.organizationId, scope.branchId);

  const close = await db.pharmacyDailyClose.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      sequence: (prior?.sequence ?? 0) + 1,
      supersedesCloseId: prior?.id,
      // The row is append-only, so its one reason is written here: the reopen reason when given,
      // as before, otherwise the variance note.
      reason: input.reopenReason?.trim() ?? (input.varianceNote?.trim() || undefined),
      ...aggregate,
      tenderTotals: aggregateTenderTotals(
        tenders,
        refunds,
        await manualConfirmerNames(db, scope.organizationId, tenders)
      ),
      isFinal,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      actorId: scope.actorId,
    },
  });
  // The counted cash variance reaches the journal in the close's own transaction (CASH / CASH_OVER_SHORT).
  await postDailyCloseEntry(db, scope, { closeId: close.id, at: close.createdAt });
  await requestCounterEvidence(db, scope, { kind: 'DAILY_CLOSE', subjectId: close.id });
  return close;
}

/** Display names of the people who confirmed manual tenders, for reconciliation. */
export async function manualConfirmerNames(
  db: ScopedDb,
  organizationId: string,
  tenders: readonly { confirmedById?: string | null }[]
) {
  const ids = [...new Set(tenders.flatMap((t) => (t.confirmedById ? [t.confirmedById] : [])))];
  if (!ids.length) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.flatMap((user) => (user.name ? [[user.id, user.name] as const] : [])));
}
