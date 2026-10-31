import { describe, expect, it, vi } from 'vitest';

import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

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

  it('lets a role DENY win over a user ALLOW, as in ABAC', () => {
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

describe('Goods-in procurement access (#375)', () => {
  it.each(['ADMIN', 'EMPLOYEE'])(
    'agrees with ABAC for %s with every pharmacy template or no role',
    async (role) => {
      for (const template of [null, { capabilities: [] }, ...PHARMACY_ROLE_TEMPLATES]) {
        for (const denied of [false, true]) {
          const db = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                role,
                organizationRole: template
                  ? {
                      permissions: template.capabilities.map((capability) => ({
                        capability,
                        effect: 'ALLOW',
                      })),
                    }
                  : null,
                permissionOverrides: denied ? [{ capability: 'pharmacy:*', effect: 'DENY' }] : [],
              }),
            },
          } as unknown as ScopedDb;
          const expected = await can({ id: 'actor', role }, 'pharmacy:procurement', undefined, {
            db,
          });
          expect(await actorCanProcure(db, 'actor')).toBe(expected);
        }
      }
    }
  );

  it('denies a missing tenant user', async () => {
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as ScopedDb;
    expect(await actorCanProcure(db, 'missing')).toBe(false);
  });

  it('filters expired overrides at the supplied time before deciding access', async () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const findUnique = vi.fn().mockResolvedValue({
      role: 'ADMIN',
      organizationRole: null,
      permissionOverrides: [],
    });
    const db = { user: { findUnique } } as unknown as ScopedDb;
    expect(await actorCanProcure(db, 'actor', now)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'actor', status: 'ACTIVE' },
        select: expect.objectContaining({
          permissionOverrides: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            select: { capability: true, effect: true },
          },
        }),
      })
    );
  });
});
