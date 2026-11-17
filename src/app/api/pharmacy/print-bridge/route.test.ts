// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  hasModule: vi.fn(),
  rateLimit: vi.fn(),
  resolvePharmacyPrintBridge: vi.fn(),
  touchPharmacyPrintBridge: vi.fn(),
  claimNextPharmacyPrintJob: vi.fn(),
  acknowledgePharmacyPrintJob: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
  hasModule: mocks.hasModule,
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit, clientIp: () => '203.0.113.5' }));
vi.mock('@/lib/pharmacy/receipt-print-queue', async (original) => {
  const actual = await original<typeof import('@/lib/pharmacy/receipt-print-queue')>();
  return {
    ...actual,
    resolvePharmacyPrintBridge: mocks.resolvePharmacyPrintBridge,
    touchPharmacyPrintBridge: mocks.touchPharmacyPrintBridge,
    claimNextPharmacyPrintJob: mocks.claimNextPharmacyPrintJob,
    acknowledgePharmacyPrintJob: mocks.acknowledgePharmacyPrintJob,
  };
});

import { GET, POST } from './route';

const ORG = 'org_pharmacy_a';
const credential = `ppb_${'C'.repeat(43)}.${Buffer.from(ORG).toString('base64url')}`;
const bridge = {
  id: 'bridge_1',
  organizationId: ORG,
  branchId: 'branch_a',
  printerId: 'tcp://192.0.2.10:9100',
  status: 'ACTIVE',
  revokedAt: null,
};
const db = {
  $queryRaw: vi.fn(),
  pharmacyBranch: {
    findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'branch_a' })),
  },
};

function request(
  method: 'GET' | 'POST',
  init: { token?: string; body?: unknown; wait?: string } = {}
) {
  const url = new URL('https://app.example/api/pharmacy/print-bridge');
  if (init.wait !== undefined) url.searchParams.set('wait', init.wait);
  return new Request(url, {
    method,
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ id: bridge.id }]);
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (tx: unknown) => unknown) =>
    run(db)
  );
  mocks.resolveOrganizationEntitlements.mockResolvedValue({});
  mocks.hasModule.mockReturnValue(true);
  mocks.resolvePharmacyPrintBridge.mockResolvedValue(bridge);
  db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
});

describe('pharmacy print bridge transport', () => {
  it.each(['GET', 'POST'] as const)(
    'refuses %s when revocation wins after credential lookup',
    async (method) => {
      db.$queryRaw.mockResolvedValueOnce([]);
      const req = request(method, {
        token: credential,
        wait: '0',
        ...(method === 'POST'
          ? { body: { jobId: 'job-1', claimToken: 'a'.repeat(64), status: 'TRANSPORT_ACCEPTED' } }
          : {}),
      });
      const response = await (method === 'GET' ? GET(req) : POST(req));
      expect(response.status).toBe(403);
      expect(mocks.claimNextPharmacyPrintJob).not.toHaveBeenCalled();
      expect(mocks.acknowledgePharmacyPrintJob).not.toHaveBeenCalled();
    }
  );

  it('refuses requests without a well-formed pharmacy bridge credential', async () => {
    for (const token of [undefined, 'rdk_restaurant_token', `pcd_${'C'.repeat(43)}`, 'ppb_bad']) {
      const response = await GET(request('GET', { token, wait: '0' }));
      expect(response.status).toBe(401);
    }
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('opens only the credential tenant and returns a claimed job', async () => {
    mocks.claimNextPharmacyPrintJob.mockResolvedValue({ id: 'job_1', attempt: 1 });
    const response = await GET(request('GET', { token: credential, wait: '0' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: { id: 'job_1', attempt: 1 } });
    expect(mocks.withTenantDb).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(mocks.resolvePharmacyPrintBridge).toHaveBeenCalledWith(db, {
      secret: credential.split('.')[0],
      organizationId: ORG,
    });
    expect(mocks.touchPharmacyPrintBridge).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 204 when there is no work', async () => {
    mocks.claimNextPharmacyPrintJob.mockResolvedValue(null);
    const response = await GET(request('GET', { token: credential, wait: '0' }));
    expect(response.status).toBe(204);
  });

  it('refuses an unknown, revoked, unlicensed or branch-inactive bridge before claiming', async () => {
    mocks.resolvePharmacyPrintBridge.mockResolvedValueOnce(null);
    expect((await GET(request('GET', { token: credential, wait: '0' }))).status).toBe(401);
    mocks.resolvePharmacyPrintBridge.mockResolvedValueOnce({
      ...bridge,
      status: 'REVOKED',
      revokedAt: new Date(),
    });
    expect((await GET(request('GET', { token: credential, wait: '0' }))).status).toBe(403);
    mocks.hasModule.mockReturnValueOnce(false);
    expect((await GET(request('GET', { token: credential, wait: '0' }))).status).toBe(403);
    db.pharmacyBranch.findFirst.mockResolvedValueOnce(null);
    expect((await GET(request('GET', { token: credential, wait: '0' }))).status).toBe(403);
    expect(mocks.claimNextPharmacyPrintJob).not.toHaveBeenCalled();
  });

  it('rate limits before any tenant work', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: false });
    expect((await GET(request('GET', { token: credential, wait: '0' }))).status).toBe(429);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('accepts only the strict acknowledgement shape', async () => {
    const claimToken = 'a'.repeat(64);
    for (const body of [
      { jobId: 'job_1', claimToken, status: 'PRINTED' },
      { jobId: 'job_1', claimToken: 'short', status: 'TRANSPORT_ACCEPTED' },
      { jobId: 'job_1', claimToken, status: 'TRANSPORT_ACCEPTED', failureCode: 'TRANSPORT_FAILED' },
      { jobId: 'job_1', claimToken, status: 'FAILED', failureCode: 'ANYTHING' },
      { jobId: 'job_1', claimToken, status: 'FAILED', document: { lines: [] } },
    ]) {
      expect((await POST(request('POST', { token: credential, body }))).status).toBe(400);
    }
    expect(mocks.acknowledgePharmacyPrintJob).not.toHaveBeenCalled();

    mocks.acknowledgePharmacyPrintJob.mockResolvedValueOnce({
      acknowledged: true,
      replayed: false,
    });
    const ok = await POST(
      request('POST', {
        token: credential,
        body: { jobId: 'job_1', claimToken, status: 'FAILED', failureCode: 'TRANSPORT_FAILED' },
      })
    );
    expect(ok.status).toBe(200);
    expect(mocks.acknowledgePharmacyPrintJob).toHaveBeenCalledWith(db, bridge, {
      jobId: 'job_1',
      claimToken,
      outcome: 'FAILED',
      failureCode: 'TRANSPORT_FAILED',
      now: expect.any(Date),
    });

    mocks.acknowledgePharmacyPrintJob.mockResolvedValueOnce({
      acknowledged: false,
      replayed: false,
    });
    const missing = await POST(
      request('POST', {
        token: credential,
        body: { jobId: 'job_1', claimToken, status: 'TRANSPORT_ACCEPTED' },
      })
    );
    expect(missing.status).toBe(404);
  });

  it('hides internal errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.claimNextPharmacyPrintJob.mockRejectedValueOnce(new Error('secret receipt text'));
    const response = await GET(request('GET', { token: credential, wait: '0' }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret receipt text');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret receipt text');
  });
});
