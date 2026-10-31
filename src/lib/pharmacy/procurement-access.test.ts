import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  actorCanProcure,
  actorCanReadPurchasing,
  actorIsPharmacyOwner,
  procurementCapabilityGranted,
} from './procurement-access';

describe('procurementCapabilityGranted', () => {
  it('allows the procurement capability and refuses a cashier', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [
          { capability: 'pharmacy.counter', effect: 'ALLOW' },
          { capability: 'pharmacy:orders', effect: 'ALLOW' },
        ],
      })
    ).toBe(false);
  });

  it('lets a pharmacy wildcard through and lets DENY win', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [{ capability: 'pharmacy.*', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy.procurement', effect: 'DENY' }],
        role: [{ capability: 'pharmacy.*', effect: 'ALLOW' }],
      })
    ).toBe(false);
  });

  it('does not let an override ALLOW bypass a role DENY', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        role: [{ capability: 'pharmacy:*', effect: 'DENY' }],
      })
    ).toBe(false);
  });
});

describe('live owner and administrator DENY precedence', () => {
  it.each(['pharmacy:procurement', 'pharmacy.procurement', 'pharmacy:*', '*'])(
    'honors %s DENY for owner and wildcard administrator authority',
    async (capability) => {
      for (const key of ['owner', 'custom-admin']) {
        const db = {
          user: {
            findUnique: vi.fn().mockResolvedValue({
              status: 'ACTIVE',
              role: 'ADMIN',
              organizationRole: {
                key,
                isSystem: key === 'owner',
                permissions: [{ capability: '*', effect: 'ALLOW' }],
              },
              permissionOverrides: [{ capability, effect: 'DENY' }],
            }),
          },
        } as unknown as ScopedDb;
        await expect(actorCanProcure(db, 'user')).resolves.toBe(false);
        await expect(actorCanReadPurchasing(db, 'user')).resolves.toBe(false);
        await expect(actorIsPharmacyOwner(db, 'org', 'user')).resolves.toBe(false);
      }
    }
  );
  it('honors an explicit receiving-view denial for an owner', async () => {
    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          role: 'ADMIN',
          organizationRole: { key: 'owner', isSystem: true, permissions: [] },
          permissionOverrides: [{ capability: 'pharmacy:receiving-view', effect: 'DENY' }],
        }),
      },
    } as unknown as ScopedDb;
    await expect(actorCanReadPurchasing(db, 'user')).resolves.toBe(false);
  });
});
