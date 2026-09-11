import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  demoManagerEmail,
  demoManagerId,
  demoOrganizationId,
  demoSeatFromOrganizationId,
  demoSeatName,
  demoSeatSlug,
  getDemoSeatCount,
} from './config';

afterEach(() => vi.unstubAllEnvs());

describe('demo configuration', () => {
  it('uses the stable seeded identity contract', () => {
    expect({
      organizationId: demoOrganizationId(3),
      slug: demoSeatSlug(3),
      managerId: demoManagerId(3),
      managerEmail: demoManagerEmail(3),
      name: demoSeatName(3),
    }).toEqual({
      organizationId: 'org_demo_restaurant_seat_3',
      slug: 'demo-restaurant-seat-3',
      managerId: 'user_demo_restaurant_seat_3_manager',
      managerEmail: 'manager.seat3@demo.devfathom.invalid',
      name: 'Demo Restaurant — Seat 3',
    });
    expect(demoSeatFromOrganizationId('org_demo_restaurant_seat_3')).toBe(3);
  });

  it.each(['5junk', '2.5', '0', '26', '', 'NaN'])(
    'rejects malformed DEMO_SEATS=%s instead of partially parsing it',
    (value) => {
      vi.stubEnv('DEMO_SEATS', value);
      expect(getDemoSeatCount()).toBe(5);
    }
  );

  it('accepts a bounded integer seat count', () => {
    vi.stubEnv('DEMO_SEATS', '12');
    expect(getDemoSeatCount()).toBe(12);
  });
});
