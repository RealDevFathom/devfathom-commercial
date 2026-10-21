import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ organization: { findMany: mocks.findMany, findFirst: mocks.findFirst } }),
}));

import {
  createDemoAccessGrant,
  demoAccessCodeMatches,
  getDemoSeatOptions,
  readDemoAccessGrant,
  resolveDemoSeat,
} from './access';
import {
  DEMO_PERSONA_KEYS,
  DEMO_PERSONAS,
  demoPersonaEmail,
  demoPersonaUserId,
  demoPersonaUserRole,
} from './personas';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const HOST = 'www.devfathom.com';

function organization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org_demo_restaurant_seat_1',
    slug: 'demo-restaurant-seat-1',
    displayName: 'Demo Restaurant — Seat 1',
    status: 'ACTIVE',
    vertical: 'RESTAURANT',
    deploymentMode: 'SHARED',
    isDemo: true,
    users: [
      {
        id: 'user_demo_restaurant_seat_1_manager',
        email: 'manager.seat1@demo.devfathom.invalid',
        password: null,
        status: 'ACTIVE',
        role: 'ADMIN',
        organizationId: 'org_demo_restaurant_seat_1',
        organizationRole: { key: 'owner' },
        restaurantStaffProfiles: [{ id: 'manager_staff' }],
      },
    ],
    ...overrides,
  };
}

describe('demo access grant', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'test-demo-signing-secret');
    vi.stubEnv('DEMO_ACCESS_CODE', 'correct horse battery staple');
    vi.stubEnv('DEMO_SEATS', '5');
    mocks.findMany.mockReset();
    mocks.findFirst.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('binds the signed absolute expiry to the seat and host', () => {
    const grant = createDemoAccessGrant({
      organizationId: 'org_demo_restaurant_seat_2',
      seat: 2,
      host: HOST,
      now: NOW,
    });

    expect(grant.expiresAt.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(
      readDemoAccessGrant(grant.value, HOST, new Date('2026-09-04T23:59:59.999Z'))
    ).toMatchObject({
      organizationId: 'org_demo_restaurant_seat_2',
      seat: 2,
      expiresAt: grant.expiresAt.getTime(),
    });
    expect(readDemoAccessGrant(grant.value, 'tenant.devfathom.com', NOW)).toBeNull();
    expect(readDemoAccessGrant(grant.value, HOST, grant.expiresAt)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const grant = createDemoAccessGrant({
      organizationId: 'org_demo_restaurant_seat_1',
      seat: 1,
      host: HOST,
      now: NOW,
    });
    const [payload, signature] = grant.value.split('.');
    const tampered = `${payload}.${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;

    expect(readDemoAccessGrant(tampered, HOST, NOW)).toBeNull();
  });

  it('compares the configured access code without returning a partial match', () => {
    expect(demoAccessCodeMatches('correct horse battery staple')).toBe(true);
    expect(demoAccessCodeMatches('correct horse')).toBe(false);
  });

  it('marks a seat ready only for the exact shared demo organization and manager', async () => {
    mocks.findMany.mockResolvedValue([
      organization(),
      organization({
        id: 'org_demo_restaurant_seat_2',
        slug: 'demo-restaurant-seat-2',
        displayName: 'Demo Restaurant — Seat 2',
        deploymentMode: 'DEDICATED',
        users: [
          {
            id: 'user_demo_restaurant_seat_2_manager',
            email: 'manager.seat2@demo.devfathom.invalid',
            password: null,
            status: 'ACTIVE',
            role: 'ADMIN',
          },
        ],
      }),
    ]);

    expect(
      (await getDemoSeatOptions()).map(({ seat, name, ready }) => ({ seat, name, ready }))
    ).toEqual([
      { seat: 1, name: 'Demo Restaurant — Seat 1', ready: true },
      { seat: 2, name: 'Demo Restaurant — Seat 2', ready: false },
      { seat: 3, name: 'Demo Restaurant — Seat 3', ready: false },
      { seat: 4, name: 'Demo Restaurant — Seat 4', ready: false },
      { seat: 5, name: 'Demo Restaurant — Seat 5', ready: false },
    ]);
  });

  it('resolves only the exact seeded manager inside the flagged organization', async () => {
    mocks.findFirst.mockResolvedValue(organization());

    await expect(resolveDemoSeat(1)).resolves.toMatchObject({
      organizationId: 'org_demo_restaurant_seat_1',
      managerUserId: 'user_demo_restaurant_seat_1_manager',
      managerEmail: 'manager.seat1@demo.devfathom.invalid',
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'org_demo_restaurant_seat_1',
          slug: 'demo-restaurant-seat-1',
          isDemo: true,
          deploymentMode: 'SHARED',
        }),
      })
    );
  });

  it.each(DEMO_PERSONA_KEYS)(
    'resolves the canonical %s without accepting a supplied user identity',
    async (persona) => {
      const user = {
        ...organization().users[0]!,
        id: demoPersonaUserId(1, persona),
        email: demoPersonaEmail(1, persona),
        role: demoPersonaUserRole(persona),
        organizationRole: { key: DEMO_PERSONAS[persona].roleKey },
      };
      mocks.findFirst.mockResolvedValue(organization({ users: [user] }));
      await expect(resolveDemoSeat(1, persona)).resolves.toMatchObject({
        persona,
        userId: user.id,
        email: user.email,
      });
      for (const invalid of [
        { password: 'hash' },
        { status: 'SUSPENDED' },
        { id: demoPersonaUserId(2, persona) },
        { organizationRole: { key: 'general-manager' } },
        { restaurantStaffProfiles: [] },
        { restaurantStaffProfiles: [{ id: 'a' }, { id: 'b' }] },
      ]) {
        mocks.findFirst.mockResolvedValue(organization({ users: [{ ...user, ...invalid }] }));
        await expect(resolveDemoSeat(1, persona)).resolves.toBeNull();
      }
    }
  );

  it.each([
    { isDemo: false },
    { deploymentMode: 'DEDICATED' },
    { vertical: 'AGENCY' },
    { status: 'SUSPENDED' },
    { id: 'org_production' },
    { slug: 'production' },
  ])('rejects changed seat state %j', async (state) => {
    mocks.findFirst.mockResolvedValue(organization(state));
    await expect(resolveDemoSeat(1)).resolves.toBeNull();
  });

  it('rejects unsupported personas, seats and production grants before DB access', async () => {
    for (const seat of [0, -1, 1.5, 26, NaN])
      await expect(resolveDemoSeat(seat)).resolves.toBeNull();
    await expect(resolveDemoSeat(1, 'admin' as never)).resolves.toBeNull();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(() =>
      createDemoAccessGrant({ organizationId: 'org_production', seat: 1, host: HOST, now: NOW })
    ).toThrow('canonical demo seat');
  });
});
