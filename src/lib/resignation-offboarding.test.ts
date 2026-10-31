import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withPlatformDb: vi.fn(),
  findMany: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
}));

import { processDueResignationOffboarding } from './resignation-offboarding';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withPlatformDb.mockImplementation(async (run: (db: unknown) => Promise<unknown>) =>
    run({
      $queryRaw: mocks.query,
      resignation: { findMany: mocks.findMany },
      auditLog: { create: mocks.audit },
    })
  );
  mocks.findMany.mockResolvedValue([{ organizationId: 'org-a' }]);
  mocks.query.mockResolvedValue([]);
  mocks.audit.mockResolvedValue({});
});

describe('processDueResignationOffboarding', () => {
  it('atomically deactivates due approved resignations and revokes their sessions', async () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    mocks.query.mockResolvedValue([
      {
        id: 'user-a',
        organizationId: 'org-a',
        previousStatus: 'ACTIVE',
        previousTokenVersion: 4,
        tokenVersion: 5,
        resignationIds: ['res-a'],
      },
      {
        id: 'user-b',
        organizationId: 'org-a',
        previousStatus: 'ON_LEAVE',
        previousTokenVersion: 6,
        tokenVersion: 7,
        resignationIds: ['res-b'],
      },
    ]);

    await expect(processDueResignationOffboarding(now)).resolves.toEqual({ offboarded: 2 });

    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(2);
    const [query] = mocks.query.mock.calls[1] as [
      { strings: readonly string[]; values: unknown[] },
    ];
    const sql = query.strings.join('$1');
    expect(query.values).toEqual(['org-a', now, now, now]);
    expect(sql).toContain(`r."status" = 'APPROVED'`);
    expect(sql).toContain('r."lastWorkingDay" IS NOT NULL');
    expect(sql).toContain('r."lastWorkingDay" <= $1');
    expect(sql).toContain('r."offboardedAt" IS NULL');
    expect(sql).toContain('SET "offboardedAt" = NOW()');
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        targetId: 'user-a',
        metadata: { resignationIds: ['res-a'] },
        changes: {
          status: { before: 'ACTIVE', after: 'INACTIVE' },
          tokenVersion: { before: 4, after: 5 },
        },
      }),
    });
    expect(sql).toContain('FROM due_resignations AS r');
    expect(sql).toContain(`other."role" = 'ADMIN' AND other."status" = 'ACTIVE'`);
    expect(sql).toContain('other."id" < u."id" OR NOT EXISTS');
    expect(mocks.query.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(sql).toContain(`u."status" <> 'INACTIVE'`);
    expect(sql).toContain(`"tokenVersion" = u."tokenVersion" + 1`);
  });

  it('requires the resignation and user to belong to the same organization', async () => {
    await processDueResignationOffboarding();

    const [query] = mocks.query.mock.calls[1] as [{ strings: readonly string[] }];
    const sql = query.strings.join('$1');
    expect(sql).toContain('r."organizationId" = u."organizationId"');
  });

  it('reports no offboarding when no due resignation matches', async () => {
    await expect(processDueResignationOffboarding()).resolves.toEqual({ offboarded: 0 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
