// @vitest-environment node
/**
 * DEV-831 (security scan F06): an enrolled offline counter must not lend its
 * branch to the signed-in actor. Establishment, snapshots and replay take the
 * online counter's live grant and branch-assignment gate on every request, so
 * revoking either stops an active terminal; manager grant operations keep
 * their own `admin:access` gate.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const ORG = 'org_dev831';
const BRANCH = 'branch_dev831';
const DEVICE = 'device_dev831';
const ACTOR = 'user_dev831';
const SECRET = `pcd_${'a'.repeat(43)}`;

const state = vi.hoisted(() => ({
  role: 'EMPLOYEE' as string,
  grants: new Set<string>(),
  rules: [] as { capability: string; effect: string }[],
  memberStatus: 'ACTIVE' as string,
  assignedBranches: new Set<string>(),
}));

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  issueOfflineSnapshot: vi.fn(),
  reserveReceiptNumberBlock: vi.fn(),
  recordOfflineCommand: vi.fn(),
  createSale: vi.fn(),
  assignmentLookup: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => ({
    organization: { id: ORG },
    session: { user: { id: ACTOR, role: state.role, organizationId: ORG } },
    support: null,
  })),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn(() => true),
}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string }) => user,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/pharmacy/offline-devices', () => ({
  enrollPharmacyCounter: vi.fn(),
  rotatePharmacyCounterSecret: vi.fn(),
  revokePharmacyCounter: vi.fn(),
  resolvePharmacyCounterBySecret: vi.fn(async () => ({
    id: DEVICE,
    branchId: BRANCH,
    organizationId: ORG,
    status: 'ACTIVE',
    revokedAt: null,
  })),
}));
vi.mock('@/lib/pharmacy/offline-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-snapshots')>()),
  issueOfflineSnapshot: mocks.issueOfflineSnapshot,
}));
vi.mock('@/lib/pharmacy/offline-receipt-leases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-receipt-leases')>()),
  reserveReceiptNumberBlock: mocks.reserveReceiptNumberBlock,
}));
vi.mock('@/lib/pharmacy/offline-command-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-command-log')>()),
  recordOfflineCommand: mocks.recordOfflineCommand,
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  createSale: mocks.createSale,
}));
vi.mock('@/lib/pharmacy/manual-payment-settings', () => ({
  readManualPaymentSettings: vi.fn(async () => ({ settings: {}, revision: 0 })),
}));

const fakeDb = {
  $queryRaw: vi.fn(async () => []),
  pharmacyBranch: { findFirst: vi.fn(async () => ({ id: BRANCH })) },
  user: {
    findUnique: vi.fn(async () => ({
      status: state.memberStatus,
      organizationId: ORG,
      organizationRole: { permissions: state.rules },
      permissionOverrides: [],
    })),
  },
  pharmacyBranchAssignment: { findFirst: mocks.assignmentLookup },
  pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
  medicine: { findMany: vi.fn(async () => []) },
  pharmacyDeviceLotQuota: { findMany: vi.fn(async () => []) },
  pharmacyTaxProfileVersion: { findMany: vi.fn(async () => []) },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org: string, work: (db: unknown) => Promise<unknown>) =>
    work(fakeDb)
  ),
}));

type Router = typeof import('./pharmacy-offline');
let router: Router;
beforeAll(async () => {
  router = await import('./pharmacy-offline');
});

function grantCashier() {
  state.role = 'EMPLOYEE';
  state.grants = new Set(['pharmacy:orders', 'pharmacy:counter']);
  state.rules = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];
  state.memberStatus = 'ACTIVE';
  state.assignedBranches = new Set([BRANCH]);
}

beforeEach(() => {
  grantCashier();
  vi.clearAllMocks();
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    state.grants.has(action)
  );
  mocks.assignmentLookup.mockImplementation(
    async ({ where }: { where: { branchId: string; userId: string; active: boolean } }) =>
      where.userId === ACTOR && where.active && state.assignedBranches.has(where.branchId)
        ? { branchId: where.branchId }
        : null
  );
  mocks.issueOfflineSnapshot.mockImplementation(async (_db, _scope, input: { kind: string }) => ({
    kind: input.kind,
  }));
  mocks.reserveReceiptNumberBlock.mockResolvedValue({ id: 'lease_1', blockStart: 1 });
  mocks.recordOfflineCommand.mockRejectedValue(new Error('REACHED_COMMAND_LOG'));
  mocks.createSale.mockRejectedValue(new Error('REACHED_SALE'));
});

function call(
  operation: Parameters<Router['pharmacyCounterRoute']>[0],
  token = '',
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return router.pharmacyCounterRoute(operation)(
    new Request(`https://tenant.test/api/pharmacy/counter/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'x-terminal-session': token,
        'idempotency-key': 'idem_1',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

async function establish() {
  const response = await call('establish');
  expect(response.status).toBe(201);
  return (await response.json()).sessionToken as string;
}

async function expectAllDenied(token: string, error: string) {
  for (const operation of ['establish', 'snapshot', 'replay'] as const) {
    const response = await call(operation, token);
    expect(response.status, operation).toBe(403);
    expect(await response.json(), operation).toEqual({ error });
  }
  // No snapshot, command-log entry or sale was produced by a denied request.
  expect(mocks.issueOfflineSnapshot).not.toHaveBeenCalled();
  expect(mocks.recordOfflineCommand).not.toHaveBeenCalled();
  expect(mocks.createSale).not.toHaveBeenCalled();
}

describe('DEV-831 offline counter operator authorization', () => {
  it('lets an assigned cashier with the counter grant establish, snapshot and reach replay', async () => {
    const token = await establish();
    const snapshot = await call('snapshot', token);
    expect(snapshot.status).toBe(200);
    expect(mocks.issueOfflineSnapshot).toHaveBeenCalledTimes(5);
    // Past the gate, replay validates the signed command body.
    const replay = await call('replay', token, {});
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.assignmentLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          userId: ACTOR,
          branchId: BRANCH,
          active: true,
        }),
      })
    );
  });

  it('denies all three endpoints once the branch assignment is revoked on an active terminal', async () => {
    const token = await establish();
    state.assignedBranches.clear();
    await expectAllDenied(token, 'branch_forbidden');
  });

  it('denies an actor assigned only to another branch', async () => {
    state.assignedBranches = new Set(['branch_other']);
    await expectAllDenied('', 'branch_forbidden');
  });

  it('denies all three endpoints once the counter grant is revoked, even with orders permission', async () => {
    const token = await establish();
    state.grants.delete('pharmacy:counter');
    await expectAllDenied(token, 'forbidden');
  });

  it('denies an explicit counter-family DENY that the central check did not see', async () => {
    const token = await establish();
    state.rules = [
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy.counter', effect: 'DENY' },
    ];
    await expectAllDenied(token, 'forbidden');
  });

  it('denies an inactive member', async () => {
    const token = await establish();
    state.memberStatus = 'SUSPENDED';
    await expectAllDenied(token, 'forbidden');
  });

  it('keeps the organization administrator exception without a branch assignment', async () => {
    state.role = 'ADMIN';
    state.assignedBranches.clear();
    const token = await establish();
    expect((await call('snapshot', token)).status).toBe(200);
  });

  it('keeps manager-only grant operations on admin:access', async () => {
    const token = await establish();
    state.grants = new Set(['pharmacy:orders', 'pharmacy:counter']);
    expect((await call('lease', token, { size: 1 })).status).toBe(403);
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
    state.grants.add('admin:access');
    expect((await call('lease', token, { size: 1 })).status).toBe(200);
    expect(mocks.reserveReceiptNumberBlock).toHaveBeenCalledTimes(1);
  });
});
