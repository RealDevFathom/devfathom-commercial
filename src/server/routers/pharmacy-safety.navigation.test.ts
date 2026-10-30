import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_PACKAGES } from '@/lib/vertical-catalog';
import { moduleForProcedure } from '@/lib/module-catalog';
import { pharmacySafetyRouter } from './pharmacy-safety';
import { router, type TRPCContext } from '../trpc';

const app = router({ pharmacySafety: pharmacySafetyRouter });
const essentials = PHARMACY_PACKAGES.find((entry) => entry.key === 'pharmacy-essentials')!;
const capabilities = [
  'pharmacy:counter',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'reports:operational',
];

function fixture(enabledModules = [...essentials.moduleKeys], status = 'ACTIVE') {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      }),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org', enabledModules, modules: [] },
    session: {
      user: { id: 'operator', organizationId: 'org', role: 'EMPLOYEE', status },
    },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySafety;
  return { caller, db };
}

describe('Pharmacy navigation license', () => {
  it('returns authorized navigation for Essentials without the optional Safety module', async () => {
    expect(essentials.moduleKeys).not.toContain('pharmacy-safety');
    expect(moduleForProcedure('pharmacySafety.navigationAccess')).toBe('pharmacy-core');
    await expect(fixture().caller.navigationAccess()).resolves.toEqual({
      userId: 'operator',
      organizationId: 'org',
      capabilities,
    });
  });

  it('still requires Core and keeps Safety procedures separately licensed', async () => {
    const { caller, db } = fixture(['pharmacy-safety']);
    await expect(caller.navigationAccess()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    await expect(fixture().caller.access()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(moduleForProcedure('pharmacySafety.controlledRegister')).toBe('pharmacy-safety');
  });

  it('does not expose capabilities for an inactive session', async () => {
    const { caller, db } = fixture(undefined, 'SUSPENDED');
    await expect(caller.navigationAccess()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
