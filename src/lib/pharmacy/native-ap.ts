import { Prisma } from '@/generated/prisma/client';
import { postJournalEntry } from '@/lib/finance/journal';
import {
  PharmacyBookkeepingError,
  assertAccountingPeriodOpen,
  postBookkeepingTransaction,
  reverseBookkeepingTransaction,
  type BookkeepingScope,
  type PostBookkeepingInput,
} from '@/lib/pharmacy/bookkeeping';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DAY = 86_400_000;
export const NATIVE_AP_MAX_ROWS = 200;
export const NATIVE_AP_MAX_WINDOW_DAYS = 366;

type NativeDb = ScopedDb & Record<string, any>;
export type ExpenseInvoiceInput = {
  supplierId: string;
  supplierInvoiceRef: string;
  description: string;
  issuedAt: Date;
  dueAt: Date;
  amountMinor: number;
  idempotencyKey: string;
  lines: Array<{ description: string; amountMinor: number }>;
};

function positive(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PharmacyBookkeepingError('INVALID_AMOUNT');
}

/** Admit a non-stock invoice and post its expense/payable accrual exactly once. */
export async function createSupplierExpenseInvoice(
  database: ScopedDb,
  scope: BookkeepingScope,
  input: ExpenseInvoiceInput
) {
  const db = database as NativeDb;
  positive(input.amountMinor);
  if (input.dueAt < input.issuedAt || !input.lines.length || input.lines.length > 100)
    throw new PharmacyBookkeepingError('INVALID_STATE');
  const lineTotal = input.lines.reduce((sum, line) => {
    positive(line.amountMinor);
    return sum + line.amountMinor;
  }, 0);
  if (!Number.isSafeInteger(lineTotal) || lineTotal !== input.amountMinor)
    throw new PharmacyBookkeepingError('INVALID_AMOUNT');

  const replay = await db.pharmacySupplierExpenseInvoice.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { lines: true },
  });
  if (replay) {
    const requestedLines = input.lines
      .map(({ description, amountMinor }) => ({ description, amountMinor }))
      .sort((a, b) => a.description.localeCompare(b.description) || a.amountMinor - b.amountMinor);
    const replayLines = replay.lines
      .map(({ description, amountMinor }: { description: string; amountMinor: number }) => ({ description, amountMinor }))
      .sort((a: { description: string; amountMinor: number }, b: { description: string; amountMinor: number }) =>
        a.description.localeCompare(b.description) || a.amountMinor - b.amountMinor
      );
    if (
      replay.branchId !== scope.branchId ||
      replay.supplierId !== input.supplierId ||
      replay.supplierInvoiceRef !== input.supplierInvoiceRef ||
      replay.description !== input.description ||
      new Date(replay.issuedAt).getTime() !== input.issuedAt.getTime() ||
      new Date(replay.dueAt).getTime() !== input.dueAt.getTime() ||
      replay.amountMinor !== input.amountMinor ||
      JSON.stringify(replayLines) !== JSON.stringify(requestedLines)
    ) throw new PharmacyBookkeepingError('INVALID_STATE');
    return replay;
  }
  const supplier = await db.pharmacySupplier.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: input.supplierId,
      active: true,
      authorized: true,
    },
    select: { id: true },
  });
  if (!supplier) throw new PharmacyBookkeepingError('NOT_FOUND');

  await assertAccountingPeriodOpen(database, scope, input.issuedAt);

  const entry = await postJournalEntry(database, scope, {
    sourceKind: 'PHARMACY_SUPPLIER_EXPENSE_INVOICE',
    sourceId: `native-ap:${input.idempotencyKey}`,
    description: `supplier expense invoice ${input.supplierInvoiceRef}`,
    occurredAt: input.issuedAt,
    idempotencyKey: `native-ap-invoice:${input.idempotencyKey}`,
    branchId: scope.branchId,
    currency: 'PKR',
    lines: [
      { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: input.amountMinor, branchId: scope.branchId },
      { accountCode: 'ACCOUNTS_PAYABLE', side: 'CREDIT', amountMinor: input.amountMinor, branchId: scope.branchId },
    ],
  });
  return db.pharmacySupplierExpenseInvoice.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      supplierId: input.supplierId,
      supplierInvoiceRef: input.supplierInvoiceRef,
      description: input.description,
      issuedAt: input.issuedAt,
      dueAt: input.dueAt,
      amountMinor: input.amountMinor,
      idempotencyKey: input.idempotencyKey,
      journalEntryId: entry.id,
      createdByUserId: scope.actorId,
      lines: { create: input.lines.map((line) => ({ organizationId: scope.organizationId, ...line })) },
      events: { create: { organizationId: scope.organizationId, kind: 'CREATED', actorId: scope.actorId, occurredAt: input.issuedAt } },
    },
    include: { lines: true },
  });
}

/** Invoice-directed wrapper around the one canonical supplier-payment posting path. */
export async function settleSupplierExpenseInvoice(
  database: ScopedDb,
  scope: BookkeepingScope,
  input: { invoiceId: string; amountMinor: number; occurredAt: Date; reference: string; idempotencyKey: string; fundingAccount?: 'CASH' | 'BANK' }
) {
  const db = database as NativeDb;
  positive(input.amountMinor);
  const rows = await db.$queryRaw<Array<{ id: string; amountMinor: number; supplierInvoiceRef: string; issuedAt: Date }>>(Prisma.sql`
    SELECT i.id, i."amountMinor", i."supplierInvoiceRef", i."issuedAt"
    FROM "pharmacy_supplier_expense_invoices" i
    WHERE i."organizationId"=${scope.organizationId} AND i."branchId"=${scope.branchId}
      AND i.id=${input.invoiceId} AND i.status <> 'VOID'
    FOR UPDATE
  `);
  const invoice = rows[0];
  if (!invoice) throw new PharmacyBookkeepingError('NOT_FOUND');
  if (input.occurredAt < new Date(invoice.issuedAt))
    throw new PharmacyBookkeepingError('INVALID_STATE');
  // Check replay after the invoice lock so simultaneous requests converge on the
  // durable result, and bind the key to the complete money-moving request.
  const replay = await db.pharmacySupplierExpenseSettlement.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { invoice: true },
  });
  if (replay) {
    if (
      replay.invoiceId !== invoice.id ||
      replay.invoice.branchId !== scope.branchId ||
      replay.amountMinor !== input.amountMinor ||
      replay.reference !== input.reference ||
      replay.fundingAccount !== (input.fundingAccount ?? 'BANK') ||
      new Date(replay.occurredAt).getTime() !== input.occurredAt.getTime()
    ) throw new PharmacyBookkeepingError('INVALID_STATE');
    return replay;
  }
  const paid = await db.pharmacySupplierExpenseSettlement.aggregate({
    where: { organizationId: scope.organizationId, invoiceId: invoice.id, status: 'POSTED' },
    _sum: { amountMinor: true },
  });
  if ((paid._sum.amountMinor ?? 0) + input.amountMinor > invoice.amountMinor)
    throw new PharmacyBookkeepingError('INVALID_ALLOCATION');
  const canonicalInput: PostBookkeepingInput = {
    reference: input.reference,
    kind: 'SUPPLIER_PAYMENT',
    amountMinor: input.amountMinor,
    occurredAt: input.occurredAt,
    idempotencyKey: `native-ap:${input.idempotencyKey}`,
    fundingAccount: input.fundingAccount,
    allocations: [{ sourceKind: 'EXPENSE', sourceId: invoice.id, sourceReference: invoice.supplierInvoiceRef, amountMinor: input.amountMinor }],
  };
  const canonicalReplay = await db.pharmacyBookkeepingTransaction.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: canonicalInput.idempotencyKey },
  });
  // A canonical transaction without its native settlement can only be a key
  // collision. In a successful native request both records commit atomically.
  if (canonicalReplay) throw new PharmacyBookkeepingError('INVALID_STATE');
  const transaction = await postBookkeepingTransaction(database, scope, canonicalInput);
  const settlement = await db.pharmacySupplierExpenseSettlement.create({ data: {
    organizationId: scope.organizationId, invoiceId: invoice.id, bookkeepingTransactionId: transaction.id,
    amountMinor: input.amountMinor, occurredAt: input.occurredAt, idempotencyKey: input.idempotencyKey,
    reference: input.reference, fundingAccount: input.fundingAccount ?? 'BANK',
  }});
  if ((paid._sum.amountMinor ?? 0) + input.amountMinor === invoice.amountMinor)
    await db.pharmacySupplierExpenseInvoice.updateMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, id: invoice.id, status: 'OPEN' },
      data: { status: 'PAID' },
    });
  return settlement;
}

/** Validate native ownership before the canonical reversal can observe replay/status. */
export async function reverseSupplierExpenseSettlement(
  database: ScopedDb,
  scope: BookkeepingScope,
  input: { settlementId: string; reason: string; at: Date; idempotencyKey: string }
) {
  const db = database as NativeDb;
  // Lock the native settlement before inspecting status or replay evidence.
  // The lock is retained by the router's transaction through canonical journal
  // reversal and native status updates.
  const settlements = await db.$queryRaw<Array<{
    id: string; invoiceId: string; bookkeepingTransactionId: string;
    status: string; occurredAt: Date;
  }>>(Prisma.sql`
    SELECT s.id, s."invoiceId", s."bookkeepingTransactionId", s.status, s."occurredAt"
    FROM pharmacy_supplier_expense_settlements s
    JOIN pharmacy_supplier_expense_invoices i
      ON i."organizationId"=s."organizationId" AND i.id=s."invoiceId"
    WHERE s."organizationId"=${scope.organizationId} AND i."branchId"=${scope.branchId}
      AND s.id=${input.settlementId}
    FOR UPDATE OF s
  `);
  const settlement = settlements[0];
  if (!settlement) throw new PharmacyBookkeepingError('NOT_FOUND');
  if (input.at < new Date(settlement.occurredAt))
    throw new PharmacyBookkeepingError('INVALID_STATE');
  const replay = await db.pharmacySupplierExpenseSettlementReversal.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
  });
  if (replay) {
    if (
      replay.settlementId !== settlement.id ||
      replay.reason !== input.reason ||
      new Date(replay.reversedAt).getTime() !== input.at.getTime()
    ) throw new PharmacyBookkeepingError('INVALID_STATE');
    return replay;
  }
  if (settlement.status !== 'POSTED') throw new PharmacyBookkeepingError('INVALID_STATE');
  await reverseBookkeepingTransaction(database, scope, {
    transactionId: settlement.bookkeepingTransactionId,
    reason: input.reason,
    at: input.at,
    idempotencyKey: input.idempotencyKey,
    nativeSettlementId: settlement.id,
  });
  const reversal = await db.pharmacySupplierExpenseSettlementReversal.create({ data: {
    organizationId: scope.organizationId, settlementId: settlement.id, idempotencyKey: input.idempotencyKey,
    reason: input.reason, reversedAt: input.at, createdByUserId: scope.actorId,
  }});
  await db.pharmacySupplierExpenseSettlement.updateMany({
    where: { organizationId: scope.organizationId, id: settlement.id, status: 'POSTED' },
    data: { status: 'REVERSED' },
  });
  await db.pharmacySupplierExpenseInvoice.updateMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: settlement.invoiceId, status: 'PAID' },
    data: { status: 'OPEN' },
  });
  return reversal;
}

export type NativeApAgingInput = { asOf: Date; from: Date; limit?: number };
export async function supplierExpenseAging(database: ScopedDb, scope: Omit<BookkeepingScope, 'actorId'>, input: NativeApAgingInput) {
  const db = database as NativeDb;
  const nowRows = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`);
  const retrievedAt = new Date(nowRows[0]!.now);
  const limit = input.limit ?? NATIVE_AP_MAX_ROWS;
  if (limit < 1 || limit > NATIVE_AP_MAX_ROWS || input.from > input.asOf || input.asOf > retrievedAt || input.asOf.getTime() - input.from.getTime() > NATIVE_AP_MAX_WINDOW_DAYS * DAY)
    throw new PharmacyBookkeepingError('INVALID_STATE');
  const rows = await db.$queryRaw<Array<{ id: string; supplierInvoiceRef: string; description: string; issuedAt: Date; dueAt: Date; amountMinor: number; outstandingMinor: bigint }>>(Prisma.sql`
    SELECT i.id, i."supplierInvoiceRef", i.description, i."issuedAt", i."dueAt", i."amountMinor",
      (i."amountMinor" - COALESCE(SUM(s."amountMinor") FILTER (WHERE s."occurredAt" <= ${input.asOf}
        AND s."createdAt" <= ${input.asOf} AND s."createdAt" <= ${retrievedAt}
        AND (r.id IS NULL OR NOT (r."reversedAt" <= ${input.asOf} AND r."createdAt" <= ${input.asOf} AND r."createdAt" <= ${retrievedAt}))),0))::bigint AS "outstandingMinor"
    FROM "pharmacy_supplier_expense_invoices" i
    LEFT JOIN "pharmacy_supplier_expense_settlements" s ON s."organizationId"=i."organizationId" AND s."invoiceId"=i.id
    LEFT JOIN "pharmacy_supplier_expense_settlement_reversals" r ON r."organizationId"=s."organizationId" AND r."settlementId"=s.id
    WHERE i."organizationId"=${scope.organizationId} AND i."branchId"=${scope.branchId}
      AND i."issuedAt" <= ${input.asOf} AND i."createdAt" <= ${input.asOf} AND i."createdAt" <= ${retrievedAt}
      AND i."dueAt" >= ${input.from}
      AND NOT EXISTS (
        SELECT 1 FROM "pharmacy_supplier_expense_invoice_events" v
        WHERE v."organizationId"=i."organizationId" AND v."invoiceId"=i.id AND v.kind='VOID'
          AND v."occurredAt" <= ${input.asOf} AND v."createdAt" <= ${input.asOf} AND v."createdAt" <= ${retrievedAt}
      )
    GROUP BY i.id HAVING i."amountMinor" - COALESCE(SUM(s."amountMinor") FILTER (WHERE s."occurredAt" <= ${input.asOf}
      AND s."createdAt" <= ${input.asOf} AND s."createdAt" <= ${retrievedAt}
      AND (r.id IS NULL OR NOT (r."reversedAt" <= ${input.asOf} AND r."createdAt" <= ${input.asOf} AND r."createdAt" <= ${retrievedAt}))),0) > 0
    ORDER BY i."dueAt" ASC, i.id ASC LIMIT ${limit}
  `);
  return { asOf: input.asOf, from: input.from, retrievedAt, bounds: { maxRows: NATIVE_AP_MAX_ROWS, maxWindowDays: NATIVE_AP_MAX_WINDOW_DAYS }, rows: rows.map(row => ({ ...row, outstandingMinor: Number(row.outstandingMinor), daysPastDue: Math.max(0, Math.floor((input.asOf.getTime() - new Date(row.dueAt).getTime()) / DAY)) })) };
}

export function nativeApAgingCsv(report: Awaited<ReturnType<typeof supplierExpenseAging>>) {
  const quote = (value: unknown) => {
    const text = String(value);
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [
    ['Invoice reference','Description','Issued','Due','Outstanding minor','Days past due'],
    ...report.rows.map(row => [row.supplierInvoiceRef,row.description,new Date(row.issuedAt).toISOString(),new Date(row.dueAt).toISOString(),row.outstandingMinor,row.daysPastDue]),
  ].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
