/**
 * DEV-103: native non-stock supplier operating-expense (AP) invoices.
 *
 * Recording an invoice posts one canonical finance entry (Dr OPERATING_EXPENSE,
 * Cr ACCOUNTS_PAYABLE) and freezes the invoice. Its durable identity is the
 * normalized payee plus the supplier's own invoice reference.
 *
 * Paying an invoice goes through the existing canonical bookkeeping machinery:
 * one SUPPLIER_PAYMENT transaction (Dr ACCOUNTS_PAYABLE, Cr CASH/BANK) carrying
 * a reserved idempotency-key prefix, plus a native settlement row linking that
 * transaction to the invoice. Nothing is posted twice. Reversing a settlement
 * reverses that transaction through the same machinery; the generic bookkeeping
 * reverse refuses native AP payments (see `bookkeeping.ts`).
 *
 * Every command runs in the caller's transaction and takes the shared
 * org+branch ledger lock first, so commands serialize with each other and with
 * period close/reopen. Each command key replays only with the same payload.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError, postJournalEntry, reverseJournalEntry } from '@/lib/finance/journal';
import {
  assertPeriodOpen,
  lockPharmacyLedgerScope,
  NATIVE_AP_PAYMENT_KEY_PREFIX,
  PharmacyBookkeepingError,
  postBookkeepingTransaction,
  reverseBookkeepingTransaction,
} from '@/lib/pharmacy/bookkeeping';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AP_INVOICE_MAX_MINOR,
  AP_INVOICE_MAX_TERM_DAYS,
  type ListApInvoicesInput,
  type PayApInvoiceInput,
  type RecordApInvoiceInput,
  type ReverseApInvoiceInput,
  type ReverseApSettlementInput,
} from './ap-invoices-schema';
import { commandPayloadHash } from './general-journal';

export type ApInvoiceScope = { organizationId: string; branchId: string; actorId: string };

/**
 * DEV-103: reversing an invoice or a payment needs a manager or owner with their own fresh PIN
 * (checked in the router). The person who recorded it may approve its reversal only when nobody
 * else could (`otherApReversalApprovers`); `soleApprover` re-checks that inside the write.
 */
export const AP_REVERSAL_SEGREGATED_POLICY = 'PHARMACY_AP_REVERSAL_MANAGER_PIN';
export const AP_REVERSAL_SOLE_APPROVER_POLICY = 'PHARMACY_AP_REVERSAL_SOLE_APPROVER_PIN';
export type ApReversalOptions = { soleApprover: () => Promise<boolean>; now?: Date };

async function reversalPolicy(
  recordedById: string,
  scope: ApInvoiceScope,
  options: ApReversalOptions
) {
  if (recordedById !== scope.actorId) return AP_REVERSAL_SEGREGATED_POLICY;
  if (!(await options.soleApprover())) fail('SELF_APPROVAL');
  return AP_REVERSAL_SOLE_APPROVER_POLICY;
}

/**
 * A reversal dated by the client keeps that instant in its payload; one dated by the server
 * (the screen sends none) takes the server clock and leaves it out, so a double submit of the
 * same command key replays instead of conflicting.
 */
function reversalInstant(
  input: { at?: string },
  now: Date
): { at: Date; hashed: Record<string, string> } {
  if (!input.at) return { at: now, hashed: {} };
  const at = parseApInstant(input.at, now);
  return { at, hashed: { at: at.toISOString() } };
}

export type ApInvoiceErrorReason =
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'MISSING_REASON'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'ALREADY_REVERSED'
  | 'ACTIVE_SETTLEMENTS'
  | 'OVERPAYMENT'
  | 'PERIOD_CLOSED'
  | 'DUPLICATE_REFERENCE'
  | 'DUPLICATE_INVOICE'
  | 'IDEMPOTENCY_CONFLICT'
  // DEV-694: supplier credit-note set-off.
  | 'SET_OFF_EXCEEDS_CREDIT'
  | 'SET_OFF_EXCEEDS_BILL'
  | 'SUPPLIER_MISMATCH'
  | 'ALREADY_DECIDED'
  | 'SELF_APPROVAL';

export class PharmacyApInvoiceError extends Error {
  constructor(readonly reason: ApInvoiceErrorReason) {
    super(reason);
    this.name = 'PharmacyApInvoiceError';
  }
}

function fail(reason: ApInvoiceErrorReason): never {
  throw new PharmacyApInvoiceError(reason);
}

const DAY_MS = 86_400_000;
export const AP_INVOICE_EARLIEST = new Date('2000-01-01T00:00:00.000Z');
/** How far ahead of the server clock a business date or instant may run. */
export const AP_FUTURE_TOLERANCE_MS = DAY_MS;

/** Payee identity: Unicode-normalized, whitespace-collapsed, case-folded. */
export function normalizePayeeKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A strict YYYY-MM-DD calendar date as UTC midnight. With `now`, the date may
 * not run more than the tolerance ahead of the server clock.
 */
export function parseCalendarDate(value: string, now: Date | null): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_DATE');
  }
  if (parsed < AP_INVOICE_EARLIEST) fail('INVALID_DATE');
  if (now && parsed.getTime() > now.getTime() + AP_FUTURE_TOLERANCE_MS) fail('INVALID_DATE');
  return parsed;
}

export function parseApInstant(value: string | Date, now: Date): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) fail('INVALID_DATE');
  if (parsed < AP_INVOICE_EARLIEST) fail('INVALID_DATE');
  if (parsed.getTime() > now.getTime() + AP_FUTURE_TOLERANCE_MS) fail('INVALID_DATE');
  return parsed;
}

function positiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > AP_INVOICE_MAX_MINOR) {
    fail('INVALID_AMOUNT');
  }
}

function text(value: string | undefined | null) {
  return value?.trim() ? value.trim() : null;
}

/** The ledger idempotency keys are per document, never per command key. */
export const apInvoicePostingKey = (invoiceId: string) => `ap-invoice:${invoiceId}`;
export const apInvoiceReversalKey = (invoiceId: string) => `ap-invoice-reversal:${invoiceId}`;
export const apSettlementPaymentKey = (commandKey: string) =>
  `${NATIVE_AP_PAYMENT_KEY_PREFIX}${commandKey}`;
export const apSettlementReversalKey = (settlementId: string) =>
  `ap-settlement-reversal:${settlementId}`;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function assertOpenPeriod(db: ScopedDb, scope: ApInvoiceScope, at: Date) {
  try {
    await assertPeriodOpen(db, scope, at);
  } catch (error) {
    if (error instanceof PharmacyBookkeepingError && error.reason === 'PERIOD_CLOSED') {
      fail('PERIOD_CLOSED');
    }
    throw error;
  }
}

export async function lockInvoice(
  db: ScopedDb,
  scope: Pick<ApInvoiceScope, 'organizationId' | 'branchId'>,
  invoiceId: string
) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_ap_invoices
    WHERE id=${invoiceId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const invoice = await db.pharmacyApInvoice.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: invoiceId },
    // Every settlement, reversed ones included: the payment and reversal
    // checks validate the whole historical timeline, not only today's state.
    // DEV-694: approved credit-note set-offs reduce the payable like payments.
    include: {
      settlements: true,
      creditSetOffs: {
        where: { status: { in: ['APPROVED', 'REVERSED'] } },
        select: { amountMinor: true, decidedAt: true, status: true, reversedAt: true },
      },
    },
  });
  if (!invoice) fail('NOT_FOUND');
  return invoice;
}

type SetOffClock = {
  amountMinor: number;
  decidedAt: Date | null;
  status?: string;
  reversedAt?: Date | null;
};

/**
 * DEV-694: an invoice's settlement clocks — its payments plus every approved
 * credit-note set-off, which reduces the payable from its approval instant until
 * its reversal instant, exactly like a payment and its reversal.
 */
export function invoiceSettlementClocks(invoice: {
  settlements: readonly SettlementClock[];
  creditSetOffs?: readonly SetOffClock[];
}): SettlementClock[] {
  return [
    ...invoice.settlements,
    ...(invoice.creditSetOffs ?? []).map((setOff) => ({
      amountMinor: setOff.amountMinor,
      paidAt: setOff.decidedAt ?? new Date(0),
      status: setOff.status === 'REVERSED' ? 'REVERSED' : 'ACTIVE',
      reversedAt: setOff.status === 'REVERSED' ? (setOff.reversedAt ?? null) : null,
    })),
  ];
}

async function lockSettlement(db: ScopedDb, scope: ApInvoiceScope, settlementId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_ap_invoice_settlements
    WHERE id=${settlementId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const settlement = await db.pharmacyApInvoiceSettlement.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: settlementId },
  });
  if (!settlement) fail('NOT_FOUND');
  return settlement;
}

export type NormalizedApInvoice = {
  reference: string;
  payeeName: string;
  payeeKey: string;
  supplierInvoiceRef: string;
  invoiceDate: Date;
  dueDate: Date;
  amountMinor: number;
  currency: 'PKR' | 'USD';
  description: string;
  evidenceReference: string;
};

export function normalizeApInvoice(input: RecordApInvoiceInput, now: Date): NormalizedApInvoice {
  positiveMinor(input.amountMinor);
  const reference = input.reference.trim();
  const payeeName = input.payeeName.trim().replace(/\s+/g, ' ');
  const supplierInvoiceRef = input.supplierInvoiceRef.trim();
  const description = input.description.trim();
  const evidenceReference = input.evidenceReference.trim();
  if (!reference || !payeeName || !supplierInvoiceRef) fail('INVALID_STATE');
  if (!description || !evidenceReference) fail('MISSING_REASON');
  if (input.currency !== 'PKR' && input.currency !== 'USD') fail('INVALID_STATE');
  const invoiceDate = parseCalendarDate(input.invoiceDate, now);
  // The due date may lie in the future; only its distance from the invoice is bounded.
  const dueDate = parseCalendarDate(input.dueDate, null);
  if (dueDate < invoiceDate) fail('INVALID_DATE');
  if (dueDate.getTime() - invoiceDate.getTime() > AP_INVOICE_MAX_TERM_DAYS * DAY_MS) {
    fail('INVALID_DATE');
  }
  return {
    reference,
    payeeName,
    payeeKey: normalizePayeeKey(payeeName),
    supplierInvoiceRef,
    invoiceDate,
    dueDate,
    amountMinor: input.amountMinor,
    currency: input.currency,
    description,
    evidenceReference,
  };
}

function recordPayloadHash(branchId: string, invoice: NormalizedApInvoice) {
  return commandPayloadHash({
    branchId,
    reference: invoice.reference,
    payeeKey: invoice.payeeKey,
    supplierInvoiceRef: invoice.supplierInvoiceRef,
    invoiceDate: invoice.invoiceDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    description: invoice.description,
    evidenceReference: invoice.evidenceReference,
  });
}

export async function recordApInvoice(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: RecordApInvoiceInput,
  now: Date = new Date()
) {
  const invoice = normalizeApInvoice(input, now);
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = recordPayloadHash(scope.branchId, invoice);
  const replay = await db.pharmacyApInvoice.findFirst({
    where: { organizationId: scope.organizationId, createKey: input.createKey },
  });
  if (replay) {
    if (replay.branchId !== scope.branchId || replay.createPayloadHash !== payloadHash) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return { invoice: replay, replayed: true as const };
  }

  const [referenceClash, identityClash] = await Promise.all([
    db.pharmacyApInvoice.findFirst({
      where: { organizationId: scope.organizationId, reference: invoice.reference },
      select: { id: true },
    }),
    db.pharmacyApInvoice.findFirst({
      where: {
        organizationId: scope.organizationId,
        payeeKey: invoice.payeeKey,
        supplierInvoiceRef: invoice.supplierInvoiceRef,
        status: 'POSTED',
      },
      select: { id: true },
    }),
  ]);
  if (referenceClash) fail('DUPLICATE_REFERENCE');
  if (identityClash) fail('DUPLICATE_INVOICE');
  await assertOpenPeriod(db, scope, invoice.invoiceDate);

  const invoiceId = randomUUID();
  let entry;
  try {
    entry = await postJournalEntry(db, scope, {
      sourceKind: 'PHARMACY_AP_INVOICE',
      sourceId: invoiceId,
      description: `Supplier expense invoice ${invoice.reference}`,
      occurredAt: invoice.invoiceDate,
      idempotencyKey: apInvoicePostingKey(invoiceId),
      branchId: scope.branchId,
      currency: invoice.currency,
      lines: [
        {
          accountCode: 'OPERATING_EXPENSE',
          side: 'DEBIT',
          amountMinor: invoice.amountMinor,
          branchId: scope.branchId,
          memo: invoice.supplierInvoiceRef,
        },
        {
          accountCode: 'ACCOUNTS_PAYABLE',
          side: 'CREDIT',
          amountMinor: invoice.amountMinor,
          branchId: scope.branchId,
          memo: invoice.supplierInvoiceRef,
        },
      ],
    });
  } catch (error) {
    if (error instanceof FinancePostingError)
      fail(error.reason === 'PERIOD_CLOSED' ? 'PERIOD_CLOSED' : 'IDEMPOTENCY_CONFLICT');
    throw error;
  }
  if (
    entry.sourceKind !== 'PHARMACY_AP_INVOICE' ||
    entry.sourceId !== invoiceId ||
    entry.organizationId !== scope.organizationId ||
    entry.branchId !== scope.branchId ||
    entry.reversesEntryId !== null
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  try {
    const created = await db.pharmacyApInvoice.create({
      data: {
        id: invoiceId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        ...invoice,
        createKey: input.createKey,
        createPayloadHash: payloadHash,
        createdByUserId: scope.actorId,
        journalEntryId: entry.id,
      },
    });
    return { invoice: created, entry, replayed: false as const };
  } catch (error) {
    // The live-identity partial index also covers branches this caller's RLS
    // scope cannot read.
    if (isUniqueViolation(error)) fail('DUPLICATE_INVOICE');
    throw error;
  }
}

export function outstandingMinor(invoice: {
  amountMinor: number;
  settlements: readonly { amountMinor: number; status: string }[];
}) {
  return (
    invoice.amountMinor -
    invoice.settlements
      .filter((settlement) => settlement.status === 'ACTIVE')
      .reduce((sum, settlement) => sum + settlement.amountMinor, 0)
  );
}

type SettlementClock = {
  amountMinor: number;
  paidAt: Date;
  status: string;
  reversedAt: Date | null;
};

/** Settled amount in effect at instant `at` (payment and its reversal clocks). */
export function settledMinorAt(settlements: readonly SettlementClock[], at: Date) {
  return settlements
    .filter(
      (settlement) =>
        settlement.paidAt <= at &&
        !(
          settlement.status === 'REVERSED' &&
          settlement.reversedAt !== null &&
          settlement.reversedAt <= at
        )
    )
    .reduce((sum, settlement) => sum + settlement.amountMinor, 0);
}

/**
 * The most a payment dated `from` may settle without the invoice being
 * over-settled at any instant from then on. The settled amount only rises at
 * a payment instant, so checking `from`, every later payment instant and the
 * current state (all ACTIVE settlements) covers the whole timeline. A payment
 * backdated before an earlier payment's reversal therefore cannot reuse the
 * balance that reversal frees.
 */
export function payableMinorFrom(
  invoice: { amountMinor: number; settlements: readonly SettlementClock[] },
  from: Date
) {
  const instants = [from, ...invoice.settlements.map((s) => s.paidAt).filter((at) => at > from)];
  const currentlyActive = invoice.amountMinor - outstandingMinor(invoice);
  const peak = Math.max(
    currentlyActive,
    ...instants.map((at) => settledMinorAt(invoice.settlements, at))
  );
  return invoice.amountMinor - peak;
}

export async function payApInvoice(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: PayApInvoiceInput,
  now: Date = new Date()
) {
  positiveMinor(input.amountMinor);
  const paidAt = parseApInstant(input.paidAt, now);
  const reference = input.reference.trim();
  if (!reference) fail('INVALID_STATE');
  const bankReference = text(input.bankReference);
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    invoiceId: input.invoiceId,
    reference,
    amountMinor: input.amountMinor,
    paidAt: paidAt.toISOString(),
    fundingAccount: input.fundingAccount,
    bankReference: bankReference ?? '',
  });
  const replay = await db.pharmacyApInvoiceSettlement.findFirst({
    where: { organizationId: scope.organizationId, commandKey: input.commandKey },
  });
  if (replay) {
    if (replay.branchId !== scope.branchId || replay.payloadHash !== payloadHash) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return { settlement: replay, replayed: true as const };
  }

  const invoice = await lockInvoice(db, scope, input.invoiceId);
  if (invoice.status !== 'POSTED') fail('INVALID_STATE');
  if (paidAt < invoice.invoiceDate) fail('INVALID_DATE');
  const clocks = {
    amountMinor: invoice.amountMinor,
    settlements: invoiceSettlementClocks(invoice),
  };
  if (input.amountMinor > payableMinorFrom(clocks, paidAt)) fail('OVERPAYMENT');

  let transaction;
  try {
    transaction = await postBookkeepingTransaction(
      db,
      scope,
      {
        reference,
        kind: 'SUPPLIER_PAYMENT',
        amountMinor: input.amountMinor,
        occurredAt: paidAt,
        idempotencyKey: apSettlementPaymentKey(input.commandKey),
        currency: invoice.currency,
        counterpartyName: invoice.payeeName,
        memo: `AP invoice ${invoice.reference} (${invoice.supplierInvoiceRef})`,
        bankReference,
        fundingAccount: input.fundingAccount,
        allocations: [
          {
            sourceKind: 'EXPENSE',
            sourceId: invoice.id,
            sourceReference: invoice.reference,
            amountMinor: input.amountMinor,
          },
        ],
      },
      { nativeApSettlement: true }
    );
  } catch (error) {
    if (error instanceof PharmacyBookkeepingError) {
      fail(error.reason === 'PERIOD_CLOSED' ? 'PERIOD_CLOSED' : 'INVALID_STATE');
    }
    if (isUniqueViolation(error)) fail('DUPLICATE_REFERENCE');
    throw error;
  }
  const allocation = transaction.allocations[0];
  if (
    transaction.status !== 'POSTED' ||
    transaction.kind !== 'SUPPLIER_PAYMENT' ||
    transaction.branchId !== scope.branchId ||
    transaction.amountMinor !== input.amountMinor ||
    transaction.allocations.length !== 1 ||
    allocation?.sourceId !== invoice.id ||
    allocation.amountMinor !== input.amountMinor
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  const settlement = await db.pharmacyApInvoiceSettlement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      invoiceId: invoice.id,
      transactionId: transaction.id,
      amountMinor: input.amountMinor,
      paidAt,
      fundingAccount: input.fundingAccount,
      commandKey: input.commandKey,
      payloadHash,
      createdByUserId: scope.actorId,
    },
  });
  return { settlement, transaction, replayed: false as const };
}

export async function reverseApSettlement(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: Omit<ReverseApSettlementInput, 'pin'>,
  options: ApReversalOptions
) {
  const now = options.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) fail('MISSING_REASON');
  const { at, hashed } = reversalInstant(input, now);
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    settlementId: input.settlementId,
    reason,
    ...hashed,
  });
  const replay = await db.pharmacyApInvoiceSettlement.findFirst({
    where: { organizationId: scope.organizationId, reverseCommandKey: input.commandKey },
  });
  if (replay) {
    if (
      replay.branchId !== scope.branchId ||
      replay.id !== input.settlementId ||
      replay.reversePayloadHash !== payloadHash
    ) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return { settlement: replay, replayed: true as const };
  }

  const settlement = await lockSettlement(db, scope, input.settlementId);
  if (settlement.status === 'REVERSED') fail('ALREADY_REVERSED');
  if (at < settlement.paidAt) fail('INVALID_DATE');
  const policy = await reversalPolicy(settlement.createdByUserId, scope, options);

  let transaction;
  try {
    transaction = await reverseBookkeepingTransaction(
      db,
      scope,
      {
        transactionId: settlement.transactionId,
        at,
        reason,
        idempotencyKey: apSettlementReversalKey(settlement.id),
      },
      { nativeApSettlement: true }
    );
  } catch (error) {
    if (error instanceof PharmacyBookkeepingError) {
      fail(error.reason === 'PERIOD_CLOSED' ? 'PERIOD_CLOSED' : 'INVALID_STATE');
    }
    throw error;
  }
  if (
    transaction.id !== settlement.transactionId ||
    transaction.status !== 'REVERSED' ||
    !transaction.reversalEntryId
  ) {
    fail('INVALID_STATE');
  }

  const reversed = await db.pharmacyApInvoiceSettlement.update({
    where: { id: settlement.id },
    data: {
      status: 'REVERSED',
      reversedAt: at,
      reversedByUserId: scope.actorId,
      reversalReason: reason,
      reverseCommandKey: input.commandKey,
      reversePayloadHash: payloadHash,
    },
  });
  return { settlement: reversed, transaction, policy, replayed: false as const };
}

export async function reverseApInvoice(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: Omit<ReverseApInvoiceInput, 'pin'>,
  options: ApReversalOptions
) {
  const now = options.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) fail('MISSING_REASON');
  const { at, hashed } = reversalInstant(input, now);
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    invoiceId: input.invoiceId,
    reason,
    ...hashed,
  });
  const replay = await db.pharmacyApInvoice.findFirst({
    where: { organizationId: scope.organizationId, reverseCommandKey: input.commandKey },
  });
  if (replay) {
    if (
      replay.branchId !== scope.branchId ||
      replay.id !== input.invoiceId ||
      replay.reversePayloadHash !== payloadHash
    ) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return { invoice: replay, replayed: true as const };
  }

  const invoice = await lockInvoice(db, scope, input.invoiceId);
  if (invoice.status === 'REVERSED') fail('ALREADY_REVERSED');
  const clocks = invoiceSettlementClocks(invoice);
  // DEV-694: an approved set-off still in force blocks the reversal like a payment.
  if (clocks.some((settlement) => settlement.status === 'ACTIVE')) {
    fail('ACTIVE_SETTLEMENTS');
  }
  if (at < invoice.invoiceDate) fail('INVALID_DATE');
  // The invoice clock may not end before its payment clocks did: an invoice
  // reversal dated before a payment or that payment's reversal would make the
  // aging view and the ledger disagree for the days in between.
  for (const settlement of clocks) {
    if (at < settlement.paidAt || (settlement.reversedAt && at < settlement.reversedAt)) {
      fail('INVALID_DATE');
    }
  }
  await assertOpenPeriod(db, scope, at);
  const policy = await reversalPolicy(invoice.createdByUserId, scope, options);

  const reversal = await reverseJournalEntry(db, scope, {
    entryId: invoice.journalEntryId,
    reason,
    at,
    idempotencyKey: apInvoiceReversalKey(invoice.id),
  });
  if (
    reversal.reversesEntryId !== invoice.journalEntryId ||
    reversal.sourceKind !== 'PHARMACY_AP_INVOICE' ||
    reversal.sourceId !== invoice.id
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  const reversed = await db.pharmacyApInvoice.update({
    where: { id: invoice.id },
    data: {
      status: 'REVERSED',
      reversedAt: at,
      reversedByUserId: scope.actorId,
      reversalReason: reason,
      reverseCommandKey: input.commandKey,
      reversePayloadHash: payloadHash,
      reversalEntryId: reversal.id,
    },
  });
  return { invoice: reversed, entry: reversal, policy, replayed: false as const };
}

export function listApInvoices(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: Pick<ListApInvoicesInput, 'status' | 'take'>
) {
  return db.pharmacyApInvoice.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(input.status ? { status: input.status } : {}),
    },
    include: { settlements: { orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ invoiceDate: 'desc' }, { id: 'asc' }],
    take: input.take,
  });
}
