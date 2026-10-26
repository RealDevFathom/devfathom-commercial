import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), record: vi.fn() }));
vi.mock('server-only', () => ({}));
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
      user: { findUnique: vi.fn(async () => ({ organizationRole: 'ADMIN', permissionOverrides: [] })) },
      pharmacyBranch: {
        findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
        findMany: vi.fn(async () => []),
      },
      pharmacyGeneralJournalDocument: { findMany: vi.fn() },
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
});
