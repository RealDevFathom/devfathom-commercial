import type { LedgerScope } from '../../stock-ledger';
import {
  CardTerminalError,
  OPEN_ATTEMPT_STATUSES,
  sameDraft,
  type CardTerminalAttempt,
  type CardTerminalAttemptStatus,
  type CardTerminalAttemptStore,
  type CardTerminalAuditDetail,
} from '../store';

/**
 * DEV-743: in-memory attempt store for the mocked end-to-end tests. It enforces the same rules
 * as the migration: one open attempt per sale, the allowed lifecycle, write-once evidence and a
 * settled attempt linked to exactly one tender.
 */

const ALLOWED: Record<CardTerminalAttemptStatus, readonly CardTerminalAttemptStatus[]> = {
  CREATED: ['SENT', 'ABANDONED'],
  SENT: ['APPROVED', 'DECLINED', 'UNKNOWN', 'MANUAL_REVIEW'],
  UNKNOWN: ['UNKNOWN', 'APPROVED', 'DECLINED', 'MANUAL_REVIEW'],
  APPROVED: ['SETTLED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['DECLINED', 'REVERSED'],
  SETTLED: [],
  DECLINED: [],
  ABANDONED: [],
  REVERSED: [],
};

const EVIDENCE = ['providerRef', 'approvalCode', 'cardBrand', 'cardLast4', 'sentAt'] as const;
const RESOLUTION = ['resolvedById', 'resolutionReason', 'resolutionRef'] as const;

export type InMemoryAttemptStore = CardTerminalAttemptStore & {
  all(): CardTerminalAttempt[];
  /** Tender ids written by `settle`, in order. */
  tenders: { tenderId: string; attemptId: string; providerRef: string; amountMinor: number }[];
  /** One entry per committed change, as the real store writes its audit rows. */
  audits: {
    attemptId: string;
    from: CardTerminalAttemptStatus | null;
    to: CardTerminalAttemptStatus;
    detail: CardTerminalAuditDetail;
  }[];
};

export function createInMemoryAttemptStore(
  options: {
    /** Remaining amount on an open sale, or null when the sale is not open. */
    saleRemaining?: (saleId: string) => number | null;
    /** Throw to simulate a settlement refusal. */
    beforeSettle?: (attempt: CardTerminalAttempt) => void;
    now?: () => Date;
  } = {}
): InMemoryAttemptStore {
  const rows = new Map<string, CardTerminalAttempt>();
  const tenders: InMemoryAttemptStore['tenders'] = [];
  const audits: InMemoryAttemptStore['audits'] = [];
  let sequence = 0;
  const copy = (row: CardTerminalAttempt) => structuredClone(row);
  const inScope = (row: CardTerminalAttempt, scope: LedgerScope) =>
    row.organizationId === scope.organizationId && row.branchId === scope.branchId;

  return {
    tenders,
    audits,
    all: () => [...rows.values()].map(copy),
    async create(scope, draft) {
      const existing = [...rows.values()].find(
        (row) => row.organizationId === scope.organizationId && row.attemptKey === draft.attemptKey
      );
      if (existing) {
        if (!sameDraft(existing, scope, draft)) throw new CardTerminalError('IDEMPOTENCY_CONFLICT');
        return { created: false, attempt: copy(existing) };
      }
      if (
        [...rows.values()].some(
          (row) =>
            inScope(row, scope) &&
            row.saleId === draft.saleId &&
            OPEN_ATTEMPT_STATUSES.includes(row.status)
        )
      )
        throw new CardTerminalError('ATTEMPT_IN_PROGRESS');
      const remaining = options.saleRemaining ? options.saleRemaining(draft.saleId) : Infinity;
      if (remaining === null) throw new CardTerminalError('INVALID_STATE');
      if (draft.amountMinor > remaining) throw new CardTerminalError('INVALID_INPUT');
      sequence += 1;
      const attempt: CardTerminalAttempt = {
        id: `attempt-${sequence}`,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        ...draft,
        status: 'CREATED',
        providerRef: null,
        approvalCode: null,
        cardBrand: null,
        cardLast4: null,
        declineCode: null,
        statusChecks: 0,
        tenderId: null,
        reviewReason: null,
        resolvedById: null,
        resolutionReason: null,
        resolutionRef: null,
        actorId: scope.actorId,
        sentAt: null,
        resolvedAt: null,
        createdAt: options.now?.() ?? new Date(),
      };
      rows.set(attempt.id, attempt);
      audits.push({ attemptId: attempt.id, from: null, to: 'CREATED', detail: {} });
      return { created: true, attempt: copy(attempt) };
    },
    async get(scope, attemptKey) {
      const row = [...rows.values()].find(
        (candidate) => inScope(candidate, scope) && candidate.attemptKey === attemptKey
      );
      return row ? copy(row) : null;
    },
    async transition(scope, current, patch, detail = {}) {
      const row = rows.get(current.id);
      if (
        !row ||
        !inScope(row, scope) ||
        row.status !== current.status ||
        row.statusChecks !== current.statusChecks
      )
        return null;
      if (!ALLOWED[row.status].includes(patch.status) || patch.status === 'SETTLED')
        throw new Error(`invalid transition ${row.status} -> ${patch.status}`);
      for (const field of EVIDENCE) {
        const before = row[field];
        if (before !== null && field in patch && patch[field] !== before)
          throw new Error(`${field} is written once`);
      }
      if (patch.status === 'DECLINED' && (patch.providerRef ?? row.providerRef))
        throw new Error('an approved charge cannot be marked declined');
      const resolving = row.status === 'MANUAL_REVIEW';
      for (const field of RESOLUTION)
        if (field in patch && (!resolving || row[field] !== null))
          throw new Error(`${field} is written once, by a review resolution`);
      if (
        resolving &&
        (!patch.resolvedById ||
          !patch.resolvedAt ||
          (patch.resolutionReason?.trim().length ?? 0) < 3 ||
          !patch.resolutionRef)
      )
        throw new Error('a review needs its resolver, reason and slip reference');
      const next = { ...row, ...patch };
      if (resolving && next.status === 'REVERSED' && next.providerRef !== next.resolutionRef)
        throw new Error('a reversal must match its slip reference');
      rows.set(row.id, next);
      audits.push({ attemptId: row.id, from: row.status, to: next.status, detail });
      return copy(next);
    },
    async settle(scope, attemptId) {
      const row = rows.get(attemptId);
      if (!row || !inScope(row, scope)) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
      if (row.status === 'SETTLED' && row.tenderId)
        return { tenderId: row.tenderId, replayed: true };
      if (row.status !== 'APPROVED' || !row.providerRef)
        throw new CardTerminalError('INVALID_STATE');
      options.beforeSettle?.(copy(row));
      const tenderId = `tender-${tenders.length + 1}`;
      tenders.push({
        tenderId,
        attemptId,
        providerRef: row.providerRef,
        amountMinor: row.amountMinor,
      });
      rows.set(row.id, { ...row, status: 'SETTLED', tenderId, resolvedAt: new Date() });
      audits.push({ attemptId: row.id, from: 'APPROVED', to: 'SETTLED', detail: {} });
      return { tenderId, replayed: false };
    },
    async listOpen(scope) {
      return [...rows.values()]
        .filter((row) => inScope(row, scope) && OPEN_ATTEMPT_STATUSES.includes(row.status))
        .map(copy);
    },
    async latestForSale(scope, saleId) {
      // Rows are kept in creation order, so the last match is the newest.
      const row = [...rows.values()]
        .filter((candidate) => inScope(candidate, scope) && candidate.saleId === saleId)
        .at(-1);
      return row ? copy(row) : null;
    },
  };
}
