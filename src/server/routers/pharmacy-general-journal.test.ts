import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError } from '@/lib/finance/journal';
import { PharmacyGeneralJournalError } from '@/lib/pharmacy/accounts/general-journal';
import { PHARMACY_GENERAL_JOURNAL_ACCOUNTS } from '@/lib/pharmacy/accounts/coa';

const mocks = vi.hoisted(() => ({ can: vi.fn(), record: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/scoped-db')>()),
  withTenantDb: vi.fn(async (organizationId: string, callback: (db: { auditLog: { create: () => Promise<object> } }) => Promise<unknown>) => callback({ auditLog: { create: vi.fn(async () => ({ organizationId })) } })),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: mocks.can,
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(), ipFromHeaders: vi.fn(() => null), isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.record,
}));

import { documentDto, pharmacyGeneralJournalRouter } from './pharmacy-general-journal';

describe('pharmacy general journal response', () => {
  it('does not expose replay, actor, or ledger-linkage fields', () => {
    const date = new Date('2026-10-25T12:00:00Z');
    const persistenceRow = {
      id: 'doc-1', branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL', status: 'POSTED',
      amountMinor: 100, currency: 'PKR', occurredAt: date, evidence: 'invoice', reason: 'accrual', version: 2,
      postedAt: date, cancelledAt: null, reversedAt: null, createdAt: date, updatedAt: date,
      createKey: 'secret', createPayloadHash: 'hash', postKey: 'secret', postPayloadHash: 'hash', createdByUserId: 'user-1', journalEntryId: 'entry-1',
    };
    const result = documentDto(persistenceRow);
    expect(result).not.toHaveProperty('createKey');
    expect(result).not.toHaveProperty('postPayloadHash');
    expect(result).not.toHaveProperty('createdByUserId');
    expect(result).not.toHaveProperty('journalEntryId');
  });
});

describe('pharmacy general journal router denial chain', () => {
  beforeEach(() => vi.clearAllMocks());

  function context() {
    const db = {
      $transaction: vi.fn(),
      user: { findUnique: vi.fn(async () => ({ organizationRole: 'ADMIN', permissionOverrides: [] })) },
      pharmacyBranch: {
        findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
        findMany: vi.fn(async () => []),
      },
      pharmacyGeneralJournalDocument: { findMany: vi.fn(async () => []), findFirst: vi.fn(async (): Promise<{ id: string; createdAt: Date } | null> => null) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    return {
      db,
      session: { user: { id: 'user-1', organizationId: 'org-1', role: 'ADMIN', status: 'ACTIVE', organizationStatus: 'ACTIVE', mustChangePassword: false } },
      organization: { id: 'org-1' },
      entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-finance'], modules: [{ key: 'pharmacy-finance', enabled: true }] },
      requestMeta: { ip: null, userAgent: null }, support: null, audit: { detail: {} },
    };
  }

  it('denies missing financial capability before branch or document access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const ctx = context();
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.list({ branchId: 'branch-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ctx.db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expect(ctx.db.pharmacyGeneralJournalDocument.findMany).not.toHaveBeenCalled();
  });

  it('denies an out-of-scope branch before document access', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue(null);
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.list({ branchId: 'other-branch' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ctx.db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: 'other-branch', active: true }, select: { id: true },
    });
    expect(ctx.db.pharmacyGeneralJournalDocument.findMany).not.toHaveBeenCalled();
  });

  const draft = { branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
    amountMinor: 100, currency: 'PKR' as const, occurredAt: new Date('2026-10-25T12:00:00Z'),
    evidence: 'invoice', reason: 'accrual', idempotencyKey: 'create-1' };

  it.each(['createDraft', 'updateDraft'] as const)('maps duplicate references from %s to a conflict', async (method) => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    ctx.db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('secret index details', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['organizationId', 'reference'] },
    }));
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    const command = method === 'createDraft'
      ? caller.createDraft(draft)
      : caller.updateDraft({ branchId: draft.branchId, reference: draft.reference, purpose: draft.purpose,
        amountMinor: draft.amountMinor, currency: draft.currency, occurredAt: draft.occurredAt,
        evidence: draft.evidence, reason: draft.reason, documentId: 'doc-1', version: 1 });
    await expect(command).rejects.toMatchObject({ code: 'CONFLICT', message: 'A voucher with this reference or request key already exists.' });
  });

  it.each([
    [new FinancePostingError('NOT_FOUND'), 'NOT_FOUND'],
    [new FinancePostingError('INVALID_AMOUNT'), 'BAD_REQUEST'],
    [new FinancePostingError('UNBALANCED'), 'BAD_REQUEST'],
    [new PharmacyGeneralJournalError('REPLAY_MISMATCH'), 'CONFLICT'],
    [new Error('unexpected database failure'), 'INTERNAL_SERVER_ERROR'],
  ] as const)('maps expected posting errors without concealing unexpected failures: %s', async (error, code) => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    ctx.db.$transaction.mockRejectedValue(error);
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.post({ branchId: 'branch-1', documentId: 'doc-1', version: 1, idempotencyKey: 'post-1' }))
      .rejects.toMatchObject({ code });
  });

  it('reports a database closed-period rejection as the PERIOD_CLOSED domain reason', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    ctx.db.$transaction.mockRejectedValue(new Error('ERROR: PHARMACY_ACCOUNTING_PERIOD_CLOSED'));
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.post({ branchId: 'branch-1', documentId: 'doc-1', version: 1, idempotencyKey: 'post-1' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'PERIOD_CLOSED' });
  });

  it('pages history by a scoped keyset cursor and searches by reference', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    const createdAt = new Date('2026-10-01T00:00:00Z');
    ctx.db.pharmacyGeneralJournalDocument.findFirst.mockResolvedValue({ id: 'doc-50', createdAt });
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await caller.list({ branchId: 'branch-1', cursor: 'doc-50', reference: 'JV-7', limit: 26 });
    expect(ctx.db.pharmacyGeneralJournalDocument.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', branchId: 'branch-1', id: 'doc-50' }, select: { id: true, createdAt: true },
    });
    expect(ctx.db.pharmacyGeneralJournalDocument.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1', branchId: 'branch-1', reference: { contains: 'JV-7', mode: 'insensitive' },
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'doc-50' } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 26,
    });
  });

  it('rejects a history cursor outside the authorized branch', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.list({ branchId: 'branch-1', cursor: 'foreign-doc' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ctx.db.pharmacyGeneralJournalDocument.findMany).not.toHaveBeenCalled();
  });

  it('serves the shared general journal account catalogue', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-1' });
    const caller = pharmacyGeneralJournalRouter.createCaller(ctx as never);
    await expect(caller.accounts({ branchId: 'branch-1' })).resolves.toEqual(
      PHARMACY_GENERAL_JOURNAL_ACCOUNTS.map(({ code, name, normalSide }) => ({ code, name, side: normalSide })),
    );
  });
});
