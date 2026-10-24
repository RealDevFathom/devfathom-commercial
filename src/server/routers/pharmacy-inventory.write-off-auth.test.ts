/** SEC-374-01: real authenticated transport and canonical ABAC; only persistence
 * is mocked. Capability, actual selected-branch authority and a valid witness
 * are independent requirements. Refusals must not read stock or write evidence. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['pharmacy-inventory'] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });
const input = {
  branchId: 'branch_a',
  inventoryLotId: 'lot_a',
  stockLocationId: 'location_a',
  units: 2,
  witnessId: 'witness_a',
  reason: 'Broken seal',
  evidenceRef: 'photo-374',
  idempotencyKey: 'write-off-374',
};

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { name: 'Inventory Manager', permissions: [] as Rule[] },
        permissionOverrides: [] as Rule[],
      }),
      findFirst: vi
        .fn<() => Promise<{ id: string } | null>>()
        .mockResolvedValue({ id: 'witness_a' }),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => ['branch_a', 'branch_b'].includes(id)).map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(async ({ where }: { where: { branchId: string; userId: string } }) =>
        where.branchId === 'branch_a' && where.userId === 'actor_a' ? { id: 'assignment_a' } : null
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: 'lot_a', unitsPerPack: 1 }),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({ onHandUnits: 10, sealedPacks: 0, looseUnits: 10 }),
    },
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'movement_a', ...data })),
    },
    pharmacyCustodyRecord: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'custody_a', ...data })),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (run: (tx: typeof db) => unknown) => run(db)),
  });
}
let db: ReturnType<typeof makeDb>;
function caller(role: 'ADMIN' | 'SUPERADMIN' | 'EMPLOYEE' = 'EMPLOYEE') {
  return pharmacyInventoryRouter.createCaller({
    db,
    headers: new Headers(),
    entitlements: { organizationId: 'org_a', enabledModules: ['pharmacy-inventory'] },
    session: {
      expires: 'later',
      user: { id: 'actor_a', role, status: 'ACTIVE', organizationId: 'org_a' },
    },
    // Deliberately authorized decoy selection: only input.branchId may control the write.
    branchId: 'branch_a',
    selectedBranchId: 'branch_a',
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
function grant(rules: Rule[], overrides: Rule[] = []) {
  db.user.findUnique.mockResolvedValue({
    organizationRole: { name: 'Inventory Manager', permissions: rules },
    permissionOverrides: overrides,
  });
}
function untouched() {
  expect(db.user.findFirst).not.toHaveBeenCalled();
  expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
  expect(db.pharmacyStockBalance.findFirst).not.toHaveBeenCalled();
  expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  db = makeDb();
});

describe('SEC-374-01 write-off capability and actual-branch authority', () => {
  it('denies no-grant assigned staff despite an Inventory Manager role name and valid witness', async () => {
    await expect(caller().writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    untouched();
  });

  it.each(['pharmacy:inventory', 'pharmacy:*', '*'])(
    'preserves %s DENY against exact ALLOW, with no stock or custody effects',
    async (capability) => {
      grant([allow('pharmacy:inventory')], [deny(capability)]);
      await expect(caller().writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      untouched();
    }
  );

  it('preserves role DENY against a user ALLOW', async () => {
    grant([deny('pharmacy:inventory')], [allow('pharmacy:inventory')]);
    await expect(caller().writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    untouched();
  });

  it('refuses the actual sibling branch even when the cookie/selection and witness are authorized', async () => {
    grant([allow('pharmacy:inventory')]);
    await expect(caller().writeOff({ ...input, branchId: 'branch_b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        userId: 'actor_a',
        branchId: 'branch_b',
        active: true,
        branch: { active: true },
      },
      select: { id: true },
    });
    untouched();
  });

  it('refuses missing or inactive assignments', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(caller().writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    untouched();
  });

  it('refuses another tenant or inactive branch before assignment and stock access', async () => {
    grant([allow('pharmacy:inventory')]);
    db.pharmacyBranch.findMany.mockResolvedValue([]);
    // Preserve assertInOrganization's canonical fail-closed contract, not a
    // resolver-local authorization error; no assignment/stock access may follow.
    await expect(caller().writeOff({ ...input, branchId: 'foreign_branch' })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
        message: 'That record is not in this workspace.',
      }
    );
    expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
    untouched();
  });

  it.each(['pharmacy:inventory', 'pharmacy:*', '*'])(
    'allows assigned staff granted %s and records the actual branch/actor/witness',
    async (capability) => {
      grant([allow(capability)]);
      const result = await caller().writeOff(input);
      expect(result.movement).toMatchObject({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'actor_a',
        kind: 'WRITE_OFF',
        quantityUnits: -2,
      });
      expect(result.custody).toMatchObject({
        organizationId: 'org_a',
        branchId: 'branch_a',
        actorId: 'actor_a',
        witnessId: 'witness_a',
      });
      expect(db.pharmacyStockMovement.create).toHaveBeenCalledTimes(1);
      expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['ADMIN', 'SUPERADMIN'] as const)(
    'does not infer %s assignment authority from the system role',
    async (role) => {
      grant([allow('pharmacy:inventory')]);
      await expect(caller(role).writeOff({ ...input, branchId: 'branch_b' })).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
        }
      );
      untouched();
    }
  );

  it.each(['ADMIN', 'SUPERADMIN'] as const)(
    'allows granted, actually assigned %s without bypassing checks',
    async (role) => {
      grant([allow('pharmacy:inventory')]);
      await expect(caller(role).writeOff(input)).resolves.toMatchObject({
        movement: { branchId: 'branch_a', actorId: 'actor_a' },
      });
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalled();
    }
  );

  it.each(['ADMIN', 'SUPERADMIN'] as const)(
    'does not infer an inventory grant from system role %s',
    async (role) => {
      await expect(caller(role).writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      untouched();
    }
  );

  it('does not let a trusted admin bypass applicable capability DENY', async () => {
    grant([allow('pharmacy:inventory')], [deny('pharmacy:inventory')]);
    await expect(caller('ADMIN').writeOff(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    untouched();
  });

  it('still requires an active same-tenant distinct witness after both authorizations succeed', async () => {
    grant([allow('pharmacy:inventory')]);
    db.user.findFirst.mockResolvedValue(null);
    await expect(caller().writeOff(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'COAUTH_REQUIRED',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });
});
