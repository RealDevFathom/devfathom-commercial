import { beforeEach, describe, expect, it, vi } from 'vitest';

const journal = vi.hoisted(() => ({
  post: vi.fn(async () => ({ id: 'entry-1' })),
  reverse: vi.fn(async () => ({ id: 'reversal-1' })),
}));

vi.mock('@/lib/finance/journal', () => ({
  postJournalEntry: journal.post,
  reverseJournalEntry: journal.reverse,
}));

import {
  cancelGeneralJournal,
  createGeneralJournalDraft,
  postGeneralJournal,
  reverseGeneralJournal,
  updateGeneralJournalDraft,
} from './general-journal';
import { createJournalDraftSchema, GENERAL_JOURNAL_MAX_DATE, GENERAL_JOURNAL_MIN_DATE } from './general-journal-schema';

describe('pharmacy journal input boundary', () => {
  const valid = { branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL', amountMinor: 100, currency: 'PKR', occurredAt: '2026-10-25T12:00:00Z', evidence: 'October electricity invoice', reason: 'Month-end accrual', idempotencyKey: 'request-1' };
  it('accepts the one allocated purpose and safe Int32 minor units', () => expect(createJournalDraftSchema.safeParse(valid).success).toBe(true));
  it.each([
    [{ ...valid, purpose: 'BANK_PAYMENT' }],
    [{ ...valid, amountMinor: 2_147_483_648 }],
    [{ ...valid, amountMinor: 1.5 }],
    [{ ...valid, evidence: ' ' }],
    [{ ...valid, occurredAt: 'not-a-date' }],
    [{ ...valid, extraAccount: 'BANK' }],
  ])('rejects inputs outside the sealed voucher contract', (input) => expect(createJournalDraftSchema.safeParse(input).success).toBe(false));
  it('accepts the lower date bound and rejects the exclusive upper bound', () => {
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: GENERAL_JOURNAL_MIN_DATE }).success).toBe(true);
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: new Date(GENERAL_JOURNAL_MIN_DATE.getTime() - 1) }).success).toBe(false);
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: GENERAL_JOURNAL_MAX_DATE }).success).toBe(false);
  });
});

describe('draft creation replay', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };
  const input = { branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL' as const, amountMinor: 100, currency: 'PKR' as const, occurredAt: new Date('2026-10-25T12:00:00Z'), evidence: ' invoice ', reason: ' accrual ', idempotencyKey: 'key-1' };
  type ReplayDocument = Pick<Awaited<ReturnType<typeof createGeneralJournalDraft>>, 'id'> & { createPayloadHash?: string };
  const baseDb = () => ({ $executeRaw: async () => 1, auditLog: { create: vi.fn(async () => ({})) }, pharmacyGeneralJournalDocument: { findFirst: async (): Promise<ReplayDocument | null> => null, create: async ({ data }: { data: object }) => ({ id: 'draft-1', version: 1, ...data }) } });

  it('returns a same-branch replay only when the canonical payload matches', async () => {
    const db = baseDb();
    const first = await createGeneralJournalDraft(db as never, scope, input);
    db.pharmacyGeneralJournalDocument.findFirst = async () => first;
    await expect(createGeneralJournalDraft(db as never, scope, input)).resolves.toEqual(first);
    await expect(createGeneralJournalDraft(db as never, scope, { ...input, amountMinor: 101 })).rejects.toMatchObject({ reason: 'REPLAY_MISMATCH' });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: scope.organizationId, actorId: scope.actorId, action: 'pharmacyGeneralJournal.createDraft',
      targetId: first.id, outcome: 'SUCCESS',
    }) });
  });

  it('awaits the draft creation audit inside the business transaction', async () => {
    const db = baseDb();
    db.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(createGeneralJournalDraft(db as never, scope, input)).rejects.toThrow('audit unavailable');
  });

  it('does not return a document associated with the same key in another branch', async () => {
    const db = baseDb();
    let call = 0;
    db.pharmacyGeneralJournalDocument.findFirst = async () => (++call === 1 ? null : { id: 'other-branch-document' });
    await expect(createGeneralJournalDraft(db as never, scope, input)).rejects.toMatchObject({ reason: 'REPLAY_MISMATCH' });
  });
});

describe('voucher lifecycle commands', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };
  const occurredAt = new Date('2026-10-25T12:00:00Z');

  beforeEach(() => vi.clearAllMocks());

  function database(initial: 'DRAFT' | 'POSTED' = 'DRAFT', amountMinor = 100) {
    let row = {
      id: 'document-1', organizationId: 'org-1', branchId: 'branch-1', reference: 'JV-1',
      reason: 'accrual', evidence: 'invoice', amountMinor, currency: 'PKR', occurredAt,
      status: initial, version: initial === 'DRAFT' ? 1 : 2, journalEntryId: initial === 'POSTED' ? 'entry-1' : null,
      postKey: initial === 'POSTED' ? 'post-1' : null, postPayloadHash: null,
      reverseKey: null, reversePayloadHash: null,
    };
    const db = {
      $executeRaw: vi.fn(async () => 1),
      pharmacyAccountingPeriod: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
      auditLog: { create: vi.fn(async () => ({})) },
      pharmacyGeneralJournalDocument: {
        findFirst: vi.fn(async () => ({ ...row })),
        findFirstOrThrow: vi.fn(async () => ({ ...row })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          row = { ...row, ...data, version: row.version + 1 } as typeof row;
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          row = { ...row, ...data, version: row.version + 1 } as typeof row;
          return { ...row };
        }),
      },
    };
    return { db, row: () => row };
  }

  it.each([1, 12_345, 2_147_483_647])('posts one canonical balanced entry for %i minor units, audits success, and replays the identical command', async (amountMinor) => {
    const { db } = database('DRAFT', amountMinor);
    const command = { documentId: 'document-1', version: 1, idempotencyKey: 'post-1' };
    const posted = await postGeneralJournal(db as never, scope, command);
    expect(journal.post).toHaveBeenCalledWith(db, scope, expect.objectContaining({
      sourceId: 'document-1', idempotencyKey: 'pharmacy-jv:document-1',
      lines: [
        expect.objectContaining({ accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor }),
        expect.objectContaining({ accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor }),
      ],
    }));
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'SUCCESS' }) }));
    await expect(postGeneralJournal(db as never, scope, command)).resolves.toEqual(posted);
    expect(journal.post).toHaveBeenCalledTimes(1);
    await expect(postGeneralJournal(db as never, scope, { ...command, idempotencyKey: 'different-key' }))
      .rejects.toMatchObject({ reason: 'REPLAY_MISMATCH' });
  });

  it('rejects stale, closed-period, and invalid-state posting before writing the ledger', async () => {
    const stale = database();
    await expect(postGeneralJournal(stale.db as never, scope, { documentId: 'document-1', version: 0, idempotencyKey: 'x' }))
      .rejects.toMatchObject({ reason: 'STALE_VERSION' });
    const closed = database();
    closed.db.pharmacyAccountingPeriod.findFirst.mockResolvedValue({ id: 'closed' });
    await expect(postGeneralJournal(closed.db as never, scope, { documentId: 'document-1', version: 1, idempotencyKey: 'x' }))
      .rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    const posted = database('POSTED');
    posted.db.pharmacyGeneralJournalDocument.findFirst.mockResolvedValue({ ...posted.row(), postKey: null });
    await expect(postGeneralJournal(posted.db as never, scope, { documentId: 'document-1', version: 2, idempotencyKey: 'x' }))
      .rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(journal.post).not.toHaveBeenCalled();
  });

  it('cancels only a matching draft version', async () => {
    const success = database();
    await expect(cancelGeneralJournal(success.db as never, scope, { documentId: 'document-1', version: 1 }))
      .resolves.toMatchObject({ status: 'CANCELLED', version: 2 });
    expect(success.db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: scope.organizationId, actorId: scope.actorId, action: 'pharmacyGeneralJournal.cancel',
      targetId: 'document-1', outcome: 'SUCCESS', result: { status: 'CANCELLED' },
    }) });
    const conflict = database();
    conflict.db.pharmacyGeneralJournalDocument.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelGeneralJournal(conflict.db as never, scope, { documentId: 'document-1', version: 1 }))
      .rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(conflict.db.auditLog.create).not.toHaveBeenCalled();
  });

  it('audits draft updates and rejects stale updates without a success audit', async () => {
    const { db } = database();
    const input = { documentId: 'document-1', version: 1, reference: 'JV-2', purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
      amountMinor: 200, currency: 'PKR' as const, occurredAt, evidence: 'invoice', reason: 'correction' };
    await expect(updateGeneralJournalDraft(db as never, scope, input)).resolves.toMatchObject({ reference: 'JV-2', version: 2 });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: scope.organizationId, actorId: scope.actorId, action: 'pharmacyGeneralJournal.updateDraft',
      targetId: 'document-1', input: { version: 1 }, result: { version: 2 }, outcome: 'SUCCESS',
    }) });
    db.auditLog.create.mockClear();
    db.pharmacyGeneralJournalDocument.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(updateGeneralJournalDraft(db as never, scope, input)).rejects.toMatchObject({ reason: 'STALE_VERSION' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
    db.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(updateGeneralJournalDraft(db as never, scope, { ...input, version: 2 })).rejects.toThrow('audit unavailable');
  });

  it('awaits cancellation audit failure so the transaction cannot commit silently', async () => {
    const { db } = database();
    db.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(cancelGeneralJournal(db as never, scope, { documentId: 'document-1', version: 1 })).rejects.toThrow('audit unavailable');
  });

  it('reverses additively once and enforces payload-stable replay', async () => {
    const { db } = database('POSTED');
    const command = { documentId: 'document-1', version: 2, idempotencyKey: 'reverse-1', at: new Date('2026-10-26T12:00:00Z'), reason: 'correction' };
    const reversed = await reverseGeneralJournal(db as never, scope, command);
    expect(journal.reverse).toHaveBeenCalledWith(db, scope, expect.objectContaining({ entryId: 'entry-1', idempotencyKey: 'pharmacy-jv-reversal:document-1' }));
    await expect(reverseGeneralJournal(db as never, scope, command)).resolves.toEqual(reversed);
    expect(journal.reverse).toHaveBeenCalledTimes(1);
    await expect(reverseGeneralJournal(db as never, scope, { ...command, reason: 'another correction' }))
      .rejects.toMatchObject({ reason: 'REPLAY_MISMATCH' });
  });

  it('rejects reversals before the original accounting date, even in an open period', async () => {
    const { db } = database('POSTED');
    await expect(reverseGeneralJournal(db as never, scope, { documentId: 'document-1', version: 2,
      idempotencyKey: 'reverse-1', at: new Date(occurredAt.getTime() - 1), reason: 'correction' }))
      .rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(journal.reverse).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows a reversal at the original accounting date', async () => {
    const { db } = database('POSTED');
    await expect(reverseGeneralJournal(db as never, scope, { documentId: 'document-1', version: 2,
      idempotencyKey: 'reverse-1', at: occurredAt, reason: 'correction' })).resolves.toMatchObject({ status: 'REVERSED' });
  });

  it('awaits the success audit so a transaction can roll back the document and ledger together', async () => {
    const { db } = database();
    db.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(postGeneralJournal(db as never, scope, { documentId: 'document-1', version: 1, idempotencyKey: 'post-1' }))
      .rejects.toThrow('audit unavailable');
  });
});
