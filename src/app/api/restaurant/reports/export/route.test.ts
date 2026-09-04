import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  exportCsv: vi.fn(),
}));

vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/restaurant-reports', () => ({
  restaurantReportsRouter: {
    createCaller: () => ({ exportCsv: mocks.exportCsv }),
  },
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTRPCContext.mockResolvedValue({});
  mocks.exportCsv.mockResolvedValue({
    filename: 'restaurant-sop-2026-01-01-to-2026-01-31.csv',
    contentType: 'text/csv; charset=utf-8',
    content: 'staffProfileId\nstaff-1',
    truncated: true,
  });
});

describe('GET Restaurant report export', () => {
  it('emits the report truncation header from the export contract', async () => {
    const response = await GET(
      new Request(
        'https://devfathom.test/api/restaurant/reports/export?section=sop&branch=all&from=2026-01-01&to=2026-01-31'
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Report-Truncated')).toBe('true');
  });

  it('passes the stock-location filter unchanged for wastage exports', async () => {
    const response = await GET(
      new Request(
        'https://devfathom.test/api/restaurant/reports/export?section=wastage&branch=branch-1&stockLocation=location-1&from=2026-01-01&to=2026-01-31'
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.exportCsv).toHaveBeenCalledWith({
      section: 'wastage',
      branchId: 'branch-1',
      stockLocationId: 'location-1',
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });
});
