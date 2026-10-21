import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

// Real ABAC decision (not mocked): the cashier template's grants come from the role.
function caller(templateKey: string, grants?: string[]) {
  const template = {
    capabilities:
      grants ?? PHARMACY_ROLE_TEMPLATES.find((t) => t.key === templateKey)!.capabilities,
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      })),
    },
    medicine: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    api: pharmacyMedicineRouter.createCaller({
      db,
      entitlements: { organizationId: 'org_a', enabledModules: ['pharmacy-core'], modules: [] },
      session: {
        expires: 'later',
        user: {
          id: `${templateKey}_1`,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationId: 'org_a',
        },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext),
  };
}

describe('createMedicine requires pharmacy:procurement on the server (#132)', () => {
  it('refuses a cashier', async () => {
    const { api, db } = caller('cashier');
    await expect(
      api.createMedicine({ productName: 'Test', productFamily: 'FRONT_SHOP' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.medicine.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // Canonical colon grant (#163 renames the templates; until it merges, dotted template
  // grants do not satisfy this gate).
  it('lets a pharmacy:procurement holder past the gate (positive control)', async () => {
    const { api, db } = caller('procurement', ['pharmacy:procurement']);
    await api
      .createMedicine({ productName: 'Test', productFamily: 'FRONT_SHOP' })
      .catch(() => null);
    expect(db.medicine.create).toHaveBeenCalled();
  });
});
