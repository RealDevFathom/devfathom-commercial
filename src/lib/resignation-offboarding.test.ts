import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withPlatformDb: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
}));

import { processDueResignationOffboarding } from './resignation-offboarding';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withPlatformDb.mockImplementation(async (run: (db: unknown) => Promise<unknown>) =>
    run({ $queryRaw: mocks.query })
  );
  mocks.query.mockResolvedValue([]);
});

describe('processDueResignationOffboarding', () => {
  it('atomically deactivates due approved resignations and revokes their sessions', async () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    mocks.query.mockResolvedValue([
      { id: 'user-a', organizationId: 'org-a' },
      { id: 'user-b', organizationId: 'org-b' },
    ]);

    await expect(processDueResignationOffboarding(now)).resolves.toEqual({ offboarded: 2 });

    expect(mocks.withPlatformDb).toHaveBeenCalledOnce();
    const [query] = mocks.query.mock.calls[0] as [
      { strings: readonly string[]; values: unknown[] },
    ];
    const sql = query.strings.join('$1');
    expect(query.values).toEqual([now]);
    expect(sql).toContain(`r."status" = 'APPROVED'`);
    expect(sql).toContain('r."lastWorkingDay" IS NOT NULL');
    expect(sql).toContain('r."lastWorkingDay" <= $1');
    expect(sql).toContain(`u."status" <> 'INACTIVE'`);
    expect(sql).toContain(`"tokenVersion" = u."tokenVersion" + 1`);
  });

  it('requires the resignation and user to belong to the same organization', async () => {
    await processDueResignationOffboarding();

    const [query] = mocks.query.mock.calls[0] as [{ strings: readonly string[] }];
    const sql = query.strings.join('$1');
    expect(sql).toContain('r."organizationId" = u."organizationId"');
  });

  it('reports no offboarding when no due resignation matches', async () => {
    await expect(processDueResignationOffboarding()).resolves.toEqual({ offboarded: 0 });
  });
});
