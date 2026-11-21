import { afterEach, expect, it, vi } from 'vitest';
const { groupBy, organization } = vi.hoisted(() => ({
  groupBy: vi.fn(),
  organization: { findUnique: vi.fn() },
}));
vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (ctx: unknown, request: Request) => unknown) => (request: Request) =>
      handler(
        {
          organizationId: 'org',
          db: {
            organization,
            transaction: { groupBy },
            invoice: { groupBy: vi.fn().mockResolvedValue([]) },
          },
        },
        request
      ),
}));
import { GET } from './route';
afterEach(() => vi.useRealTimers());
it.each([
  ['', '2026-10-31T19:00:00.000Z', '2026-10-31T19:30:00.000Z'],
  [
    '?startDate=2026-11-01&endDate=2026-11-01',
    '2026-10-31T19:00:00.000Z',
    '2026-11-01T18:59:59.999Z',
  ],
  [
    '?startDate=2026-10-31T19:30:00Z&endDate=2026-10-31T19:30:00Z',
    '2026-10-31T19:30:00.000Z',
    '2026-10-31T19:30:00.000Z',
  ],
])('includes a Karachi 00:30 transaction with range %s', async (query, startDate, endDate) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const event = new Date('2026-11-01T00:30:00+05:00');
  vi.setSystemTime(event);
  organization.findUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
  groupBy.mockImplementation(({ where }) =>
    where.type === 'INCOME' && where.date.gte <= event && event <= where.date.lte
      ? [{ currency: 'PKR', _sum: { amount: 5 }, _count: 1 }]
      : []
  );
  const res = await GET(new Request('http://localhost/api/v1/finance/summary' + query), {
    params: Promise.resolve({}),
  });
  expect((await res.json()).data).toMatchObject({
    period: { startDate, endDate },
    income: { count: 1 },
  });
});
