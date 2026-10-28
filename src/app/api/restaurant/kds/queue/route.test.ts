import { beforeEach, describe, expect, it, vi } from 'vitest';

const CURRENT_DATE = new Date('2026-09-05T00:00:00.000Z');
const PREVIOUS_DATE = new Date('2026-09-04T00:00:00.000Z');

const mocks = vi.hoisted(() => {
  const findFirst = vi.fn();
  return {
    findFirst,
    readStationQueue: vi.fn(),
    requireKdsStation: vi.fn(),
    resolveStationBusinessDate: vi.fn(),
    context: {
      demoActor: { organization: { isDemo: true } } as {
        organization: { isDemo: boolean };
      } | null,
      device: { branchId: 'branch-bound' },
      db: {
        restaurantKitchenTicket: { findFirst },
      },
    },
  };
});

vi.mock('@/lib/restaurant/kds-auth', () => ({
  withKdsAuth:
    (handler: (ctx: typeof mocks.context, request: Request) => Promise<Response> | Response) =>
    (request: Request) =>
      handler(mocks.context, request),
}));
vi.mock('@/lib/restaurant/kds', () => ({
  readStationQueue: mocks.readStationQueue,
  requireKdsStation: mocks.requireKdsStation,
  resolveStationBusinessDate: mocks.resolveStationBusinessDate,
}));

import { GET } from './route';

function request(query = ''): Request {
  return new Request(`https://tenant.test/api/restaurant/kds/queue${query}`);
}

function queue(businessDate: Date, tickets: object[] = []) {
  return {
    stationId: 'station-bound',
    businessDate,
    tickets,
    cursor: 0,
    gap: false,
    hasMore: false,
    displayMapping: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.demoActor = { organization: { isDemo: true } };
  mocks.requireKdsStation.mockReturnValue({ ok: true, stationId: 'station-bound' });
  mocks.resolveStationBusinessDate.mockResolvedValue(CURRENT_DATE);
  mocks.findFirst.mockResolvedValue(null);
  mocks.readStationQueue.mockImplementation(async (_db: unknown, input: { businessDate: Date }) =>
    queue(input.businessDate)
  );
});

describe('GET KDS queue demo rollover', () => {
  it.each(['Hot Kitchen', null])(
    'forwards stationName from readStationQueue (%s)',
    async (stationName) => {
      mocks.context.demoActor = null;
      mocks.readStationQueue.mockResolvedValue({ ...queue(CURRENT_DATE), stationName });

      const response = await GET(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        stationId: 'station-bound',
        stationName,
        tickets: [],
      });
      expect(mocks.readStationQueue).toHaveBeenCalledTimes(1);
    }
  );

  it('returns the bound station earlier open date as a full snapshot on repeated polls', async () => {
    mocks.findFirst.mockResolvedValue({ businessDate: PREVIOUS_DATE });
    mocks.readStationQueue.mockImplementation(async (_db: unknown, input: { businessDate: Date }) =>
      queue(
        input.businessDate,
        input.businessDate.getTime() === PREVIOUS_DATE.getTime()
          ? [{ ticketId: 'ticket-previous' }]
          : []
      )
    );

    const first = await GET(request('?sinceCursor=71&limit=25'));
    const second = await GET(request('?sinceCursor=71&limit=25'));

    await expect(first.json()).resolves.toMatchObject({
      businessDate: '2026-09-04',
      tickets: [{ ticketId: 'ticket-previous' }],
    });
    await expect(second.json()).resolves.toMatchObject({
      businessDate: '2026-09-04',
      tickets: [{ ticketId: 'ticket-previous' }],
    });
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        stationId: 'station-bound',
        businessDate: { lt: CURRENT_DATE },
        items: {
          some: { orderItem: { status: { notIn: ['SERVED', 'VOIDED'] } } },
        },
      },
      orderBy: { businessDate: 'desc' },
      select: { businessDate: true },
    });
    expect(mocks.readStationQueue).toHaveBeenCalledTimes(4);
    expect(mocks.readStationQueue).toHaveBeenNthCalledWith(1, mocks.context.db, {
      stationId: 'station-bound',
      businessDate: CURRENT_DATE,
      sinceCursor: 71,
      limit: 25,
    });
    expect(mocks.readStationQueue).toHaveBeenNthCalledWith(2, mocks.context.db, {
      stationId: 'station-bound',
      businessDate: PREVIOUS_DATE,
      sinceCursor: null,
      limit: 25,
    });
    expect(mocks.readStationQueue).toHaveBeenNthCalledWith(3, mocks.context.db, {
      stationId: 'station-bound',
      businessDate: CURRENT_DATE,
      sinceCursor: 71,
      limit: 25,
    });
    expect(mocks.readStationQueue).toHaveBeenNthCalledWith(4, mocks.context.db, {
      stationId: 'station-bound',
      businessDate: PREVIOUS_DATE,
      sinceCursor: null,
      limit: 25,
    });
  });

  it('keeps current-date tickets authoritative', async () => {
    mocks.readStationQueue.mockResolvedValue(queue(CURRENT_DATE, [{ ticketId: 'ticket-current' }]));

    const response = await GET(request('?sinceCursor=8'));

    await expect(response.json()).resolves.toMatchObject({
      businessDate: '2026-09-05',
      tickets: [{ ticketId: 'ticket-current' }],
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.readStationQueue).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for an explicit business date', async () => {
    mocks.resolveStationBusinessDate.mockResolvedValue(PREVIOUS_DATE);

    const response = await GET(request('?businessDate=2026-09-04&sinceCursor=8'));

    await expect(response.json()).resolves.toMatchObject({
      businessDate: '2026-09-04',
      tickets: [],
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.readStationQueue).toHaveBeenCalledWith(mocks.context.db, {
      stationId: 'station-bound',
      businessDate: PREVIOUS_DATE,
      sinceCursor: 8,
      limit: 50,
    });
  });

  it('does not fall back for a non-demo request', async () => {
    mocks.context.demoActor = null;

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      businessDate: '2026-09-05',
      tickets: [],
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.readStationQueue).toHaveBeenCalledTimes(1);
  });

  it('keeps the current empty queue when no earlier open tickets exist', async () => {
    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      businessDate: '2026-09-05',
      tickets: [],
    });
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.readStationQueue).toHaveBeenCalledTimes(1);
  });
});
