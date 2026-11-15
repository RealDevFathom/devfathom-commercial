import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), hasModule: vi.fn(), recordAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('./audit', () => ({ recordAudit: mocks.recordAudit }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  authorizeGeneralJournal,
  recordGeneralJournalExecuteAudit,
} from './pharmacy-general-journal-security';

const branchFindFirst = vi.fn();

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    db: { pharmacyBranch: { findFirst: branchFindFirst } },
    entitlements: { organizationId: 'org_1', enabledModules: ['pharmacy-finance'], modules: [] },
    organization: { id: 'org_1' },
    requestMeta: { ip: '10.0.0.1', userAgent: 'test' },
    session: {
      expires: 'later',
      user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe('authorizeGeneralJournal', () => {
  it('returns the org+branch+actor scope after every check passes', async () => {
    await expect(authorizeGeneralJournal(ctx(), 'branch_1')).resolves.toEqual({
      organizationId: 'org_1',
      branchId: 'branch_1',
      actorId: 'owner_1',
    });
    expect(mocks.hasModule).toHaveBeenCalledWith(expect.anything(), 'pharmacy-finance');
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner_1' }),
      'finance:read',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(branchFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'branch_1', active: true },
      select: { id: true },
    });
  });

  it('refuses an anonymous caller', async () => {
    await expect(
      authorizeGeneralJournal(ctx({ session: { user: {} } }), 'branch_1')
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each([
    [
      'a non-owner role',
      () =>
        ctx({
          session: {
            user: { id: 'u', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
          },
        }),
    ],
    ['a mismatched organization', () => ctx({ organization: { id: 'org_2' } })],
    [
      'a session from another organization',
      () =>
        ctx({
          session: { user: { id: 'u', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_2' } },
        }),
    ],
    ['a missing organization', () => ctx({ organization: null })],
  ])('refuses %s before reading any branch', async (_label, build) => {
    await expect(authorizeGeneralJournal(build(), 'branch_1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(branchFindFirst).not.toHaveBeenCalled();
  });

  it('refuses without the Pharmacy Finance licence', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(authorizeGeneralJournal(ctx(), 'branch_1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(branchFindFirst).not.toHaveBeenCalled();
  });

  it('refuses when the canonical finance permission is denied', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(authorizeGeneralJournal(ctx(), 'branch_1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(branchFindFirst).not.toHaveBeenCalled();
  });

  it('refuses an inactive or foreign branch', async () => {
    branchFindFirst.mockResolvedValue(null);
    await expect(authorizeGeneralJournal(ctx(), 'branch_9')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('recordGeneralJournalExecuteAudit', () => {
  const tx = { tx: true } as unknown as ScopedDb;
  const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };
  const audit = {
    action: 'pharmacyGeneralJournal.post' as const,
    voucher: { id: 'jv_1', reference: 'JV-1', version: 2, status: 'POSTED' },
    entryId: 'entry_1',
    commandKey: 'post-key-0001',
    replayed: false,
  };

  it('writes an EXECUTE success row through the business transaction', async () => {
    await recordGeneralJournalExecuteAudit(tx, ctx(), scope, audit);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        actorId: 'owner_1',
        operation: 'EXECUTE',
        outcome: 'SUCCESS',
        action: 'pharmacyGeneralJournal.post',
        targetId: 'jv_1',
        result: expect.objectContaining({ entryId: 'entry_1', replayed: false }),
        metadata: { branchId: 'branch_1', commandKey: 'post-key-0001' },
      }),
      tx
    );
  });

  it('propagates an audit failure so the posting rolls back', async () => {
    mocks.recordAudit.mockRejectedValue(new Error('audit down'));
    await expect(recordGeneralJournalExecuteAudit(tx, ctx(), scope, audit)).rejects.toThrow(
      'audit down'
    );
  });
});
