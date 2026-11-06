import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function template(name: string): Permission[] {
  const found = PHARMACY_ROLE_TEMPLATES.find((role) => role.name === name);
  if (!found) throw new Error(`No pharmacy role template named ${name}`);
  return found.capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));
}

function counterBranches(permissions: Permission[] | null, role: 'EMPLOYEE' | 'ADMIN') {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: permissions ? { permissions } : null,
        permissionOverrides: [],
      })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async () => [
        { id: 'branch-a', code: 'A', name: 'Counter A', city: 'Lahore' },
      ]),
    },
    organization: {
      findUnique: vi.fn(async () => ({ currency: 'PKR', timezone: 'Asia/Karachi' })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role,
        department: 'COUNTER',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return app.createCaller(context as unknown as TRPCContext).pharmacySales.counterBranches();
}

describe('counterBranches display flags', () => {
  it.each([
    ['Cashier', false, false],
    ['Manager', true, true],
    ['Pharmacist', false, true],
  ])(
    'gives the %s template counterManager=%s and counterBatchDetail=%s',
    async (name, counterManager, counterBatchDetail) => {
      await expect(counterBranches(template(name), 'EMPLOYEE')).resolves.toMatchObject({
        branches: [{ id: 'branch-a' }],
        counterManager,
        counterBatchDetail,
      });
    }
  );

  it('gives a session ADMIN both', async () => {
    await expect(counterBranches(null, 'ADMIN')).resolves.toMatchObject({
      counterManager: true,
      counterBatchDetail: true,
    });
  });

  it('never reads a wildcard grant as the pharmacist dispense grant', async () => {
    await expect(
      counterBranches(
        [
          { capability: 'pharmacy:*', effect: 'ALLOW' },
          { capability: 'pharmacy:manage', effect: 'DENY' },
        ],
        'EMPLOYEE'
      )
    ).resolves.toMatchObject({ counterManager: false, counterBatchDetail: false });
  });
});
