import { describe, expect, it, vi } from 'vitest';

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

  it('lets a canonical pharmacy wildcard through and lets DENY win', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy.procurement', effect: 'DENY' }],
        role: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
      })
    ).toBe(false);
  });

  it('keeps a role DENY above a user ALLOW for procurement', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
        role: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
      })
    ).toBe(false);
  });
});

it('grants Goods-in to role-less ADMIN but respects an explicit denial', () => {
  expect(procurementCapabilityGranted({ overrides: [], role: [], rolelessAdmin: true })).toBe(true);
  expect(
    procurementCapabilityGranted({
      overrides: [{ capability: '*', effect: 'DENY' }],
      role: [],
      rolelessAdmin: true,
    })
  ).toBe(false);
});

it.each(['ADMIN', 'EMPLOYEE'])(
  'derives role-less Goods-in access from the persisted %s role',
  async (role) => {
    const db = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ role, organizationRole: null, permissionOverrides: [] }),
      },
    };
    await expect(actorCanProcure(db as never, 'actor')).resolves.toBe(role === 'ADMIN');
  }
);
