/**
 * M2-L2 router — capability gating, credential-secret audit suppression (C4),
 * and domain-error → tRPC status mapping. Runs the REAL router and the REAL L1
 * hashing/lifecycle core against a hand-rolled in-memory db (no PostgreSQL); the
 * ABAC decision, entitlement check and audit writer are mocked so the test
 * exercises this lane's logic, not the platform middleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  // db delegate methods
  staffFindMany: vi.fn(),
  staffFindFirst: vi.fn(),
  staffFindUnique: vi.fn(),
  staffCreate: vi.fn(),
  staffUpdate: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  credFindMany: vi.fn(),
  credFindFirst: vi.fn(),
  credFindUnique: vi.fn(),
  credCreate: vi.fn(),
  credUpdate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { restaurantStaffRouter } from './restaurant-staff';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { TRPCContext } from '../trpc';

const db = {
  restaurantStaffProfile: {
    findMany: mocks.staffFindMany,
    findFirst: mocks.staffFindFirst,
    findUnique: mocks.staffFindUnique,
    create: mocks.staffCreate,
    update: mocks.staffUpdate,
  },
  restaurantBranch: { findMany: mocks.branchFindMany, findUnique: mocks.branchFindUnique },
  user: { findFirst: mocks.userFindFirst },
  restaurantOperatorCredential: {
    findMany: mocks.credFindMany,
    findFirst: mocks.credFindFirst,
    findUnique: mocks.credFindUnique,
    create: mocks.credCreate,
    update: mocks.credUpdate,
  },
};

function caller() {
  return restaurantStaffRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.userFindFirst.mockResolvedValue({ id: 'user_1' });
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    ...data,
  }));
  mocks.staffUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      displayName: 'Existing',
      ...data,
    })
  );
  mocks.credFindFirst.mockResolvedValue(null);
  mocks.credCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'cred_new',
    createdAt: new Date('2026-08-18T12:00:00Z'),
    ...data,
  }));
  mocks.credFindUnique.mockResolvedValue({ id: 'cred_1', type: 'PIN', revokedAt: null });
  mocks.credUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      type: 'PIN',
      updatedAt: new Date('2026-08-18T12:30:00Z'),
      ...data,
    })
  );
});

describe('capability gating', () => {
  it('rejects every procedure when the ABAC decision denies staff:manage', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().create({ displayName: 'Blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });
});

describe('staff CRUD', () => {
  it('creates a staff profile and audits it', async () => {
    const result = await caller().create({ displayName: 'Dana', email: 'Dana@R.com' });
    expect(result).toMatchObject({ id: 'staff_new', email: 'dana@r.com' });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantStaffProfile', targetId: 'staff_new' })
    );
  });

  it('maps a duplicate email to CONFLICT', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_existing' });
    await expect(
      caller().create({ displayName: 'Dupe', email: 'taken@r.com' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not reveal whether an unauthorized primary branch exists', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(
      caller().create({ displayName: 'x', primaryBranchId: 'branch_gone' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not reveal whether an unauthorized profile exists', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(caller().update({ id: 'gone', displayName: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('sets a profile status', async () => {
    const result = await caller().setStatus({ id: 'staff_1', status: 'SUSPENDED' });
    expect(result).toMatchObject({ status: 'SUSPENDED' });
  });
});

describe('credential mutations suppress the plaintext secret (C4)', () => {
  it('issues a credential, skips audit input, and never returns a hash', async () => {
    const result = await caller().issueCredential({
      staffProfileId: 'staff_1',
      type: 'PIN',
      secret: '4821',
    });

    // The very first audit annotation sets skipInput, protecting the failure path too.
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    // The stored hash is a real, verifiable bcrypt hash — never the plaintext.
    const stored = mocks.credCreate.mock.calls[0][0].data.credentialHash;
    expect(stored).not.toBe('4821');
    expect(await verifyOperatorCredential('PIN', '4821', stored)).toBe(true);
    // The response exposes no secret and no hash.
    expect(result).not.toHaveProperty('credentialHash');
    expect(result).not.toHaveProperty('secret');
    expect(result).toMatchObject({ id: 'cred_new', type: 'PIN' });
  });

  it('maps a weak PIN (L1 policy floor) to BAD_REQUEST and still skips input', async () => {
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '12' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });

  it('maps issuing over an existing active credential to CONFLICT', async () => {
    mocks.credFindFirst.mockResolvedValue({ id: 'cred_existing' });
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rotates a credential with skipInput and no hash in the response', async () => {
    const result = await caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    const stored = mocks.credUpdate.mock.calls[0][0].data.credentialHash;
    expect(await verifyOperatorCredential('PIN', '99887', stored)).toBe(true);
    expect(result).not.toHaveProperty('credentialHash');
  });

  it('maps rotating a revoked credential to CONFLICT', async () => {
    mocks.credFindUnique.mockResolvedValue({
      id: 'cred_1',
      type: 'PIN',
      revokedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await expect(
      caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('revokes a credential immediately with skipInput', async () => {
    const result = await caller().revokeCredential({ credentialId: 'cred_1' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    expect(mocks.credUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
    expect(result.revokedAt).toBeInstanceOf(Date);
  });
});

describe('credential listing', () => {
  it('never selects the credential hash', async () => {
    mocks.credFindMany.mockResolvedValue([]);
    await caller().listCredentials({ staffProfileId: 'staff_1' });
    const { select, where } = mocks.credFindMany.mock.calls[0][0];
    expect(select.credentialHash).toBeUndefined();
    expect('credentialHash' in select).toBe(false);
    // Active-only by default.
    expect(where).toMatchObject({ revokedAt: null });
  });

  it('includes revoked credentials only when asked', async () => {
    mocks.credFindMany.mockResolvedValue([]);
    await caller().listCredentials({ staffProfileId: 'staff_1', includeRevoked: true });
    const { where } = mocks.credFindMany.mock.calls[0][0];
    expect(where.revokedAt).toBeUndefined();
  });
});
