// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  audit: vi.fn(),
  userFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  jobFindMany: vi.fn(),
  jobCreate: vi.fn(),
  getUpload: vi.fn(),
  putUpload: vi.fn(),
  session: {
    user: { id: 'u-owner', role: 'ADMIN', isSupportSession: false } as Record<string, unknown>,
  },
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: m.actor }));
vi.mock('@/server/audit', () => ({ recordAudit: m.audit }));
vi.mock('@/lib/storage', () => ({ getUpload: m.getUpload, putUpload: m.putUpload }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      platformJob: { findFirst: m.jobFindFirst, findMany: m.jobFindMany, create: m.jobCreate },
    }),
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: async () => ({
    session: m.session,
    organization: { id: 'org-a' },
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'] },
    requestMeta: { ip: '127.0.0.1', userAgent: 'vitest' },
    db: { user: { findFirst: m.userFindFirst } },
  }),
}));

import { GET, POST } from './route';

const OWNER = {
  role: 'ADMIN',
  status: 'ACTIVE',
  organizationRole: { key: 'owner', isSystem: true, permissions: [] },
  permissionOverrides: [],
};
const CASHIER = {
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  organizationRole: {
    key: 'cashier',
    isSystem: true,
    permissions: [{ capability: 'pharmacy.counter', effect: 'ALLOW' }],
  },
  permissionOverrides: [],
};

function post(body: unknown = {}) {
  return new Request('https://shop.example.com/api/pharmacy/data-export', {
    method: 'POST',
    headers: { origin: 'https://shop.example.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const get = (query = '') =>
  new Request(`https://shop.example.com/api/pharmacy/data-export${query}`);

const finished = (finishedAt: Date) => ({
  id: 'job-1',
  status: 'SUCCEEDED',
  createdAt: new Date(finishedAt.getTime() - 60_000),
  finishedAt,
  result: { rowCounts: { 'customers.csv': 3 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.session.user = { id: 'u-owner', role: 'ADMIN', isSupportSession: false };
  m.actor.mockResolvedValue({ session: m.session, organization: { id: 'org-a' } });
  m.audit.mockResolvedValue(undefined);
  m.userFindFirst.mockResolvedValue(OWNER);
  m.jobFindFirst.mockResolvedValue(null);
  m.jobCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'job-new',
    status: 'QUEUED',
    createdAt: new Date(),
    finishedAt: null,
    result: null,
    data,
  }));
});

describe('owner data export route', () => {
  it('refuses a non-owner with 403, queues nothing and audits the refusal', async () => {
    m.userFindFirst.mockResolvedValue(CASHIER);
    const response = await POST(post());
    expect(response.status).toBe(403);
    expect(m.jobCreate).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.request',
        statusCode: 403,
        outcome: 'FAILURE',
      }),
      expect.anything()
    );

    const download = await GET(get('?job=job-1'));
    expect(download.status).toBe(403);
    expect(m.getUpload).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN without the owner identity', async () => {
    m.userFindFirst.mockResolvedValue({ ...CASHIER, role: 'ADMIN' });
    expect((await POST(post())).status).toBe(403);
  });

  it('refuses a platform support session even on an owner account', async () => {
    m.session.user = { ...m.session.user, isSupportSession: true };
    expect((await POST(post())).status).toBe(403);
    expect(m.jobCreate).not.toHaveBeenCalled();
  });

  it('refuses a cross-site request', async () => {
    const request = new Request('https://shop.example.com/api/pharmacy/data-export', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect((await POST(request)).status).toBe(403);
  });

  it('queues the export as the owner, scoped to the session organization, and audits it', async () => {
    const response = await POST(post({ from: '2026-01-01', to: '2026-10-31' }));
    expect(response.status).toBe(202);
    expect(m.jobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-a',
          type: 'PHARMACY_OWNER_DATA_EXPORT_V1',
          requestedById: 'u-owner',
          payload: expect.objectContaining({ from: '2026-01-01', to: '2026-10-31' }),
        }),
      })
    );
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.request',
        organizationId: 'org-a',
        statusCode: 202,
      }),
      expect.anything()
    );
  });

  it('rejects an inverted date range', async () => {
    expect((await POST(post({ from: '2026-10-31', to: '2026-01-01' }))).status).toBe(400);
    expect((await POST(post({ from: '2026-02-30' }))).status).toBe(400);
    expect(m.jobCreate).not.toHaveBeenCalled();
  });

  it('returns the export already in flight instead of queueing a second', async () => {
    m.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      createdAt: new Date(),
      finishedAt: null,
      result: null,
    });
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(m.jobCreate).not.toHaveBeenCalled();
  });

  it('downloads a finished archive within 24 hours and audits the download', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date(Date.now() - 60 * 60_000)));
    m.getUpload.mockResolvedValue(Buffer.from('PK-archive'));
    const response = await GET(get('?job=job-1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(m.jobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job-1', organizationId: 'org-a' }),
      })
    );
    expect(m.getUpload).toHaveBeenCalledWith('org-a', 'owner-data-export-job-1.zip');
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pharmacy.dataExport.download', statusCode: 200 }),
      expect.anything()
    );
  });

  it('expires the link 24 hours after the export finished', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date(Date.now() - 25 * 60 * 60_000)));
    const response = await GET(get('?job=job-1'));
    expect(response.status).toBe(410);
    expect(m.getUpload).not.toHaveBeenCalled();
  });

  it('does not release the archive when the audit cannot be written', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date()));
    m.getUpload.mockResolvedValue(Buffer.from('PK-archive'));
    m.audit.mockRejectedValue(new Error('audit down'));
    expect((await GET(get('?job=job-1'))).status).toBe(503);
  });

  it('reports an export that is still being prepared', async () => {
    m.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'QUEUED',
      createdAt: new Date(),
      finishedAt: null,
      result: null,
    });
    expect((await GET(get('?job=job-1'))).status).toBe(409);
  });
});
