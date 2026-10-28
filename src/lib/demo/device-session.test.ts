import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  rotate: vi.fn(),
  establish: vi.fn(),
  bind: vi.fn(),
  resolveDevice: vi.fn(),
  resolveSession: vi.fn(),
  lock: vi.fn(),
  organization: vi.fn(),
  staff: vi.fn(),
  device: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.capability,
}));
vi.mock('@/lib/restaurant/devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/devices')>()),
  resolveDeviceBySecret: mocks.resolveDevice,
  rotateDeviceSecret: mocks.rotate,
}));
vi.mock('@/lib/restaurant/terminal-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/terminal-session')>()),
  establishSession: mocks.establish,
  bindOperator: mocks.bind,
  resolveSessionByToken: mocks.resolveSession,
}));

import { hashDeviceSecret } from '@/lib/restaurant/devices';
import { demoTerminalCookieOptions, prepareDemoDeviceSession } from './device-session';
import {
  DEMO_PERSONA_KEYS,
  DEMO_PERSONAS,
  demoPersonaUserId,
  demoPersonaEmail,
  demoPersonaUserRole,
} from './personas';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const user = {
  id: 'user_demo_restaurant_seat_1_manager',
  email: 'manager.seat1@demo.devfathom.invalid',
  organizationId: 'org_demo_restaurant_seat_1',
  role: 'ADMIN',
  demoAccessExpiresAt: NOW.getTime() + 60_000,
};
const db = {
  $executeRaw: mocks.lock,
  organization: { findFirst: mocks.organization },
  restaurantStaffProfile: { findMany: mocks.staff },
  restaurantRegisteredDevice: { findFirst: mocks.device },
};
const activeDevice = {
  id: 'device_1',
  organizationId: 'org_demo_restaurant_seat_1',
  branchId: 'branch_1',
  name: 'Front counter',
  deviceSecretHash: 'current-hash',
  status: 'ACTIVE' as const,
  kind: 'POS' as const,
  stationId: null,
  lastSeenAt: null,
  revokedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const existingSession = {
  id: 'session_existing',
  organizationId: 'org_demo_restaurant_seat_1',
  deviceId: 'device_1',
  activeStaffProfileId: 'staff_1',
  tokenHash: 'existing-token-hash',
  establishedAt: NOW,
  lastActivityAt: NOW,
  endedAt: null,
  updatedAt: NOW,
};
const existing = { deviceSecret: 'rdk_existing', sessionToken: 'rts_existing' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lock.mockResolvedValue(0);
  mocks.organization.mockResolvedValue({
    id: 'org_demo_restaurant_seat_1',
    isDemo: true,
    slug: 'demo-restaurant-seat-1',
    status: 'ACTIVE',
    vertical: 'RESTAURANT',
    deploymentMode: 'SHARED',
  });
  mocks.staff.mockResolvedValue([
    {
      id: 'staff_1',
      displayName: 'Demo Manager',
      primaryBranchId: 'branch_1',
      user: { title: 'General manager', organizationRole: { name: 'Administrator' } },
    },
  ]);
  mocks.capability.mockResolvedValue(true);
  mocks.device.mockResolvedValue({
    id: 'device_1',
    branchId: 'branch_1',
    name: 'Front counter',
    kind: 'POS',
    stationId: null,
    deviceSecretHash: 'old-hash',
    branch: { name: 'Main branch' },
  });
  mocks.resolveDevice.mockResolvedValue(null);
  mocks.resolveSession.mockResolvedValue(null);
  mocks.rotate.mockResolvedValue({ device: activeDevice, secret: 'raw-device-secret' });
  mocks.establish.mockResolvedValue({
    session: { id: 'session_1' },
    token: 'terminal-session-token',
  });
  mocks.bind.mockResolvedValue({ id: 'session_1', establishedAt: NOW });
});

describe('demo device session recovery', () => {
  it.each(DEMO_PERSONA_KEYS)('prepares only the supported %s device context', async (persona) => {
    const actor = {
      ...user,
      id: demoPersonaUserId(1, persona),
      email: demoPersonaEmail(1, persona),
      role: demoPersonaUserRole(persona),
    };
    const kind = DEMO_PERSONAS[persona].deviceKind;
    const prepared = await prepareDemoDeviceSession(
      db as never,
      actor as never,
      kind ?? 'POS',
      NOW
    );
    if (kind) {
      expect(prepared?.session.activeStaffProfileId).toBe('staff_1');
      expect(mocks.staff).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: actor.id,
            user: expect.objectContaining({
              role: actor.role,
              organizationRole: { key: DEMO_PERSONAS[persona].roleKey },
            }),
          }),
        })
      );
      expect(mocks.device).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kind,
            name:
              persona === 'manager' ? { startsWith: 'Demo POS S1 ' } : `Demo ${persona} ${kind} S1`,
          }),
        })
      );
      expect(mocks.bind).toHaveBeenCalledWith(db, 'session_1', 'staff_1', NOW);
    } else {
      expect(prepared).toBeNull();
      expect(mocks.rotate).not.toHaveBeenCalled();
      expect(mocks.bind).not.toHaveBeenCalled();
    }
  });

  it('rejects an expired actor, wrong device kind, unknown persona, or duplicate staff before issuance', async () => {
    const waiter = {
      ...user,
      id: demoPersonaUserId(1, 'waiter'),
      email: demoPersonaEmail(1, 'waiter'),
      role: 'EMPLOYEE',
    };
    expect(await prepareDemoDeviceSession(db as never, waiter as never, 'KDS', NOW)).toBeNull();
    expect(
      await prepareDemoDeviceSession(
        db as never,
        { ...user, demoAccessExpiresAt: NOW.getTime() } as never,
        'POS',
        NOW
      )
    ).toBeNull();
    expect(
      await prepareDemoDeviceSession(
        db as never,
        { ...user, id: 'user_other' } as never,
        'POS',
        NOW
      )
    ).toBeNull();
    mocks.staff.mockResolvedValue([
      { id: 'a', primaryBranchId: 'branch_1' },
      { id: 'b', primaryBranchId: 'branch_1' },
    ]);
    expect(await prepareDemoDeviceSession(db as never, user as never, 'POS', NOW)).toBeNull();
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('replaces a carried terminal session belonging to another persona', async () => {
    mocks.resolveDevice.mockResolvedValue(activeDevice);
    mocks.resolveSession.mockResolvedValue({
      ...existingSession,
      activeStaffProfileId: 'other_persona_staff',
    });
    await prepareDemoDeviceSession(db as never, user as never, 'POS', NOW, existing);
    expect(mocks.establish).toHaveBeenCalledWith(db, 'device_1', NOW);
    expect(mocks.bind).toHaveBeenCalledWith(db, 'session_1', 'staff_1', NOW);
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it('uses trusted product issuance and binds the exact seeded manager', async () => {
    const result = await prepareDemoDeviceSession(db as never, user as never, 'POS', NOW);

    expect(mocks.capability.mock.calls).toEqual([
      [db, 'staff_1', 'terminal:operate', NOW, 'branch_1'],
      [db, 'staff_1', 'pos:operate', NOW, 'branch_1'],
      [db, 'staff_1', 'orders:complimentary', NOW, 'branch_1'],
    ]);
    expect(mocks.lock.mock.calls[0]?.[1]).toBe(
      'demo-device-session:org_demo_restaurant_seat_1:manager:POS'
    );
    expect(mocks.lock.mock.calls[0]?.[0].join('')).not.toContain('org_demo_restaurant_seat_1');
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.device.mock.invocationCallOrder[0]!
    );
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rotate.mock.invocationCallOrder[0]!
    );
    expect(mocks.rotate).toHaveBeenCalledWith(db, 'device_1', 'old-hash');
    expect(mocks.establish).toHaveBeenCalledWith(db, 'device_1', NOW);
    expect(mocks.bind).toHaveBeenCalledWith(db, 'session_1', 'staff_1', NOW);
    expect(result).toMatchObject({
      deviceSecret: 'raw-device-secret',
      branchId: 'branch_1',
      sessionToken: 'terminal-session-token',
      session: { state: 'UNLOCKED', activeStaffProfileId: 'staff_1' },
      operator: { staffProfileId: 'staff_1', displayName: 'Demo Manager', canComp: true },
    });
  });

  it('reuses a valid device and bound operator session on repeated preparation', async () => {
    mocks.resolveDevice.mockResolvedValue(activeDevice);
    mocks.resolveSession.mockResolvedValue(existingSession);

    const first = await prepareDemoDeviceSession(db as never, user as never, 'POS', NOW, existing);
    const second = await prepareDemoDeviceSession(db as never, user as never, 'POS', NOW, existing);

    expect([first, second]).toEqual([
      expect.objectContaining({
        deviceSecret: existing.deviceSecret,
        sessionToken: existing.sessionToken,
        session: expect.objectContaining({ id: existingSession.id, state: 'UNLOCKED' }),
      }),
      expect.objectContaining({
        deviceSecret: existing.deviceSecret,
        sessionToken: existing.sessionToken,
        session: expect.objectContaining({ id: existingSession.id, state: 'UNLOCKED' }),
      }),
    ]);
    expect(mocks.resolveDevice).toHaveBeenCalledTimes(2);
    expect(mocks.resolveDevice).toHaveBeenCalledWith(db, existing.deviceSecret);
    expect(mocks.resolveSession).toHaveBeenCalledTimes(2);
    expect(mocks.resolveSession).toHaveBeenCalledWith(db, existing.sessionToken);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('keeps concurrent duplicates on the same valid device and operator session', async () => {
    mocks.resolveDevice.mockResolvedValue(activeDevice);
    mocks.resolveSession.mockResolvedValue(existingSession);

    const results = await Promise.all([
      prepareDemoDeviceSession(db as never, user as never, 'POS', NOW, existing),
      prepareDemoDeviceSession(db as never, user as never, 'POS', NOW, existing),
    ]);

    expect(results.map((result) => result?.sessionToken)).toEqual([
      existing.sessionToken,
      existing.sessionToken,
    ]);
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.establish).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('serializes concurrent first preparations and leaves the last returned secret valid', async () => {
    let lockTail = Promise.resolve();
    let currentSecret = 'rdk_seed';
    let currentHash = hashDeviceSecret(currentSecret);
    let generation = 0;
    const completed: string[] = [];

    mocks.device.mockImplementation(async () => ({
      id: 'device_1',
      branchId: 'branch_1',
      name: 'Front counter',
      kind: 'POS',
      stationId: null,
      deviceSecretHash: currentHash,
      branch: { name: 'Main branch' },
    }));
    mocks.rotate.mockImplementation(async (_db, _deviceId, expectedHash) => {
      expect(expectedHash).toBe(currentHash);
      generation += 1;
      currentSecret = `rdk_serial_${generation}`;
      currentHash = hashDeviceSecret(currentSecret);
      return {
        device: { ...activeDevice, deviceSecretHash: currentHash },
        secret: currentSecret,
      };
    });
    mocks.establish.mockImplementation(async () => ({
      session: { id: `session_${generation}` },
      token: `rts_serial_${generation}`,
    }));
    mocks.bind.mockImplementation(async (_db, sessionId) => ({
      id: sessionId,
      establishedAt: NOW,
    }));

    async function runTransaction() {
      const waitForLock = lockTail;
      let releaseLock!: () => void;
      lockTail = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const transactionDb = {
        ...db,
        $executeRaw: (...args: unknown[]) => {
          mocks.lock(...args);
          return waitForLock.then(() => 0);
        },
      };
      try {
        const result = await prepareDemoDeviceSession(
          transactionDb as never,
          user as never,
          'POS',
          NOW
        );
        completed.push(result!.deviceSecret);
        return result;
      } finally {
        releaseLock();
      }
    }

    const results = await Promise.all([runTransaction(), runTransaction(), runTransaction()]);

    expect(results.every(Boolean)).toBe(true);
    expect(completed).toEqual(['rdk_serial_1', 'rdk_serial_2', 'rdk_serial_3']);
    expect(results[2]?.deviceSecret).toBe(currentSecret);
    expect(hashDeviceSecret(results[2]!.deviceSecret)).toBe(currentHash);
    expect(mocks.rotate).toHaveBeenCalledTimes(3);
  });

  it('rejects any identity other than the exact seeded demo manager', async () => {
    await expect(
      prepareDemoDeviceSession(
        db as never,
        { ...user, email: 'other@example.test' } as never,
        'POS',
        NOW
      )
    ).resolves.toBeNull();

    expect(mocks.staff).not.toHaveBeenCalled();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it('does not bypass product capability checks', async () => {
    mocks.capability.mockImplementation(async (_db, _staffId, capability) => {
      return capability !== 'pos:operate';
    });

    await expect(
      prepareDemoDeviceSession(db as never, user as never, 'POS', NOW)
    ).resolves.toBeNull();
    expect(mocks.device).not.toHaveBeenCalled();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it('requires an active station-backed KDS device', async () => {
    mocks.device.mockResolvedValue({
      id: 'device_kds',
      branchId: 'branch_1',
      name: 'Expo screen',
      kind: 'KDS',
      stationId: 'station_1',
      deviceSecretHash: 'old-kds-hash',
      branch: { name: 'Main branch' },
    });

    await prepareDemoDeviceSession(db as never, user as never, 'KDS', NOW);

    expect(mocks.capability).toHaveBeenCalledWith(
      db,
      'staff_1',
      'kitchen:operate',
      NOW,
      'branch_1'
    );
    expect(mocks.lock.mock.calls[0]?.[1]).toBe(
      'demo-device-session:org_demo_restaurant_seat_1:manager:KDS'
    );
    expect(mocks.device).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: 'KDS', station: { active: true } }),
      })
    );
  });

  it('bounds the secure httpOnly device cookie by the demo grant', () => {
    const expiry = NOW.getTime() + 60 * 60_000;
    expect(demoTerminalCookieOptions(expiry, NOW)).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: new Date(expiry),
      maxAge: 60 * 60,
    });
    expect(demoTerminalCookieOptions(NOW.getTime(), NOW)).toBeNull();
    expect(demoTerminalCookieOptions(Number.NaN, NOW)).toBeNull();
    expect(demoTerminalCookieOptions(NOW.getTime() + 12 * 60 * 60_000 + 1, NOW)).toBeNull();
  });
});
