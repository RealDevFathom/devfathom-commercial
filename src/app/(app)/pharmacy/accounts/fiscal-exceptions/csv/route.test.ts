// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fiscalExceptionInput } from '@/lib/pharmacy/accounts/fiscal-exceptions';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../access', () => ({ loadFiscalExceptionRegister: mocks.load }));
import { GET } from './route';

const url = 'https://workspace.example/pharmacy/accounts/fiscal-exceptions/csv?branchId=main&from=2026-07-01&to=2026-10-01';
// Returning the mock would register it as a Vitest cleanup callback.
beforeEach(() => { mocks.load.mockReset(); });

describe('fiscal exception page CSV download', () => {
  it('re-enters the authorized reader with request metadata, exports only the page, and disables caching', async () => {
    mocks.load.mockResolvedValue({
      organizationId: 'org-1', branch: { id: 'main', name: 'Main' }, configuredMode: 'SANDBOX',
      filters: { branchId: 'main', from: '2026-07-01', to: '2026-10-01', page: 1, pageSize: 1 },
      timeZone: null, window: { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      readAt: '2026-10-01T00:00:00.000Z', coverage: 'UNKNOWN', hasMoreAtRead: true,
      pageCapReached: false, nextPage: 2,
      rows: [{ id: 'doc-2', localReference: '=HYPERLINK("https://example.invalid")', kind: 'INVOICE',
        integratorMode: 'SANDBOX', status: 'QUEUED', attempts: 0, maxAttempts: 3,
        nextAttemptAt: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
      }],
    });
    const request = new Request(`${url}&page=1&pageSize=1`);
    const response = await GET(request);
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledWith({
      branchId: 'main', from: '2026-07-01', to: '2026-10-01', page: 1, pageSize: 1,
    }, request);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="fiscal-exception-evidence-page.csv"');
    const csv = await response.text();
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"UNKNOWN"');
    expect(csv).toContain('"SANDBOX"');
    expect(csv.trim().split('\r\n')).toHaveLength(3);
  });

  it.each([
    ['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['BAD_REQUEST', 400], ['NOT_FOUND', 404],
    ['INTERNAL_SERVER_ERROR', 500],
  ] as const)('returns safe %s failures without CSV data', async (code, status) => {
    mocks.load.mockRejectedValue(new TRPCError({ code, message: 'secret provider/SQL data' }));
    const response = await GET(new Request(url));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.text()).not.toMatch(/secret|provider|SQL|DOCUMENT/);
  });

  it.each(['&branchId=foreign', '&page=0&page=1', '&pageSize=101', '&organizationId=foreign',
    '&__proto__=foreign', '&to=2026-10-02'])('rejects expanded/duplicate URL envelopes %s', async (extra) => {
    mocks.load.mockImplementation(async (input) => {
      if (!fiscalExceptionInput.safeParse(input).success) throw new TRPCError({ code: 'BAD_REQUEST' });
      throw new Error('Expected input refusal');
    });
    expect((await GET(new Request(url + extra))).status).toBe(400);
  });

  it.each(['organizationId', '__proto__', 'constructor', 'toString', '%5F%5Fproto%5F%5F'])
  ('rejects unsupported URL key %s before entering the reader', async (key) => {
    const response = await GET(new Request(`${url}&${key}=foreign`));
    expect(response.status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.text()).not.toContain('foreign');
  });
});
