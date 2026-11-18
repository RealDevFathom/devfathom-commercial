import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-876: the counter's reads take their branch from the input. Each one must
// refuse an active branch of the organization the caller is not assigned to,
// before any stock, lot, drawer, pack or customer read, exactly as the counter's
// writes already do. A branch outside the workspace keeps `scopeFor`'s refusal,
// and a session ADMIN of the organization still reads every active branch.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

/** Every stubbed library read takes the database, then the branch scope, then its input. */
type BranchRead = (
  db: unknown,
  scope: { organizationId: string; branchId: string; actorId: string },
  ...input: unknown[]
) => Promise<unknown>;
const reads = vi.hoisted(() => {
  const read = (result: unknown) => vi.fn<BranchRead>(async () => result);
  return {
    searchCounterCatalog: read({ results: [] }),
    readCustomerSnapshot: read({ customer: null }),
    onHand: read([]),
    readOpenPharmacyDrawer: read(null),
    readPharmacyTenderOutcome: read({ status: 'ACCEPTED' }),
    findSubstituteProposals: read([]),
    findUpsellSuggestions: read([]),
    authenticatePharmacyPack: read({ status: 'UNVERIFIED' }),
  };
});
vi.mock('@/lib/pharmacy/counter', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/counter')>()),
  searchCounterCatalog: reads.searchCounterCatalog,
}));
vi.mock('@/lib/pharmacy/customer-loyalty', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-loyalty')>()),
  readCustomerSnapshot: reads.readCustomerSnapshot,
}));
vi.mock('@/lib/pharmacy/stock-ledger', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/stock-ledger')>()),
  onHand: reads.onHand,
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  readOpenPharmacyDrawer: reads.readOpenPharmacyDrawer,
  readPharmacyTenderOutcome: reads.readPharmacyTenderOutcome,
}));
vi.mock('@/lib/pharmacy/substitute-finder', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/substitute-finder')>()),
  findSubstituteProposals: reads.findSubstituteProposals,
}));
vi.mock('@/lib/pharmacy/upsell-suggestions', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/upsell-suggestions')>()),
  findUpsellSuggestions: reads.findUpsellSuggestions,
}));
vi.mock('@/lib/pharmacy/pack-authentication-operations', () => ({
  authenticatePharmacyPack: reads.authenticatePharmacyPack,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Caller = ReturnType<typeof app.createCaller>['pharmacySales'];

const MAIN = 'branch-main';
const DHA = 'branch-dha';
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const NOT_IN_WORKSPACE = { code: 'BAD_REQUEST', message: 'That record is not in this workspace.' };

type Read = keyof typeof reads;
const procedures: Array<[string, Read, (caller: Caller, branchId: string) => Promise<unknown>]> = [
  [
    'counterSearch',
    'searchCounterCatalog',
    (c, branchId) => c.counterSearch({ branchId, query: 'panadol' }),
  ],
  [
    'customerSnapshot',
    'readCustomerSnapshot',
    (c, branchId) => c.customerSnapshot({ branchId, customerId: 'customer-1' }),
  ],
  [
    'counterLotOptions',
    'onHand',
    (c, branchId) => c.counterLotOptions({ branchId, medicineId: 'medicine-1' }),
  ],
  [
    'drawerStatus',
    'readOpenPharmacyDrawer',
    (c, branchId) => c.drawerStatus({ branchId, deviceId: 'counter-device' }),
  ],
  [
    'tenderOutcome',
    'readPharmacyTenderOutcome',
    (c, branchId) =>
      c.tenderOutcome({
        branchId,
        saleId: 'sale-1',
        deviceId: 'counter-device',
        businessDate: new Date('2026-11-16T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 500,
        cashReceivedMinor: 500,
        idempotencyKey: 'tender-1',
      }),
  ],
  [
    'substituteProposals',
    'findSubstituteProposals',
    (c, branchId) =>
      c.substituteProposals({
        branchId,
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        quantityCanonicalUnits: 10,
      }),
  ],
  [
    'upsellSuggestions',
    'findUpsellSuggestions',
    (c, branchId) => c.upsellSuggestions({ branchId, medicineIds: ['medicine-1'] }),
  ],
  [
    'authenticatePack',
    'authenticatePharmacyPack',
    (c, branchId) => c.authenticatePack({ branchId, payload: '0100' }),
  ],
];

const activeBranches = new Set([MAIN, DHA]);
let db: {
  $transaction: ReturnType<typeof vi.fn>;
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  pharmacyBranchAssignment: { findMany: ReturnType<typeof vi.fn> };
  pharmacyInventoryLot: { findMany: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

/** The branch scope the library read was handed (its second argument). */
function scopeOf(read: Read) {
  const calls = reads[read].mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![1];
}

function caller(role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE'): Caller {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

beforeEach(() => {
  for (const read of Object.values(reads)) read.mockClear();
  db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    // Main and DHA are both active branches of the cashier's organization.
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => activeBranches.has(id)).map((id) => ({ id }))
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        activeBranches.has(where.id) ? { id: where.id } : null
      ),
    },
    // The cashier is assigned to Main Branch only.
    pharmacyBranchAssignment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; branchId?: string } }) =>
        where.userId === 'cashier-1' && (where.branchId ?? MAIN) === MAIN
          ? [{ branchId: MAIN }]
          : []
      ),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
    // DEV-907: counterSearch reads the owner's other-branch switch (off here).
    organization: { findUnique: vi.fn(async () => null) },
    // A counter member with the canonical counter grant, so any refusal is the branch.
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [
            { capability: 'pharmacy:counter', effect: 'ALLOW' },
            { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      })),
      findFirst: vi.fn(async () => null),
    },
  };
});

describe('counter reads stay inside the cashier’s branch assignment (DEV-876)', () => {
  it.each(procedures)(
    '%s refuses another branch of the organization before reading it',
    async (_name, read, run) => {
      await expect(run(caller(), DHA)).rejects.toMatchObject(OUTSIDE);
      expect(reads[read]).not.toHaveBeenCalled();
      expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
      expect(db.user.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(procedures)(
    '%s reads the branch the cashier is assigned to',
    async (_name, read, run) => {
      await expect(run(caller(), MAIN)).resolves.toBeDefined();
      expect(scopeOf(read)).toMatchObject({
        organizationId: 'org-1',
        branchId: MAIN,
        actorId: 'cashier-1',
      });
    }
  );

  it.each(procedures)(
    '%s keeps the workspace refusal for a branch outside the organization',
    async (_name, read, run) => {
      await expect(run(caller(), 'branch-elsewhere')).rejects.toMatchObject(NOT_IN_WORKSPACE);
      expect(reads[read]).not.toHaveBeenCalled();
    }
  );

  it.each(procedures)(
    '%s lets a session ADMIN of the organization read an unassigned branch',
    async (_name, read, run) => {
      await expect(run(caller('ADMIN'), DHA)).resolves.toBeDefined();
      expect(scopeOf(read)).toMatchObject({ organizationId: 'org-1', branchId: DHA });
    }
  );
});
