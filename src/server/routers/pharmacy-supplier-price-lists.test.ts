import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-681 — price-list authorization end to end through the REAL ABAC engine
// (`@/lib/abac` is not mocked): a manager or buyer may import and review, but
// only an owner/administrator may approve a shop-wide shelf price.

const mocks = vi.hoisted(() => ({ decide: vi.fn(async () => []), annotateAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/supplier-price-lists', () => ({
  decideSupplierPriceDrafts: mocks.decide,
  importSupplierPriceList: vi.fn(),
  listSupplierPriceLists: vi.fn(async () => []),
  supplierPriceListReview: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { moduleForProcedure } from '@/lib/module-catalog';
import type { ProcedureMeta, TRPCContext } from '../trpc';
import { pharmacySupplierPriceListsRouter } from './pharmacy-supplier-price-lists';

const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities as readonly string[];

type Person = { role: 'ADMIN' | 'EMPLOYEE'; grants: readonly string[] | null };
const PEOPLE: Record<string, Person> = {
  cashier: { role: 'EMPLOYEE', grants: template('cashier') },
  buyer: { role: 'EMPLOYEE', grants: template('procurement') },
  manager: { role: 'EMPLOYEE', grants: template('manager') },
  owner: { role: 'ADMIN', grants: ['*', 'pharmacy:dispense'] },
  legacy_owner: { role: 'ADMIN', grants: null },
};

function userRow(id: string) {
  const person = PEOPLE[id];
  if (!person) return null;
  return {
    id,
    role: person.role,
    status: 'ACTIVE',
    organizationId: 'org_a',
    organizationRole: person.grants
      ? {
          key: 'role',
          permissions: person.grants.map((capability) => ({ capability, effect: 'ALLOW' })),
        }
      : null,
    permissionOverrides: [],
  };
}

let db: Record<string, unknown>;
beforeEach(() => {
  mocks.decide.mockClear();
  const user = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => userRow(where.id)),
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => userRow(where.id)),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
  db = {
    user,
    $queryRaw: vi.fn(async () => []),
    pharmacySupplier: { findMany: vi.fn(async () => []) },
  };
});

function caller(userId: string) {
  return pharmacySupplierPriceListsRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: userId, role: PEOPLE[userId]!.role, status: 'ACTIVE', organizationId: 'org_a' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const approve = (who: string) =>
  caller(who).decide({ lineIds: ['line-1'], decision: 'APPROVE', pin: '1234' });

describe('DEV-681 supplier price-list permissions', () => {
  it('declares a permission on every procedure: procurement to import, owner/admin to decide', () => {
    const procedures = (
      pharmacySupplierPriceListsRouter as unknown as {
        _def: { procedures: Record<string, { _def: { meta?: ProcedureMeta } }> };
      }
    )._def.procedures;
    const capabilities = Object.fromEntries(
      Object.entries(procedures).map(([name, procedure]) => [name, procedure._def.meta?.capabilities])
    );
    expect(capabilities).toEqual({
      options: ['pharmacy:procurement'],
      list: ['pharmacy:procurement'],
      review: ['pharmacy:procurement'],
      import: ['pharmacy:procurement'],
      decide: ['admin:access'],
    });
  });

  it.each(['manager', 'buyer', 'cashier'])(
    'refuses a %s approving or rejecting a shelf-price draft on the server',
    async (who) => {
      await expect(approve(who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller(who).decide({ lineIds: ['line-1'], decision: 'REJECT' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.decide).not.toHaveBeenCalled();
    }
  );

  it('lets a manager and a buyer import and review, but never a cashier', async () => {
    await expect(caller('manager').list()).resolves.toEqual([]);
    await expect(caller('buyer').options()).resolves.toEqual({ suppliers: [] });
    await expect(caller('cashier').list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['owner', 'legacy_owner'])('lets the %s reach the approval', async (who) => {
    await expect(approve(who)).resolves.toEqual([]);
    expect(mocks.decide).toHaveBeenCalledWith(
      db,
      { organizationId: 'org_a', actorId: who },
      { lineIds: ['line-1'], decision: 'APPROVE', pin: '1234' }
    );
  });

  it('is licensed as Pharmacy Procurement', () => {
    expect(moduleForProcedure('pharmacySupplierPriceLists.decide')).toBe('pharmacy-procurement');
  });
});
