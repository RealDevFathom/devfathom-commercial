/**
 * DEV-694: setting a supplier credit note off against an open AP invoice.
 *
 * Owner decision: staff choose the supplier bill; the payable is reduced only
 * after a manager approves. So there are two commands:
 *   - `requestApCreditSetOff` records a PENDING request. No money moves.
 *   - `approveApCreditSetOff` (a manager, after re-entering their own PIN in
 *     the router) posts one canonical entry, Dr ACCOUNTS_PAYABLE /
 *     Cr SUPPLIER_CLAIM_RECEIVABLE, and marks the request APPROVED. From the
 *     approval instant the bill's outstanding falls by the set-off amount.
 *   - `rejectApCreditSetOff` closes a request without touching money.
 *
 * Money rules, all enforced here on the server and re-checked at approval
 * under row locks:
 *   - PKR only: supplier credits carry no currency, so a USD bill is refused.
 *   - The credit's supplier name must match the bill's payee (AP invoices carry
 *     no supplier id; both sides use the same normalized payee key).
 *   - A set-off never exceeds what is left on the credit (its amount less its
 *     debit-note allocations and approved set-offs) nor what is still payable on
 *     the bill (its amount less payments and approved set-offs).
 *   - The approver must not be the requester, unless they are the
 *     organization's only active owner-level user (the solo-pharmacy rule); the
 *     router still demands their fresh PIN and the audit row records it.
 *
 * Lock order: ledger scope, set-off row, credit row, invoice row. Debit-note
 * allocation also locks the credit row first, so the two spenders of one
 * credit serialize.
 */
import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError, postJournalEntry } from '@/lib/finance/journal';
import { lockPharmacyLedgerScope } from '@/lib/pharmacy/bookkeeping';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AP_INVOICE_MAX_MINOR,
  type ApproveApCreditSetOffInput,
  type ListApCreditSetOffsInput,
  type RejectApCreditSetOffInput,
  type RequestApCreditSetOffInput,
} from './ap-invoices-schema';
import {
  type ApInvoiceScope,
  invoiceSettlementClocks,
  lockInvoice,
  normalizePayeeKey,
  payableMinorFrom,
  PharmacyApInvoiceError,
  type ApInvoiceErrorReason,
} from './ap-invoices';
import { commandPayloadHash } from './general-journal';

export const AP_SET_OFF_CURRENCY = 'PKR';
export const AP_SET_OFF_SEGREGATED_POLICY = 'PHARMACY_AP_SET_OFF_MANAGER_PIN';
export const AP_SET_OFF_SOLE_APPROVER_POLICY = 'PHARMACY_AP_SET_OFF_SOLE_APPROVER_PIN';

export const apCreditSetOffPostingKey = (setOffId: string) => `ap-credit-set-off:${setOffId}`;

function fail(reason: ApInvoiceErrorReason): never {
  throw new PharmacyApInvoiceError(reason);
}

function positiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > AP_INVOICE_MAX_MINOR) {
    fail('INVALID_AMOUNT');
  }
}

async function lockCredit(db: ScopedDb, scope: ApInvoiceScope, creditId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_supplier_credits
    WHERE id=${creditId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const credit = await db.pharmacySupplierCredit.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: creditId },
    include: { supplier: { select: { name: true } } },
  });
  if (!credit) fail('NOT_FOUND');
  return credit;
}

async function lockSetOff(db: ScopedDb, scope: ApInvoiceScope, setOffId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_ap_credit_set_offs
    WHERE id=${setOffId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const setOff = await db.pharmacyApCreditSetOff.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: setOffId },
  });
  if (!setOff) fail('NOT_FOUND');
  return setOff;
}

/**
 * What is still unspent on a credit: its amount less debit-note allocations and
 * approved set-offs (and, when `includePending`, requests awaiting approval).
 */
export async function creditRemainingMinor(
  db: ScopedDb,
  scope: Pick<ApInvoiceScope, 'organizationId'>,
  credit: { id: string; amountMinor: number },
  options: { includePending: boolean; excludeSetOffId?: string }
) {
  const [allocated, setOff] = await Promise.all([
    db.pharmacySupplierCreditAllocation.aggregate({
      where: { organizationId: scope.organizationId, supplierCreditId: credit.id },
      _sum: { amountMinor: true },
    }),
    db.pharmacyApCreditSetOff.aggregate({
      where: {
        organizationId: scope.organizationId,
        supplierCreditId: credit.id,
        status: { in: options.includePending ? ['APPROVED', 'PENDING'] : ['APPROVED'] },
        ...(options.excludeSetOffId ? { id: { not: options.excludeSetOffId } } : {}),
      },
      _sum: { amountMinor: true },
    }),
  ]);
  return credit.amountMinor - (allocated._sum.amountMinor ?? 0) - (setOff._sum.amountMinor ?? 0);
}

async function pendingOnInvoiceMinor(db: ScopedDb, scope: ApInvoiceScope, invoiceId: string) {
  const pending = await db.pharmacyApCreditSetOff.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      invoiceId,
      status: 'PENDING',
    },
    _sum: { amountMinor: true },
  });
  return pending._sum.amountMinor ?? 0;
}

type LockedInvoice = Awaited<ReturnType<typeof lockInvoice>>;
type LockedCredit = Awaited<ReturnType<typeof lockCredit>>;

function assertPair(invoice: LockedInvoice, credit: LockedCredit) {
  if (invoice.status !== 'POSTED') fail('INVALID_STATE');
  if (invoice.currency !== AP_SET_OFF_CURRENCY) fail('INVALID_STATE');
  if (normalizePayeeKey(credit.supplier.name) !== invoice.payeeKey) fail('SUPPLIER_MISMATCH');
}

function billPayableMinor(invoice: LockedInvoice, at: Date) {
  return payableMinorFrom(
    { amountMinor: invoice.amountMinor, settlements: invoiceSettlementClocks(invoice) },
    at
  );
}

export async function requestApCreditSetOff(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: Omit<RequestApCreditSetOffInput, 'branchId'>,
  now: Date = new Date()
) {
  positiveMinor(input.amountMinor);
  const note = input.note?.trim() || null;
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    invoiceId: input.invoiceId,
    supplierCreditId: input.supplierCreditId,
    amountMinor: input.amountMinor,
    note: note ?? '',
  });
  const replay = await db.pharmacyApCreditSetOff.findFirst({
    where: { organizationId: scope.organizationId, requestKey: input.requestKey },
  });
  if (replay) {
    if (replay.branchId !== scope.branchId || replay.requestPayloadHash !== payloadHash) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return { setOff: replay, replayed: true as const };
  }

  const credit = await lockCredit(db, scope, input.supplierCreditId);
  const invoice = await lockInvoice(db, scope, input.invoiceId);
  assertPair(invoice, credit);
  // Pending requests already claim their share, so a second request cannot be
  // queued against money another request is waiting to spend.
  const creditLeft = await creditRemainingMinor(db, scope, credit, { includePending: true });
  if (input.amountMinor > creditLeft) fail('SET_OFF_EXCEEDS_CREDIT');
  const billLeft =
    billPayableMinor(invoice, now) - (await pendingOnInvoiceMinor(db, scope, invoice.id));
  if (input.amountMinor > billLeft) fail('SET_OFF_EXCEEDS_BILL');

  const setOff = await db.pharmacyApCreditSetOff.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      invoiceId: invoice.id,
      supplierCreditId: credit.id,
      amountMinor: input.amountMinor,
      currency: AP_SET_OFF_CURRENCY,
      note,
      requestKey: input.requestKey,
      requestPayloadHash: payloadHash,
      requestedByUserId: scope.actorId,
      requestedAt: now,
    },
  });
  return { setOff, replayed: false as const };
}

function decisionReplay(
  setOff: { branchId: string; id: string; status: string; decisionKey: string | null },
  scope: ApInvoiceScope,
  input: { setOffId: string; decisionKey: string },
  status: 'APPROVED' | 'REJECTED'
) {
  if (
    setOff.branchId !== scope.branchId ||
    setOff.id !== input.setOffId ||
    setOff.status !== status
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }
}

export async function approveApCreditSetOff(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: Pick<ApproveApCreditSetOffInput, 'setOffId' | 'decisionKey'>,
  options: {
    /** True when the approver is the only person who could approve (solo rule). */
    soleApprover: () => Promise<boolean>;
    now?: Date;
  }
) {
  const now = options.now ?? new Date();
  await lockPharmacyLedgerScope(db, scope);
  const replay = await db.pharmacyApCreditSetOff.findFirst({
    where: { organizationId: scope.organizationId, decisionKey: input.decisionKey },
  });
  if (replay) {
    decisionReplay(replay, scope, input, 'APPROVED');
    return { setOff: replay, replayed: true as const };
  }

  const setOff = await lockSetOff(db, scope, input.setOffId);
  if (setOff.status !== 'PENDING') fail('ALREADY_DECIDED');
  let policy = AP_SET_OFF_SEGREGATED_POLICY;
  if (setOff.requestedByUserId === scope.actorId) {
    if (!(await options.soleApprover())) fail('SELF_APPROVAL');
    policy = AP_SET_OFF_SOLE_APPROVER_POLICY;
  }
  const credit = await lockCredit(db, scope, setOff.supplierCreditId);
  const invoice = await lockInvoice(db, scope, setOff.invoiceId);
  assertPair(invoice, credit);
  if (setOff.currency !== AP_SET_OFF_CURRENCY) fail('INVALID_STATE');
  const creditLeft = await creditRemainingMinor(db, scope, credit, { includePending: false });
  if (setOff.amountMinor > creditLeft) fail('SET_OFF_EXCEEDS_CREDIT');
  if (setOff.amountMinor > billPayableMinor(invoice, now)) fail('SET_OFF_EXCEEDS_BILL');

  let entry;
  try {
    entry = await postJournalEntry(db, scope, {
      sourceKind: 'PHARMACY_AP_CREDIT_SET_OFF',
      sourceId: setOff.id,
      description: `Supplier credit ${credit.reference} set off against ${invoice.reference}`,
      occurredAt: now,
      idempotencyKey: apCreditSetOffPostingKey(setOff.id),
      branchId: scope.branchId,
      currency: AP_SET_OFF_CURRENCY,
      lines: [
        {
          accountCode: 'ACCOUNTS_PAYABLE',
          side: 'DEBIT',
          amountMinor: setOff.amountMinor,
          branchId: scope.branchId,
          memo: invoice.supplierInvoiceRef,
        },
        {
          accountCode: 'SUPPLIER_CLAIM_RECEIVABLE',
          side: 'CREDIT',
          amountMinor: setOff.amountMinor,
          branchId: scope.branchId,
          memo: credit.reference,
        },
      ],
    });
  } catch (error) {
    if (error instanceof FinancePostingError)
      fail(error.reason === 'PERIOD_CLOSED' ? 'PERIOD_CLOSED' : 'IDEMPOTENCY_CONFLICT');
    throw error;
  }
  if (
    entry.sourceKind !== 'PHARMACY_AP_CREDIT_SET_OFF' ||
    entry.sourceId !== setOff.id ||
    entry.organizationId !== scope.organizationId ||
    entry.branchId !== scope.branchId ||
    entry.reversesEntryId !== null
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  const approved = await db.pharmacyApCreditSetOff.update({
    where: { id: setOff.id },
    data: {
      status: 'APPROVED',
      decisionKey: input.decisionKey,
      decidedByUserId: scope.actorId,
      decidedAt: now,
      approvalPolicy: policy,
      journalEntryId: entry.id,
    },
  });
  return {
    setOff: approved,
    entry,
    selfApproved: policy === AP_SET_OFF_SOLE_APPROVER_POLICY,
    replayed: false as const,
  };
}

export async function rejectApCreditSetOff(
  db: ScopedDb,
  scope: ApInvoiceScope,
  input: Pick<RejectApCreditSetOffInput, 'setOffId' | 'decisionKey' | 'reason'>,
  now: Date = new Date()
) {
  const reason = input.reason.trim();
  if (!reason) fail('MISSING_REASON');
  await lockPharmacyLedgerScope(db, scope);
  const replay = await db.pharmacyApCreditSetOff.findFirst({
    where: { organizationId: scope.organizationId, decisionKey: input.decisionKey },
  });
  if (replay) {
    decisionReplay(replay, scope, input, 'REJECTED');
    return { setOff: replay, replayed: true as const };
  }
  const setOff = await lockSetOff(db, scope, input.setOffId);
  if (setOff.status !== 'PENDING') fail('ALREADY_DECIDED');
  const rejected = await db.pharmacyApCreditSetOff.update({
    where: { id: setOff.id },
    data: {
      status: 'REJECTED',
      decisionKey: input.decisionKey,
      decidedByUserId: scope.actorId,
      decidedAt: now,
      rejectionReason: reason,
    },
  });
  return { setOff: rejected, replayed: false as const };
}

export function listApCreditSetOffs(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: Pick<ListApCreditSetOffsInput, 'status' | 'take'>
) {
  return db.pharmacyApCreditSetOff.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(input.status ? { status: input.status } : {}),
    },
    select: {
      id: true,
      status: true,
      amountMinor: true,
      currency: true,
      note: true,
      requestedByUserId: true,
      requestedAt: true,
      decidedByUserId: true,
      decidedAt: true,
      rejectionReason: true,
      invoice: { select: { id: true, reference: true, payeeName: true, supplierInvoiceRef: true } },
      credit: {
        select: { id: true, reference: true, supplier: { select: { name: true } } },
      },
    },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    take: input.take,
  });
}

/**
 * The solo-pharmacy rule for this control: AP is reachable only by owner-level
 * (ADMIN) users, so when the approver is the organization's only active one,
 * nobody else could ever approve and they may approve their own request with a
 * fresh PIN. A second active owner-level user ends the exception.
 */
export async function isSoleSetOffApprover(
  db: ScopedDb,
  organizationId: string,
  actorId: string
): Promise<boolean> {
  const others = await db.user.count({
    where: { organizationId, status: 'ACTIVE', role: 'ADMIN', id: { not: actorId } },
  });
  return others === 0;
}
