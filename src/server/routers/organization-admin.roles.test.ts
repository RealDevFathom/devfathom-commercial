/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates model only the operations exercised by these boundary tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ annotateAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const role = { id: 'role_a', organizationId: 'org_a', isSystem: false, name: 'Old role' };
let permissions: Array<{ capability: string; effect: string }>;
const db: any = {
  $queryRaw: vi.fn(),
  organizationRole: {
    findFirst: vi.fn(),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...role, ...data })),
    create: vi.fn(),
  },
  organizationRolePermission: {
    deleteMany: vi.fn(async () => {
      permissions = [];
    }),
    createMany: vi.fn(async ({ data }: { data: typeof permissions }) => {
      permissions = data;
    }),
  },
  $transaction: vi.fn(async (run: (tx: typeof db) => Promise<unknown>) => {
    const before = [...permissions];
    try {
      return await run(db);
    } catch (error) {
      permissions = before;
      throw error;
    }
  }),
};

function caller(organizationId = 'org_a') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const input = {
  id: 'role_a',
  key: 'finance-team',
  name: 'Finance team',
  description: null,
  permissions: [{ capability: 'finance:read', effect: 'ALLOW' as const }],
};

describe('organization role replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions = [{ capability: 'existing:permission', effect: 'ALLOW' }];
    db.organizationRole.findFirst.mockResolvedValue(role);
    db.organizationRolePermission.createMany.mockImplementation(
      async ({ data }: { data: typeof permissions }) => {
        permissions = data;
      }
    );
  });

  it('rejects duplicate capabilities after trimming before starting a mutation', async () => {
    await expect(
      caller().upsertRole({
        ...input,
        permissions: [
          { capability: 'finance:read', effect: 'ALLOW' },
          { capability: ' finance:read ', effect: 'DENY' },
        ],
      })
    ).rejects.toThrow('Each capability may only appear once.');

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(permissions).toEqual([{ capability: 'existing:permission', effect: 'ALLOW' }]);
  });

  it('rolls back the delete when inserting replacement permissions fails', async () => {
    db.organizationRolePermission.createMany.mockRejectedValueOnce(new Error('insert failed'));

    await expect(caller().upsertRole(input)).rejects.toThrow('insert failed');

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(permissions).toEqual([{ capability: 'existing:permission', effect: 'ALLOW' }]);
  });

  it('locks the tenant and denies editing a role outside it', async () => {
    db.organizationRole.findFirst.mockResolvedValueOnce(null);

    await expect(caller('org_b').upsertRole(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.organizationRole.findFirst).toHaveBeenCalledWith({
      where: { id: 'role_a', organizationId: 'org_b' },
    });
    expect(db.organizationRole.update).not.toHaveBeenCalled();
    expect(db.organizationRolePermission.deleteMany).not.toHaveBeenCalled();
  });
});
