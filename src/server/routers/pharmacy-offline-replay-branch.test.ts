/**
 * DEV-830 (security scan F04): a signed offline replay creates a bill and debits stock in
 * the device's branch. It checked only `pharmacy:orders` and the device secret, so a
 * member assigned elsewhere (or holding no counter grant) could replay a sale into this
 * branch. Replay now takes the counter operator gate shared with establishment and
 * snapshots (DEV-831 `counterOperatorDenial`): the canonical counter grant, an active
 * member with a deny-wins counter ALLOW, and an active assignment to the device's branch.
 * Each case establishes the terminal while permitted and loses access before replaying,
 * which is the access-lost-while-offline path.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfflineSnapshotEnvelope } from '@/lib/pharmacy/offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const ORG = 'org_a';
const BRANCH = 'branch_a';
const DEVICE = 'counter_1';
const SECRET = `pcd_${'a'.repeat(43)}`;

const mocks = vi.hoisted(() => ({
  user: { id: 'actor_a', role: 'EMPLOYEE', organizationId: 'org_a' },
  grants: new Set<string>(),
  assignedBranches: [] as string[],
  recordOfflineCommand: vi.fn(),
  createSale: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => ({
    organization: { id: 'org_a' },
    session: { user: mocks.user },
    support: null,
  })),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn(() => true),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async (_subject: unknown, action: string) => mocks.grants.has(action)),
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  clientIp: () => '127.0.0.1',
}));
vi.mock('@/lib/pharmacy/offline-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-devices')>()),
  resolvePharmacyCounterBySecret: vi.fn(async () => ({
    id: 'counter_1',
    organizationId: 'org_a',
    branchId: 'branch_a',
    status: 'ACTIVE',
    revokedAt: null,
  })),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  authenticatePharmacyCommand: vi.fn(async () => undefined),
  validateLeasedReceiptReplay: vi.fn(() => undefined),
  createSale: mocks.createSale,
}));
vi.mock('@/lib/pharmacy/offline-command-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-command-log')>()),
  recordOfflineCommand: mocks.recordOfflineCommand,
}));

const assignmentLookup = vi.fn(
  async ({ where }: { where: { userId: string; branchId: string; active: boolean } }) =>
    where.active && mocks.assignedBranches.includes(where.branchId)
      ? { branchId: where.branchId }
      : null
);
const db = {
  $queryRaw: vi.fn(async () => []),
  pharmacyBranch: { findFirst: vi.fn(async () => ({ id: BRANCH })) },
  // The member's persisted counter rules mirror the grants of the current request.
  user: {
    findUnique: vi.fn(async () => ({
      status: 'ACTIVE',
      organizationId: ORG,
      organizationRole: {
        permissions: mocks.grants.has('pharmacy:counter')
          ? [{ capability: 'pharmacy:counter', effect: 'ALLOW' }]
          : [],
      },
      permissionOverrides: [],
    })),
  },
  pharmacyBranchAssignment: { findFirst: assignmentLookup },
  pharmacyInventoryLot: {
    findMany: vi.fn(async () => [{ id: 'lot_1', batch: { state: 'ACTIVE' } }]),
  },
  auditLog: { create: vi.fn(async () => ({})) },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org: string, work: (tx: unknown) => unknown) => work(db)),
}));

type Router = typeof import('./pharmacy-offline');
type Signing = typeof import('@/lib/pharmacy/offline-snapshots');
let router: Router;
let signing: Signing;

beforeAll(async () => {
  router = await import('./pharmacy-offline');
  signing = await import('@/lib/pharmacy/offline-snapshots');
});

const ISSUED_AT = '2026-09-02T09:00:00.000Z';
const EXPIRES_AT = '2026-09-02T17:00:00.000Z';
const SALE_AT = '2026-09-02T12:00:00.000Z';
const KINDS = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'] as const;

function envelope(
  kind: OfflineSnapshotEnvelope['kind'],
  payload: unknown
): OfflineSnapshotEnvelope {
  return {
    organizationId: ORG,
    branchId: BRANCH,
    deviceId: DEVICE,
    kind,
    version: 1,
    payloadHash: signing.snapshotPayloadHash(payload),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    safetyLease: {
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      recallVersion: 0,
      licenceVersion: 0,
      ruleVersion: 0,
      recalledBatchIds: [],
    },
    signingKeyId: signing.SNAPSHOT_SIGNING_KEY_ID,
  };
}

function command() {
  const receiptEnvelope = envelope('RULES', { kind: 'RULES' });
  return {
    sequence: 1,
    idempotencyKey: 'idem_1',
    action: 'CASH_OTC_SALE',
    leasedReceipt: {
      leaseId: 'lease_1',
      receiptNumber: 900,
      originalSaleAt: SALE_AT,
      envelope: receiptEnvelope,
      signature: signing.signSnapshotEnvelope(receiptEnvelope),
    },
    snapshots: KINDS.map((kind) => {
      const payload = { kind };
      const signed = envelope(kind, payload);
      return { envelope: signed, signature: signing.signSnapshotEnvelope(signed), payload };
    }),
    lines: [
      {
        medicineId: 'med_1',
        presentationId: 'presentation_1',
        packLevelId: 'pack_1',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        inventoryLotId: 'lot_1',
        stockLocationId: 'loc_1',
      },
    ],
    amountMinor: 100,
    cashReceivedMinor: 100,
  };
}

async function call(operation: 'establish' | 'replay', body: unknown, token = '') {
  return router.pharmacyCounterRoute(operation)(
    new Request(`https://tenant.test/api/pharmacy/counter/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'x-terminal-session': token,
        'idempotency-key': 'idem_1',
        'x-command-signature': 'command-signature',
        'x-receipt-signature': 'receipt-signature',
      },
      body: JSON.stringify(body),
    })
  );
}

/**
 * Establish a terminal session while the actor may operate this branch, then replay one
 * queued sale with the grants and assignments the actor holds at replay time.
 */
async function replayAs(options: { grants: string[]; assigned: string[]; role?: string }) {
  mocks.user.role = options.role ?? 'EMPLOYEE';
  mocks.grants = new Set(['pharmacy:orders', 'pharmacy:counter']);
  mocks.assignedBranches = [BRANCH];
  const established = await call('establish', {});
  expect(established.status).toBe(201);
  const { sessionToken } = (await established.json()) as { sessionToken: string };
  mocks.grants = new Set(['pharmacy:orders', ...options.grants]);
  mocks.assignedBranches = options.assigned;
  assignmentLookup.mockClear();
  return call('replay', command(), sessionToken);
}

beforeEach(() => {
  mocks.recordOfflineCommand.mockReset();
  // A retry of a sale the server already accepted: the response proves the gate let it in.
  mocks.recordOfflineCommand.mockResolvedValue({
    command: { id: 'cmd_1', status: 'ACCEPTED', serverRef: 'sale_1', receiptNumber: 900 },
  });
  mocks.createSale.mockReset();
  assignmentLookup.mockClear();
});

describe('DEV-830 offline replay branch gate', () => {
  it('refuses an actor assigned only to another branch before anything is recorded', async () => {
    const response = await replayAs({ grants: ['pharmacy:counter'], assigned: ['branch_b'] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'branch_forbidden' });
    expect(assignmentLookup.mock.calls[0]![0].where).toEqual({
      organizationId: ORG,
      userId: 'actor_a',
      branchId: BRANCH,
      active: true,
      branch: { organizationId: ORG, active: true },
    });
    expect(mocks.recordOfflineCommand).not.toHaveBeenCalled();
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('refuses an assigned actor without the counter grant', async () => {
    const response = await replayAs({ grants: [], assigned: [BRANCH] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(mocks.recordOfflineCommand).not.toHaveBeenCalled();
    expect(mocks.createSale).not.toHaveBeenCalled();
  });

  it('lets an assigned counter actor replay', async () => {
    const response = await replayAs({ grants: ['pharmacy:counter'], assigned: [BRANCH] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      saleId: 'sale_1',
      receiptNumber: 900,
      replayed: true,
    });
    expect(mocks.recordOfflineCommand).toHaveBeenCalledOnce();
  });

  it('keeps the organization administrator able to replay on any active branch', async () => {
    const response = await replayAs({ grants: ['pharmacy:counter'], assigned: [], role: 'ADMIN' });
    expect(response.status).toBe(200);
    expect(assignmentLookup).not.toHaveBeenCalled();
  });
});
