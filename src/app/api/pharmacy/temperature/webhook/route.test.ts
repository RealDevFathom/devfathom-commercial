import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  organization: vi.fn(),
  findDevice: vi.fn(),
  updateDevice: vi.fn(),
  ingest: vi.fn(),
  refresh: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'abbasi.pharmacy.localhost',
  resolveExplicitOrganizationByHost: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_organizationId: string, work: (db: unknown) => unknown) =>
    work({
      pharmacyTemperatureDevice: {
        findFirst: mocks.findDevice,
        update: mocks.updateDevice,
      },
    }),
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.10',
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
}));
vi.mock('@/lib/secret-crypto', () => ({ decryptSecret: mocks.decrypt }));
vi.mock('@/lib/pharmacy/temperature-log', () => ({
  SensorTemperatureReadingSource: class {
    readonly kind = 'SENSOR';
    constructor(readonly reading: unknown) {}
  },
  ingestTemperatureReadings: mocks.ingest,
}));
vi.mock('@/lib/pharmacy/stock-signals-operations', () => ({
  refreshStockSignals: mocks.refresh,
}));

import { MockTemperatureDeviceAdapter } from '@/lib/pharmacy/mock-temperature-device';
import { POST } from './route';

const NOW = new Date('2026-10-22T10:00:00.000Z');
const payload = {
  readingId: 'reading-001',
  temperatureC: 10.5,
  recordedAt: '2026-10-22T10:00:00.000Z',
};
const adapter = new MockTemperatureDeviceAdapter('sensor_key_001', 'device-secret', () => NOW);

describe('live pharmacy temperature sensor webhook', () => {
  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.setSystemTime(NOW);
    mocks.organization.mockResolvedValue({
      id: 'org-abbasi',
      isDemo: false,
      vertical: 'PHARMACY',
      status: 'ACTIVE',
    });
    mocks.findDevice.mockResolvedValue({
      id: 'device-1',
      organizationId: 'org-abbasi',
      branchId: 'branch-1',
      stockLocationId: 'fridge-1',
      encryptedSigningSecret: 'encrypted',
    });
    mocks.decrypt.mockReturnValue('device-secret');
    mocks.ingest.mockResolvedValue({ count: 1 });
    mocks.refresh.mockResolvedValue({ signals: [], raised: 0, refreshed: 0, closed: 0 });
  });

  it('rejects a bad HMAC signature before ingesting', async () => {
    const request = adapter.request(payload);
    request.headers.set('x-device-signature', '0'.repeat(64));

    expect((await POST(request)).status).toBe(401);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('does not authenticate a device registered to another tenant', async () => {
    // The org-scoped/RLS query cannot see a device belonging to another host tenant.
    mocks.findDevice.mockResolvedValue(null);

    expect((await POST(adapter.request(payload))).status).toBe(404);
    expect(mocks.findDevice).toHaveBeenCalledWith({
      where: { organizationId: 'org-abbasi', keyId: 'sensor_key_001', active: true },
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate device reading without raising alerts again', async () => {
    mocks.ingest.mockResolvedValue({ count: 0 });

    const response = await POST(adapter.request(payload));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true, duplicate: true });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.updateDevice).not.toHaveBeenCalled();
  });

  it('routes an accepted excursion through the existing cold-chain alert path', async () => {
    mocks.refresh.mockResolvedValue({
      signals: [{ id: 'signal-1', kind: 'COLD_CHAIN', dedupKey: 'cold-chain-1' }],
      raised: 1,
      refreshed: 0,
      closed: 0,
    });

    const response = await POST(adapter.request(payload));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      alertsRaised: 1,
    });
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-abbasi', branchId: 'branch-1' }),
      'fridge-1',
      expect.objectContaining({ kind: 'SENSOR' })
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
