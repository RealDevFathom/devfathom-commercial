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
  resolveBySecret: vi.fn(),
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
  resolvePharmacyCounterBySecret: mocks.resolveBySecret,
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
  auditLog: { create: vi.fn(async () => ({})) },
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
  mocks.resolveBySecret.mockResolvedValue({
    id: DEVICE,
    branchId: BRANCH,
    organizationId: ORG,
    status: 'ACTIVE',
    revokedAt: null,
  });
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

  it('keeps quota and reject on admin:access', async () => {
    const token = await establish();
    state.grants = new Set(['pharmacy:orders', 'pharmacy:counter']);
    for (const operation of ['quota', 'reject'] as const) {
      const response = await call(operation, token, {});
      expect(response.status, operation).toBe(403);
      expect(await response.json(), operation).toEqual({ error: 'forbidden' });
    }
    expect(mocks.recordOfflineCommand).not.toHaveBeenCalled();
    state.grants.add('admin:access');
    expect((await call('lease', token, { size: 1000 })).status).toBe(200);
    expect(mocks.reserveReceiptNumberBlock).toHaveBeenCalledTimes(1);
  });

  it('denies lease, quota and reject to a manager not assigned to the terminal branch', async () => {
    const token = await establish();
    state.grants = new Set(['admin:access']);
    state.assignedBranches = new Set(['branch_other']);
    for (const operation of ['lease', 'quota', 'reject'] as const) {
      const response = await call(operation, token, {});
      expect(response.status, operation).toBe(403);
      expect(await response.json(), operation).toEqual({ error: 'branch_forbidden' });
    }
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });

  it('lets an organization administrator lease without a branch assignment', async () => {
    const token = await establish();
    state.role = 'ADMIN';
    state.grants = new Set(['admin:access']);
    state.assignedBranches.clear();
    expect((await call('lease', token, { size: 1 })).status).toBe(200);
  });
});

describe('DEV-767 background receipt-lease renewal by the counter operator', () => {
  const leaseFor = (deviceId: string, branchId: string) => {
    mocks.resolveBySecret.mockResolvedValue({
      id: deviceId,
      branchId,
      organizationId: ORG,
      status: 'ACTIVE',
      revokedAt: null,
    });
  };

  it("lets an assigned cashier renew their own terminal's lease without admin:access", async () => {
    const token = await establish();
    const response = await call('lease', token, { size: 100 });
    expect(response.status).toBe(200);
    expect(mocks.reserveReceiptNumberBlock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { organizationId: ORG, branchId: BRANCH, actorId: ACTOR },
      { deviceId: DEVICE, size: 100 }
    );
  });

  it('caps a cashier renewal at one renewal block', async () => {
    const token = await establish();
    const response = await call('lease', token, { size: 101 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });

  it("refuses another branch's terminal to a cashier assigned elsewhere", async () => {
    const token = await establish();
    leaseFor('device_other_branch', 'branch_other');
    const response = await call('lease', token, { size: 100 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'branch_forbidden' });
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });

  it("refuses another terminal's lease with this terminal's session", async () => {
    const token = await establish();
    leaseFor('device_other_terminal', BRANCH);
    const response = await call(
      'lease',
      token,
      { size: 100 },
      {
        authorization: `Bearer pcd_${'b'.repeat(43)}`,
      }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_terminal_session' });
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });

  it('refuses renewal once the counter grant or branch assignment is revoked', async () => {
    const token = await establish();
    state.grants.delete('pharmacy:counter');
    expect((await call('lease', token, { size: 100 })).status).toBe(403);
    grantCashier();
    state.assignedBranches.clear();
    const response = await call('lease', token, { size: 100 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'branch_forbidden' });
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user with neither the manager nor the orders grant', async () => {
    const token = await establish();
    state.grants = new Set(['pharmacy:counter']);
    const response = await call('lease', token, { size: 100 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(mocks.reserveReceiptNumberBlock).not.toHaveBeenCalled();
  });
});

describe('DEV-913 offline counter audit entries', () => {
  it('records who opened the terminal, took a snapshot and reserved receipt numbers, at which branch', async () => {
    const token = await establish();
    expect((await call('snapshot', token)).status).toBe(200);
    expect((await call('lease', token, { size: 100 })).status).toBe(200);
    const entries = fakeDb.auditLog.create.mock.calls.map(
      (args) => (args as unknown as [{ data: Record<string, unknown> }])[0].data
    );
    expect(entries.map((entry) => entry.action)).toEqual([
      'pharmacyOffline.openCounterSession',
      'pharmacyOffline.issueOfflineSnapshot',
      'pharmacyOffline.reserveReceiptNumbers',
    ]);
    for (const entry of entries)
      expect(entry).toMatchObject({
        organizationId: ORG,
        actorId: ACTOR,
        source: 'REST_API',
        category: 'PHARMACY',
        metadata: expect.objectContaining({ branchId: BRANCH, deviceId: DEVICE }),
      });
    expect(entries[2]?.metadata).toMatchObject({ size: 100 });
    // Never the device secret, the terminal session token or a signature.
    const stored = JSON.stringify(entries);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(token);
  });

  it('records nothing for a refused request', async () => {
    state.assignedBranches.clear();
    expect((await call('establish')).status).toBe(403);
    expect(fakeDb.auditLog.create).not.toHaveBeenCalled();
  });

  it('records each newly posted offline sale once, not its replays', () => {
    const body = { sequence: 3, action: 'CASH_OTC_SALE', leasedReceipt: { receiptNumber: 9 } };
    expect(
      router.counterAuditEntry('replay', body, {
        saleId: 'sale_1',
        receiptNumber: 9,
        replayed: false,
      })
    ).toEqual({
      action: 'replayOfflineSale',
      operation: 'CREATE',
      targetType: 'PharmacySale',
      targetId: 'sale_1',
      metadata: { receiptNumber: 9, sequence: 3, commandAction: 'CASH_OTC_SALE' },
    });
    expect(
      router.counterAuditEntry('replay', body, {
        saleId: 'sale_1',
        receiptNumber: 9,
        replayed: true,
      })
    ).toBeNull();
    expect(
      router.counterAuditEntry(
        'quota',
        { inventoryLotId: 'lot_1', stockLocationId: 'loc_1', units: 5 },
        {}
      )
    ).toMatchObject({ targetId: 'lot_1', metadata: { stockLocationId: 'loc_1', units: 5 } });
  });
});
