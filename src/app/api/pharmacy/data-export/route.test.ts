// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  audit: vi.fn(),
  userFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  jobFindMany: vi.fn(),
  jobCreate: vi.fn(),
  lock: vi.fn(),
  verifyPin: vi.fn(),
  getUploadStream: vi.fn(),
  putUploadFile: vi.fn(),
  session: {
    user: { id: 'u-owner', role: 'ADMIN', isSupportSession: false } as Record<string, unknown>,
  },
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: m.actor }));
vi.mock('@/server/audit', () => ({ recordAudit: m.audit }));
vi.mock('@/lib/storage', () => ({
  getUploadStream: m.getUploadStream,
  putUploadFile: m.putUploadFile,
}));
vi.mock('@/lib/pharmacy/owner-data-export-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/owner-data-export-pin')>()),
  verifyOwnerExportPin: m.verifyPin,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      $queryRawUnsafe: m.lock,
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

const PIN = '2468';
const ARCHIVE = 'owner-data-export-job-1-0123456789abcdef0123456789abcdef.zip';

function post(body: unknown = { pin: PIN }) {
  return new Request('https://shop.example.com/api/pharmacy/data-export', {
    method: 'POST',
    headers: { origin: 'https://shop.example.com', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const get = (query = '') =>
  new Request(`https://shop.example.com/api/pharmacy/data-export${query}`);
const download = (job = 'job-1', pin: unknown = PIN) => post({ action: 'download', job, pin });

const stream = (text: string) => ({
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }),
  size: text.length,
});

const finished = (finishedAt: Date) => ({
  id: 'job-1',
  status: 'SUCCEEDED',
  createdAt: new Date(finishedAt.getTime() - 60_000),
  finishedAt,
  result: { filename: ARCHIVE, rowCounts: { 'customers.csv': 3 } },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.session.user = { id: 'u-owner', role: 'ADMIN', isSupportSession: false };
  m.actor.mockResolvedValue({ session: m.session, organization: { id: 'org-a' } });
  m.audit.mockResolvedValue(undefined);
  m.userFindFirst.mockResolvedValue(OWNER);
  m.verifyPin.mockResolvedValue('OK');
  m.lock.mockResolvedValue([]);
  m.jobFindMany.mockResolvedValue([]);
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

    const refused = await POST(download());
    expect(refused.status).toBe(403);
    expect(m.getUploadStream).not.toHaveBeenCalled();
    expect(m.verifyPin).not.toHaveBeenCalled();
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
    const response = await POST(post({ from: '2026-01-01', to: '2026-10-31', pin: PIN }));
    expect(response.status).toBe(202);
    expect(m.verifyPin).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'u-owner',
      pin: PIN,
    });
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
    expect((await POST(post({ from: '2026-10-31', to: '2026-01-01', pin: PIN }))).status).toBe(400);
    expect((await POST(post({ from: '2026-02-30', pin: PIN }))).status).toBe(400);
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
    m.getUploadStream.mockResolvedValue(stream('PK-archive'));
    const response = await POST(download());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-length')).toBe('10');
    expect(await response.text()).toBe('PK-archive');
    expect(m.jobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job-1', organizationId: 'org-a' }),
      })
    );
    // The object name comes from the job row, never from the request.
    expect(m.getUploadStream).toHaveBeenCalledWith('org-a', ARCHIVE);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pharmacy.dataExport.download', statusCode: 200 }),
      expect.anything()
    );
  });

  it('expires the link 24 hours after the export finished', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date(Date.now() - 25 * 60 * 60_000)));
    const response = await POST(download());
    expect(response.status).toBe(410);
    expect(m.getUploadStream).not.toHaveBeenCalled();
  });

  it('does not release the archive when the audit cannot be written', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date()));
    const archive = stream('PK-archive');
    const cancel = vi.spyOn(archive.body, 'cancel');
    m.getUploadStream.mockResolvedValue(archive);
    m.audit.mockRejectedValue(new Error('audit down'));
    const response = await POST(download());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PK-archive');
    expect(cancel).toHaveBeenCalled();
  });

  it('reports an export that is still being prepared', async () => {
    m.jobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'QUEUED',
      createdAt: new Date(),
      finishedAt: null,
      result: null,
    });
    expect((await POST(download())).status).toBe(409);
  });
});

describe('owner data export PIN, rate limit and list audit (DEV-783)', () => {
  it('refuses a request without a PIN before checking it or queueing, and audits it', async () => {
    for (const body of [{}, { pin: '' }, { pin: 2468 }, { pin: 'x'.repeat(65) }]) {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(m.verifyPin).not.toHaveBeenCalled();
    expect(m.jobCreate).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.request',
        statusCode: 400,
        outcome: 'FAILURE',
        metadata: expect.objectContaining({ pinCheck: 'MISSING' }),
      }),
      expect.anything()
    );
  });

  it.each([
    ['REJECTED', 401],
    ['LOCKED', 423],
    ['NO_PIN', 403],
  ] as const)('audits a %s PIN on a request and queues nothing', async (result, status) => {
    m.verifyPin.mockResolvedValue(result);
    const response = await POST(post({ pin: '0000' }));
    expect(response.status).toBe(status);
    expect(m.jobCreate).not.toHaveBeenCalled();
    expect(m.lock).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.request',
        statusCode: status,
        outcome: 'FAILURE',
        metadata: expect.objectContaining({ pinCheck: result }),
      }),
      expect.anything()
    );
  });

  it.each([
    ['REJECTED', 401],
    ['LOCKED', 423],
  ] as const)(
    'audits a %s PIN on a download and never opens the archive',
    async (result, status) => {
      m.jobFindFirst.mockResolvedValue(finished(new Date()));
      m.verifyPin.mockResolvedValue(result);
      const response = await POST(download('job-1', '0000'));
      expect(response.status).toBe(status);
      expect(m.jobFindFirst).not.toHaveBeenCalled();
      expect(m.getUploadStream).not.toHaveBeenCalled();
      expect(m.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'pharmacy.dataExport.download',
          statusCode: status,
          metadata: expect.objectContaining({ jobId: 'job-1', pinCheck: result }),
        }),
        expect.anything()
      );
    }
  );

  it('refuses a download whose job does not record a matching archive name', async () => {
    for (const filename of [
      undefined,
      null,
      'owner-data-export-job-2-0123456789abcdef0123456789abcdef.zip',
      'owner-data-export-job-1-../x.zip',
      'customers.csv',
    ]) {
      const job = finished(new Date());
      m.jobFindFirst.mockResolvedValue({ ...job, result: { ...job.result, filename } });
      expect((await POST(download())).status).toBe(410);
    }
    expect(m.getUploadStream).not.toHaveBeenCalled();
  });

  it('refuses a download without a PIN', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date()));
    expect((await POST(post({ action: 'download', job: 'job-1' }))).status).toBe(400);
    expect((await POST(download('job-1', null))).status).toBe(400);
    expect(m.verifyPin).not.toHaveBeenCalled();
    expect(m.getUploadStream).not.toHaveBeenCalled();
  });

  it('no longer downloads from a GET link, so a PIN never sits in a URL', async () => {
    m.jobFindFirst.mockResolvedValue(finished(new Date()));
    const response = await GET(get('?job=job-1'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(m.getUploadStream).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pharmacy.dataExport.download', statusCode: 405 }),
      expect.anything()
    );
  });

  it('rate-limits each owner, under the workspace lock, and audits the refusal', async () => {
    const now = Date.now();
    m.jobFindMany.mockResolvedValue([
      { createdAt: new Date(now - 23 * 60 * 60_000) },
      { createdAt: new Date(now - 2 * 60 * 60_000) },
      { createdAt: new Date(now - 60_000) },
    ]);
    const response = await POST(post());
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(60 * 60);
    expect(m.jobCreate).not.toHaveBeenCalled();
    expect(m.lock).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      'owner-data-export:org-a'
    );
    expect(m.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-a', requestedById: 'u-owner' }),
      })
    );
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.request',
        statusCode: 429,
        metadata: expect.objectContaining({ rateLimited: true }),
      }),
      expect.anything()
    );
  });

  it('audits every list view and hides the list when the audit fails', async () => {
    m.jobFindMany.mockResolvedValue([finished(new Date())]);
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pharmacy.dataExport.list',
        operation: 'READ',
        organizationId: 'org-a',
        statusCode: 200,
      }),
      expect.anything()
    );
    m.audit.mockRejectedValue(new Error('audit down'));
    const hidden = await GET(get());
    expect(hidden.status).toBe(503);
    expect(await hidden.text()).not.toContain('job-1');
  });

  it('audits a refused list view by a non-owner', async () => {
    m.userFindFirst.mockResolvedValue(CASHIER);
    expect((await GET(get())).status).toBe(403);
    expect(m.jobFindMany).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pharmacy.dataExport.list', statusCode: 403 }),
      expect.anything()
    );
  });
});
