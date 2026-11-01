import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const h = vi.hoisted(() => ({ platform: vi.fn(), tenant: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: h.platform, withTenantDb: h.tenant }));
import {
  exchangePrintBridgeEnrollmentCode as exchange,
  issuePrintBridgeEnrollmentCode as issue,
} from './print-bridge-enrollment';
import { enrollPrintBridgeWithinCommercialLimits } from './commercial-limits';
type Device = {
  id: string;
  kind: string;
  status: string;
  revokedAt: Date | null;
  deviceSecretHash: string;
};
type Enrollment = {
  id: string;
  deviceId: string;
  issuedDeviceSecretHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};
let device: Device | undefined;
let enrollment: Enrollment | undefined;
let clock: Date;
let failConsume: boolean;
const code = `pbe_${'A'.repeat(32)}`;
const order: string[] = [];
const raw = vi.fn(async (parts: TemplateStringsArray | Prisma.Sql) => {
  const sql = 'strings' in parts ? parts.strings.join('?') : parts.join('?');
  if (sql.includes('FROM restaurant_print_bridge_enrollment_codes')) {
    order.push('code-lock');
    return enrollment ? [enrollment] : [];
  }
  if (sql.includes('FROM restaurant_registered_devices')) {
    order.push('device-lock');
    return device ? [device] : [];
  }
  order.push('org-lock');
  return [{ id: 'org' }];
});
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: 'code',
  ...data,
}));
const update = vi.fn(async ({ data }: { data: Partial<Device> }) => {
  Object.assign(device!, data);
  return device;
});
const consume = vi.fn(async ({ data }: { data: Partial<Enrollment> }) => {
  if (failConsume) throw new Error('write failed');
  Object.assign(enrollment!, data);
  return enrollment;
});
const count = vi.fn(async () => 0);
const deviceCreate = vi.fn(async ({ data }: { data: Device }) => {
  device = { ...data, id: 'new', status: 'ACTIVE', revokedAt: null };
  return device;
});
const tx = {
  $queryRaw: raw,
  restaurantRegisteredDevice: { update, count, create: deviceCreate },
  restaurantPrintBridgeEnrollmentCode: { create, update: consume },
  restaurantBranch: { findUnique: vi.fn(async () => ({ id: 'branch' })) },
};
async function transaction<T>(fn: (db: typeof tx) => Promise<T>): Promise<T> {
  const priorDevice = device && { ...device };
  const priorEnrollment = enrollment && { ...enrollment };
  try {
    return await fn(tx);
  } catch (error) {
    device = priorDevice;
    enrollment = priorEnrollment;
    throw error;
  }
}
const db = { $transaction: transaction, ...tx } as unknown as ScopedDb;
beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  failConsume = false;
  clock = new Date('2026-10-14T00:00:00Z');
  device = {
    id: 'bridge',
    kind: 'PRINT_BRIDGE',
    status: 'ACTIVE',
    revokedAt: null,
    deviceSecretHash: 'bootstrap',
  };
  enrollment = {
    id: 'code',
    deviceId: 'bridge',
    issuedDeviceSecretHash: 'bootstrap',
    expiresAt: new Date(clock.getTime() + 60_000),
    usedAt: null,
  };
  h.platform.mockImplementation(async (fn) =>
    fn({
      restaurantPrintBridgeEnrollmentCode: { findUnique: async () => ({ organizationId: 'org' }) },
    })
  );
  h.tenant.mockImplementation(async (_org, fn) => transaction(fn));
  count.mockResolvedValue(0);
});
describe('one-use enrollment source transaction contract (mock database)', () => {
  it('issues an opaque code and stores only its hash bound to the locked device secret', async () => {
    const result = await issue(tx as unknown as Prisma.TransactionClient, 'bridge', () => clock);
    expect(result.code).toMatch(/^pbe_[A-Za-z0-9_-]{32}$/);
    expect(result.expiresAt.getTime()).toBe(clock.getTime() + 600_000);
    expect(create).toHaveBeenCalledWith({
      data: {
        deviceId: 'bridge',
        codeHash: createHash('sha256').update(result.code).digest('hex'),
        issuedDeviceSecretHash: 'bootstrap',
        expiresAt: result.expiresAt,
      },
    });
    expect(order).toEqual(['device-lock']);
  });
  it('locks code then device, rotates and consumes once in its discovered tenant', async () => {
    const result = await exchange(code, () => clock);
    expect(result).toMatchObject({ deviceId: 'bridge', token: expect.stringMatching(/^rdk_/) });
    expect(h.tenant).toHaveBeenCalledWith('org', expect.any(Function));
    expect(order).toEqual(['code-lock', 'device-lock']);
    expect(device!.deviceSecretHash).toBe(createHash('sha256').update(result!.token).digest('hex'));
    expect(enrollment!.usedAt).toEqual(clock);
    await expect(exchange(code, () => clock)).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'pbe_short', `pbe_${'A'.repeat(33)}`, `${code}\n`])(
    'rejects malformed code before platform discovery: %j',
    async (input) => {
      await expect(exchange(input)).resolves.toBeNull();
      expect(h.platform).not.toHaveBeenCalled();
    }
  );
  it('rejects unknown discovery without opening a tenant transaction', async () => {
    h.platform.mockResolvedValue(null);
    await expect(exchange(code)).resolves.toBeNull();
    expect(h.tenant).not.toHaveBeenCalled();
  });
  it.each([
    'missing-code',
    'used',
    'missing-device',
    'revoked',
    'wrong-kind',
    'rotated',
    'expired',
  ] as const)('refuses %s without a mutation', async (condition) => {
    if (condition === 'missing-code') enrollment = undefined;
    if (condition === 'used') enrollment!.usedAt = clock;
    if (condition === 'missing-device') device = undefined;
    if (condition === 'revoked') device!.revokedAt = clock;
    if (condition === 'wrong-kind') device!.kind = 'POS';
    if (condition === 'rotated') device!.deviceSecretHash = 'rotated';
    if (condition === 'expired') enrollment!.expiresAt = clock;
    await expect(exchange(code, () => clock)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
  it('checks the clock after both locks, rejecting a code that expired while waiting', async () => {
    const readClock = vi.fn(() => {
      expect(order).toEqual(['code-lock', 'device-lock']);
      return new Date(clock.getTime() + 120_000);
    });
    await expect(exchange(code, readClock)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
  it('lets consumption failure escape the owning transaction so its rotation rolls back', async () => {
    failConsume = true;
    await expect(exchange(code, () => clock)).rejects.toThrow('write failed');
    expect(update).toHaveBeenCalledOnce();
    expect(device!.deviceSecretHash).toBe('bootstrap');
    expect(enrollment!.usedAt).toBeNull();
  });
  it.each(['POS', 'KDS'])('cannot issue a bridge code for %s', async (kind) => {
    device!.kind = kind;
    await expect(issue(tx as unknown as Prisma.TransactionClient, 'bridge')).rejects.toThrow(
      'cannot be enrolled'
    );
    expect(create).not.toHaveBeenCalled();
  });
});
describe('new bridge commercial admission', () => {
  it('takes the org lock and counts every active device before atomic device/code creation', async () => {
    const result = await enrollPrintBridgeWithinCommercialLimits(
      db,
      { 'pos.registeredDevices.max': 2, 'pos.terminals.max': 0 },
      { branchId: 'branch', name: 'Kitchen bridge' }
    );
    expect(count).toHaveBeenCalledExactlyOnceWith({ where: { status: 'ACTIVE' } });
    expect(order).toEqual(['org-lock', 'device-lock']);
    expect(result.device).toMatchObject({
      kind: 'PRINT_BRIDGE',
      branchId: 'branch',
      stationId: null,
    });
    expect(result.enrollment.code).toMatch(/^pbe_/);
  });
  it.each([0, 2])('denies exhausted registered-device limit %i without writes', async (limit) => {
    count.mockResolvedValue(2);
    await expect(
      enrollPrintBridgeWithinCommercialLimits(
        db,
        { 'pos.registeredDevices.max': limit },
        { branchId: 'branch', name: 'Bridge' }
      )
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    expect(deviceCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('fails closed for missing configuration before opening a transaction', async () => {
    await expect(
      enrollPrintBridgeWithinCommercialLimits(db, {}, { branchId: 'branch', name: 'Bridge' })
    ).rejects.toMatchObject({ reason: 'UNCONFIGURED' });
    expect(raw).not.toHaveBeenCalled();
  });
  it('does not leave a new device after issuance fails', async () => {
    create.mockRejectedValueOnce(new Error('issue failed'));
    await expect(
      enrollPrintBridgeWithinCommercialLimits(
        db,
        { 'pos.registeredDevices.max': 2 },
        { branchId: 'branch', name: 'Bridge' }
      )
    ).rejects.toThrow('issue failed');
    expect(device!.id).toBe('bridge');
  });
});
