import { describe, expect, it, vi } from 'vitest';

import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

import { actorCanProcure, procurementCapabilityGranted } from './procurement-access';

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

it('never lets an override ALLOW outrun a role DENY on either procurement alias', () => {
  expect(
    procurementCapabilityGranted({
      overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      role: [{ capability: 'pharmacy.procurement', effect: 'DENY' }],
    })
  ).toBe(false);
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
                status: 'ACTIVE',
                organizationId: 'org',
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
      status: 'ACTIVE',
      organizationId: 'org',
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
