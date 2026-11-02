import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  exportCsv: vi.fn(),
}));

vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: {
    createCaller: () => ({ exportCsv: mocks.exportCsv }),
  },
}));

import { GET } from './route';

const url = (query: string) => `https://devfathom.test/api/pharmacy/reports/export?${query}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTRPCContext.mockResolvedValue({});
  mocks.exportCsv.mockResolvedValue({
    filename: 'pharmacy-expiry-2026-10-01-to-2026-10-07.csv',
    contentType: 'text/csv; charset=utf-8',
    content: '\uFEFFReport,Pharmacy expiry\r\n',
  });
});

describe('GET pharmacy report export', () => {
  it('passes the screen filters through and downloads a private CSV', async () => {
    const response = await GET(
      new Request(url('report=expiry&branch=b1&from=2026-10-01&to=2026-10-07'))
    );

    expect(response.status).toBe(200);
    expect(mocks.exportCsv).toHaveBeenCalledWith({
      report: 'expiry',
      branchId: 'b1',
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="pharmacy-expiry-2026-10-01-to-2026-10-07.csv"'
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toContain('Report,Pharmacy expiry');
  });

  it('omits the branch for an all-branch export', async () => {
    await GET(new Request(url('report=branch-comparison&from=2026-10-01&to=2026-10-07')));
    expect(mocks.exportCsv).toHaveBeenCalledWith({
      report: 'branch-comparison',
      from: '2026-10-01',
      to: '2026-10-07',
    });
  });

  it('returns 403 when the procedure denies reports:financial', async () => {
    mocks.exportCsv.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission for this action.' })
    );
    const response = await GET(
      new Request(url('report=period-summary&from=2026-10-01&to=2026-10-07'))
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('returns 401 without a session', async () => {
    mocks.exportCsv.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    const response = await GET(
      new Request(url('report=period-summary&from=2026-10-01&to=2026-10-07'))
    );
    expect(response.status).toBe(401);
  });

  it.each([
    'report=everything&from=2026-10-01&to=2026-10-07',
    'report=expiry&from=2026-10-01',
    'report=expiry&from=2026-10-01&to=2026-10-07&organizationId=other',
  ])('rejects unsupported filters without calling the export: %s', async (query) => {
    const response = await GET(new Request(url(query)));
    expect(response.status).toBe(400);
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });

  it('hides unexpected procedure failure details behind a generic 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // createCaller wraps any non-tRPC error thrown in the procedure like this.
    mocks.exportCsv.mockRejectedValue(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'private database host',
        cause: new Error('private database host'),
      })
    );
    const response = await GET(
      new Request(url('report=period-summary&from=2026-10-01&to=2026-10-07'))
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('private');
    expect(log).toHaveBeenCalledWith('Pharmacy report export failed', expect.any(TRPCError));
    log.mockRestore();
  });

  it('hides unexpected context failure details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createTRPCContext.mockRejectedValue(new Error('private database host'));
    const response = await GET(
      new Request(url('report=period-summary&from=2026-10-01&to=2026-10-07'))
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private');
    expect(mocks.exportCsv).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ['NOT_FOUND', 'Workspace not found.', 404],
    ['BAD_REQUEST', 'Invalid report period.', 400],
  ] as const)(
    'maps %s to its HTTP status with the user-facing message',
    async (code, message, status) => {
      mocks.exportCsv.mockRejectedValue(new TRPCError({ code, message }));
      const response = await GET(
        new Request(url('report=period-summary&from=2026-10-01&to=2026-10-07'))
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(message);
    }
  );
});
