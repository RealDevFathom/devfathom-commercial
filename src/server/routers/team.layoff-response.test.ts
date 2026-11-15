/**
 * DEV-828 F02: offboarding a member must not hand the operator that member's
 * authentication secrets. `layOffMember` selects only the notice/audit fields
 * inside the transaction and answers with a small success payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userUpdate: vi.fn(),
  queryRaw: vi.fn(),
  sendEmail: vi.fn(),
  annotateAudit: vi.fn(),
  can: vi.fn(async () => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://example.test'),
  sendEmail: mocks.sendEmail,
  templates: {
    accountDeactivated: vi.fn(() => ({ subject: 'subject', html: 'html', text: 'text' })),
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { teamRouter } from './team';

type TeamDb = {
  user: {
    findUnique: typeof mocks.userFindUnique;
    count: typeof mocks.userCount;
    update: typeof mocks.userUpdate;
  };
  $queryRaw: typeof mocks.queryRaw;
  $transaction: (run: (tx: TeamDb) => Promise<unknown>) => Promise<unknown>;
};

const db: TeamDb = {
  user: {
    findUnique: mocks.userFindUnique,
    count: mocks.userCount,
    update: mocks.userUpdate,
  },
  $queryRaw: mocks.queryRaw,
  $transaction: (run) => run(db),
};

function caller(role: 'ADMIN' | 'HR' = 'HR') {
  return teamRouter.createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats: 2, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'hr_actor',
        name: 'HR Lead',
        organizationId: 'org_a',
        role,
        department: 'HR',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const SECRET_FIELDS = [
  'password',
  'twoFactorSecret',
  'twoFactorEnabledAt',
  'tokenVersion',
  'mustChangePassword',
];

/** The full row an unrestricted update would hand back for an MFA-enabled member. */
const mfaMemberRow = {
  id: 'member_target',
  name: 'Pharmacy Cashier',
  email: 'cashier@example.test',
  role: 'EMPLOYEE',
  status: 'INACTIVE',
  password: '$2a$12$abcdefghijklmnopqrstuuJ0Ow0bS1TzE3s1Ga3H9F6K1Y0a1b2c3',
  twoFactorSecret: 'JBSWY3DPEHPK3PXP',
  twoFactorEnabledAt: new Date('2026-11-01T00:00:00Z'),
  tokenVersion: 4,
  mustChangePassword: false,
};

describe('team.layOffMember response (DEV-828 F02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ id: 'org_a' }]);
    mocks.userFindUnique.mockResolvedValue({
      name: 'Pharmacy Cashier',
      email: 'cashier@example.test',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });
    mocks.userCount.mockResolvedValue(2);
    // The mock ignores `select`, so this is what leaks if the router passes the row through.
    mocks.userUpdate.mockResolvedValue(mfaMemberRow);
    mocks.can.mockResolvedValue(true);
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it('offboards an MFA-enabled member without returning their credentials', async () => {
    const result = await caller().layOffMember({
      id: 'member_target',
      reason: 'Position eliminated',
    });

    expect(result).toEqual({ success: true, id: 'member_target', status: 'INACTIVE' });
    const serialized = JSON.stringify(result);
    for (const field of SECRET_FIELDS) expect(serialized).not.toContain(`"${field}"`);
    expect(serialized).not.toContain(mfaMemberRow.twoFactorSecret);
    expect(serialized).not.toContain(mfaMemberRow.password);
    expect(serialized).not.toContain(mfaMemberRow.email);
  });

  it('selects only the notice and audit fields inside the transaction', async () => {
    await caller().layOffMember({ id: 'member_target', reason: 'Position eliminated' });

    expect(mocks.userUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'member_target' },
      data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
      select: { id: true, name: true, status: true },
    });
    // The offboarding workflow itself is unchanged: audit + notice email.
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'member_target',
        targetLabel: 'Pharmacy Cashier',
        metadata: { laidOff: true, reason: 'Position eliminated' },
      })
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: { email: 'cashier@example.test', name: 'Pharmacy Cashier' } })
    );
  });

  it('refuses an operator without authority over the target and changes nothing', async () => {
    mocks.can.mockResolvedValue(false);

    await expect(
      caller().layOffMember({ id: 'member_target', reason: 'Position eliminated' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});
