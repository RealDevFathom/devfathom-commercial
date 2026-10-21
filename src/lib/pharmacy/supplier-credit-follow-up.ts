import {
  creditPosition,
  type DebitNoteStatus,
  type PurchaseReturnStatus,
} from './supplier-returns';

type Scope = { organizationId: string; branchId: string };
type Allocation = { organizationId: string; amountMinor: number };
type Note = Scope & {
  id: string;
  supplierId: string;
  purchaseReturnId: string;
  reference: string;
  status: DebitNoteStatus;
  cancelledAt: Date | null;
  issuedAt: Date | null;
  expectedCreditMinor: number;
  allocations: (Allocation & { debitNoteId: string })[];
};
export type FollowUpReturn = Scope & {
  id: string;
  supplierId: string;
  supplier: { name: string };
  reference: string;
  status: PurchaseReturnStatus;
  dispatchedAt: Date | null;
  lines: { returnWindowEndsAt: Date | null }[];
  debitNotes: Note[];
};
export type FollowUpCredit = Scope & {
  id: string;
  supplierId: string;
  reference: string;
  amountMinor: number;
  allocations: (Allocation & { supplierCreditId: string })[];
};

const DAY = 86_400_000;
function timestamp(value: Date | null): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

/** Advisory only: never consumes credit, changes a ledger or infers a contractual due date. */
export function supplierCreditFollowUp(input: {
  scope: Scope;
  returns: readonly FollowUpReturn[];
  credits: readonly FollowUpCredit[];
  asOf: Date;
  coverage: 'complete' | 'partial';
}) {
  const at = timestamp(input.asOf);
  if (at === null) throw new Error('A valid explicit as-of time is required.');
  let excluded = 0;
  const inScope = (row: Scope) =>
    Boolean(input.scope.organizationId && input.scope.branchId) &&
    row.organizationId === input.scope.organizationId &&
    row.branchId === input.scope.branchId;
  const available: {
    id: string;
    supplierId: string;
    reference: string;
    unallocatedMinor: number;
  }[] = [];
  for (const credit of input.credits) {
    try {
      if (
        !inScope(credit) ||
        credit.allocations.some(
          (a) => a.organizationId !== input.scope.organizationId || a.supplierCreditId !== credit.id
        )
      )
        throw new Error('Credit scope mismatch');
      const position = creditPosition({
        expectedCreditMinor: credit.amountMinor,
        allocations: credit.allocations,
      });
      if (!Number.isSafeInteger(position.receivedCreditMinor) || position.varianceMinor < 0)
        throw new Error('Invalid allocation');
      if (position.outstandingMinor > 0)
        available.push({
          id: credit.id,
          supplierId: credit.supplierId,
          reference: credit.reference,
          unallocatedMinor: position.outstandingMinor,
        });
    } catch {
      excluded++;
    }
  }
  const claims: {
    id: string;
    returnId: string;
    reference: string;
    supplier: string;
    ageDays: number | null;
    issuedAt: number | null;
    outstandingMinor: number;
    allocatedMinor: number;
    credits: typeof available;
  }[] = [];
  const dispatch: {
    id: string;
    reference: string;
    supplier: string;
    deadline: number | null;
    state: 'review' | 'closed' | 'unknown';
  }[] = [];
  for (const row of input.returns) {
    if (!inScope(row)) {
      excluded++;
      continue;
    }
    if (row.status === 'SUBMITTED' && row.dispatchedAt === null) {
      const deadlines = row.lines.map((line) => timestamp(line.returnWindowEndsAt));
      const known = deadlines.filter((value): value is number => value !== null);
      const earliest = known.length ? Math.min(...known) : null;
      const closed = earliest !== null && earliest <= at;
      const complete = deadlines.length > 0 && known.length === deadlines.length;
      // One closed line blocks dispatch, even if another line's deadline is unknown.
      dispatch.push({
        id: row.id,
        reference: row.reference,
        supplier: row.supplier.name,
        deadline: complete || closed ? earliest : null,
        state: closed ? 'closed' : complete ? 'review' : 'unknown',
      });
    }
    if (row.status !== 'DISPATCHED') continue;
    for (const note of row.debitNotes) {
      if (note.status !== 'OPEN' && note.status !== 'PARTIALLY_SETTLED') continue;
      if (note.cancelledAt !== null) continue;
      try {
        if (
          !inScope(note) ||
          note.supplierId !== row.supplierId ||
          note.purchaseReturnId !== row.id ||
          note.allocations.some(
            (a) => a.organizationId !== input.scope.organizationId || a.debitNoteId !== note.id
          )
        )
          throw new Error('Note scope mismatch');
        const position = creditPosition({
          expectedCreditMinor: note.expectedCreditMinor,
          allocations: note.allocations,
        });
        if (!Number.isSafeInteger(position.receivedCreditMinor) || position.varianceMinor < 0)
          throw new Error('Invalid allocation');
        if (!position.outstandingMinor) continue;
        const issued = timestamp(note.issuedAt);
        const issuedAt = issued !== null && issued <= at ? issued : null;
        claims.push({
          id: note.id,
          returnId: row.id,
          reference: note.reference,
          supplier: row.supplier.name,
          issuedAt,
          ageDays: issuedAt === null ? null : Math.floor((at - issuedAt) / DAY),
          outstandingMinor: position.outstandingMinor,
          allocatedMinor: position.receivedCreditMinor,
          credits: available.filter((credit) => credit.supplierId === row.supplierId),
        });
      } catch {
        excluded++;
      }
    }
  }
  claims.sort(
    (a, b) => (a.issuedAt ?? Infinity) - (b.issuedAt ?? Infinity) || a.id.localeCompare(b.id)
  );
  const deadlinePriority = { review: 0, closed: 1, unknown: 2 };
  dispatch.sort(
    (a, b) =>
      deadlinePriority[a.state] - deadlinePriority[b.state] ||
      (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
      a.id.localeCompare(b.id)
  );
  return { claims, dispatch, excluded, coverage: input.coverage, asOf: input.asOf.toISOString() };
}
