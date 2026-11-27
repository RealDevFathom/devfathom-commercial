import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapOrganization: vi.fn(),
  createContext: vi.fn(),
  createJobRole: vi.fn(),
  setJobRoleCapabilities: vi.fn(),
  updateJobRole: vi.fn(),
  createStaffProfile: vi.fn(),
  updateStaffProfile: vi.fn(),
  issueCredential: vi.fn(),
  rotateCredential: vi.fn(),
  verifyCredential: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/commands', () => ({
  bootstrapDemoRestaurantOrganizationInTransaction: mocks.bootstrapOrganization,
  demoRestaurantApproverUserId: (seat: number) => `user_demo_restaurant_seat_${seat}_approver`,
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createContext }));
vi.mock('@/lib/restaurant/job-roles', () => ({
  createJobRole: mocks.createJobRole,
  setJobRoleCapabilities: mocks.setJobRoleCapabilities,
  updateJobRole: mocks.updateJobRole,
}));
vi.mock('@/lib/restaurant/staff', () => ({
  createStaffProfile: mocks.createStaffProfile,
  updateStaffProfile: mocks.updateStaffProfile,
}));
vi.mock('@/lib/restaurant/credential-lifecycle', () => ({
  issueOperatorCredential: mocks.issueCredential,
  rotateOperatorCredential: mocks.rotateCredential,
}));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: mocks.verifyCredential,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
import { demoSeatIdentity } from './seed-data';
import {
  createDemoRestaurantSeedContext,
  DEMO_RESTAURANT_JOB_ROLE_KEY,
  provisionDemoRestaurantSeatInTransaction,
} from './seed-bootstrap';

type State = {
  organization: Record<string, unknown> | null;
  manager: Record<string, unknown> | null;
  managerProfiles: Record<string, unknown>[];
  approverProfiles: Record<string, unknown>[];
  role: Record<string, unknown> | null;
  credential: Record<string, unknown> | null;
};

const identity = demoSeatIdentity(2);
const now = new Date('2026-09-04T12:00:00.000Z');

function defaultOrganization(overrides: Record<string, unknown> = {}) {
  return {
    id: identity.organizationId,
    slug: identity.slug,
    displayName: identity.displayName,
    legalName: identity.displayName,
    status: 'ONBOARDING',
    deploymentMode: 'SHARED',
    timezone: 'Asia/Karachi',
    locale: 'en-PK',
    currency: 'PKR',
    seatLimit: 1,
    isDemo: true,
    vertical: 'RESTAURANT',
    ...overrides,
  };
}

function defaultManager(overrides: Record<string, unknown> = {}) {
  return {
    id: identity.managerUserId,
    organizationId: identity.organizationId,
    name: 'Demo Restaurant Manager',
    email: identity.managerEmail,
    role: 'ADMIN',
    department: 'admin',
    title: 'Organization administrator',
    avatar: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

function createDb(state: State): ScopedDb {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) =>
      sql.includes("current_setting('app.current_organization_id'")
        ? [{ organizationId: 'outer_org', isPlatformAdmin: 'true' }]
        : [{ set_config: '' }]
    ),
    organization: { findUnique: vi.fn(async () => state.organization) },
    user: { findUnique: vi.fn(async () => state.manager) },
    restaurantStaffProfile: {
      findMany: vi.fn(async ({ where }: { where: { OR?: unknown } }) =>
        where.OR ? state.approverProfiles : state.managerProfiles
      ),
    },
    restaurantJobRole: { findUnique: vi.fn(async () => state.role) },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => state.credential),
      updateMany: vi.fn(async ({ data }) => Object.assign(state.credential ?? {}, data)),
    },
  } as unknown as ScopedDb;
}

function emptyState(): State {
  return {
    organization: defaultOrganization(),
    manager: defaultManager(),
    managerProfiles: [],
    approverProfiles: [],
    role: null,
    credential: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'focused-demo-bootstrap-test-secret');
  mocks.bootstrapOrganization.mockResolvedValue(undefined);
  mocks.createStaffProfile.mockImplementation(
    async (_db: unknown, input: Record<string, unknown>) => ({
      id:
        typeof input.userId === 'string' && input.userId.endsWith('_approver')
          ? 'staff_approver'
          : 'staff_manager',
      userId: input.userId ?? null,
      email: input.email ?? null,
      status: input.status ?? 'ACTIVE',
    })
  );
  mocks.createJobRole.mockResolvedValue({ id: 'role_demo', active: true });
  mocks.verifyCredential.mockResolvedValue(true);
  mocks.createContext.mockImplementation(async (options: unknown) => options);
});

afterEach(() => vi.unstubAllEnvs());

describe('provisionDemoRestaurantSeatInTransaction', () => {
  it('refuses a wrong-seat stable identity before persistence', async () => {
    const db = createDb(emptyState());

    await expect(
      provisionDemoRestaurantSeatInTransaction(
        db,
        { ...identity, managerUserId: demoSeatIdentity(3).managerUserId },
        now
      )
    ).rejects.toThrow('non-canonical managerUserId');
    expect(mocks.bootstrapOrganization).not.toHaveBeenCalled();
  });

  it('creates linked identities, enumerated authority, and an approver PIN via services', async () => {
    const db = createDb(emptyState());

    await provisionDemoRestaurantSeatInTransaction(db, identity, now);

    expect(mocks.bootstrapOrganization).toHaveBeenCalledWith(db, identity, now);
    expect(mocks.createStaffProfile).toHaveBeenCalledTimes(2);
    expect(mocks.createStaffProfile).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ userId: identity.managerUserId, primaryBranchId: null })
    );
    expect(mocks.createStaffProfile).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        email: 'approver.seat2@demo.devfathom.invalid',
        userId: 'user_demo_restaurant_seat_2_approver',
        primaryBranchId: null,
      })
    );
    expect(mocks.createJobRole).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        key: DEMO_RESTAURANT_JOB_ROLE_KEY,
        capabilities: RESTAURANT_CAPABILITIES,
      })
    );
    expect(RESTAURANT_CAPABILITIES).not.toContain('*');
    expect(mocks.issueCredential).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ staffProfileId: 'staff_approver', type: 'PIN' })
    );
    expect(JSON.stringify(mocks.issueCredential.mock.calls)).not.toContain(
      'focused-demo-bootstrap-test-secret'
    );
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(db.$queryRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining("set_config('app.current_organization_id', $1, true)"),
      'outer_org',
      'true'
    );
  });

  it.each(['issue', 'rotate', 'matching'])(
    'leaves only the synthetic approver PIN ready after %s',
    async (mode) => {
      const state = emptyState();
      const credential = {
        id: 'synthetic-pin',
        credentialHash: 'synthetic',
        approvalPinMustChange: true,
      };
      if (mode === 'issue') {
        mocks.issueCredential.mockImplementationOnce(async () => (state.credential = credential));
      } else {
        state.credential = credential;
        mocks.verifyCredential.mockResolvedValueOnce(mode === 'matching');
      }
      const db = createDb(state);
      await provisionDemoRestaurantSeatInTransaction(db, identity, now);
      expect(db.restaurantOperatorCredential.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { staffProfileId: 'staff_approver', type: 'PIN', deviceId: null, revokedAt: null },
        data: { approvalPinMustChange: false },
      });
      expect(state.credential?.approvalPinMustChange).toBe(false);
      expect(mocks.rotateCredential).toHaveBeenCalledTimes(mode === 'rotate' ? 1 : 0);
    }
  );

  it('preserves generated staff, role, and credential IDs on rerun', async () => {
    const state = emptyState();
    state.managerProfiles = [
      { id: 'staff_manager_existing', email: identity.managerEmail, status: 'ACTIVE' },
    ];
    state.approverProfiles = [
      {
        id: 'staff_approver_existing',
        userId: 'user_demo_restaurant_seat_2_approver',
        email: 'approver.seat2@demo.devfathom.invalid',
        status: 'ACTIVE',
      },
    ];
    state.role = { id: 'role_existing', active: true };
    state.credential = { id: 'credential_existing', credentialHash: 'stored-hash' };
    const db = createDb(state);

    await provisionDemoRestaurantSeatInTransaction(db, identity, now);

    expect(mocks.createStaffProfile).not.toHaveBeenCalled();
    expect(mocks.updateStaffProfile).not.toHaveBeenCalled();
    expect(mocks.createJobRole).not.toHaveBeenCalled();
    expect(mocks.setJobRoleCapabilities).toHaveBeenCalledWith(
      db,
      'role_existing',
      RESTAURANT_CAPABILITIES
    );
    expect(mocks.verifyCredential).toHaveBeenCalledWith('PIN', expect.any(String), 'stored-hash');
    expect(mocks.rotateCredential).not.toHaveBeenCalled();
    expect(mocks.issueCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['staff-only', null, 'approver.seat2@demo.devfathom.invalid'],
    ['cross-seat', 'user_demo_restaurant_seat_3_approver', 'approver.seat2@demo.devfathom.invalid'],
    ['wrong email', 'user_demo_restaurant_seat_2_approver', 'wrong@demo.devfathom.invalid'],
  ])('refuses a %s approver staff identity', async (_case, userId, email) => {
    const state = emptyState();
    state.managerProfiles = [
      { id: 'staff_manager_existing', email: identity.managerEmail, status: 'ACTIVE' },
    ];
    state.approverProfiles = [{ id: 'staff_bad', userId, email, status: 'ACTIVE' }];

    await expect(
      provisionDemoRestaurantSeatInTransaction(createDb(state), identity, now)
    ).rejects.toThrow('non-canonical linked user');
    expect(mocks.issueCredential).not.toHaveBeenCalled();
  });
});

describe('createDemoRestaurantSeedContext', () => {
  it('builds the real context input from the canonical demo organization and manager', async () => {
    const state = emptyState();
    state.managerProfiles = [{ id: 'staff_manager_existing' }];
    const db = createDb(state);

    const context = await createDemoRestaurantSeedContext(db, identity.organizationId);

    expect(context).toMatchObject({ db, organization: { id: identity.organizationId } });
    expect(mocks.createContext).toHaveBeenCalledWith({
      db,
      auditDb: db,
      organization: expect.objectContaining({
        id: identity.organizationId,
        isDemo: true,
        status: 'ONBOARDING',
      }),
      session: expect.objectContaining({
        user: expect.objectContaining({
          id: identity.managerUserId,
          organizationId: identity.organizationId,
          status: 'ACTIVE',
        }),
      }),
    });
    expect(mocks.createContext.mock.calls[0]?.[0]).not.toHaveProperty('req');
  });

  it('refuses an unflagged organization', async () => {
    const state = emptyState();
    state.organization = defaultOrganization({ isDemo: false });

    await expect(
      createDemoRestaurantSeedContext(createDb(state), identity.organizationId)
    ).rejects.toThrow('demo restaurant organization not found');
    expect(mocks.createContext).not.toHaveBeenCalled();
  });

  it.each([[null], [defaultManager({ status: 'INACTIVE' })]])(
    'refuses a missing or disabled manager',
    async (manager) => {
      const state = emptyState();
      state.manager = manager;

      await expect(
        createDemoRestaurantSeedContext(createDb(state), identity.organizationId)
      ).rejects.toThrow('demo restaurant manager not found');
      expect(mocks.createContext).not.toHaveBeenCalled();
    }
  );
});
