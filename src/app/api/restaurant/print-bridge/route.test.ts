// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  context: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  ack: vi.fn(),
  device: { id: 'device-a', branchId: 'branch-a' },
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/restaurant/printing/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/printing/service')>()),
  claimNextPrintJob: mocks.claim,
  acknowledgePrintJob: mocks.ack,
  PrintBridgeService: class {
    enqueue = mocks.enqueue;
  },
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  withDeviceAuth: (fn: (ctx: unknown, req: Request) => Promise<Response>) => (req: Request) =>
    fn({ device: mocks.device, db: {} }, req),
}));
import { GET, POST, PUT } from './route';
import { PrintRoutingError } from '@/lib/restaurant/printing/registered-routing';

const document = {
  type: 'BAR_TICKET',
  reference: 'KOT 1',
  title: 'BAR',
  createdAt: '2026-09-05T12:00:00Z',
  lines: [{ quantity: 1, label: 'Soda' }],
};
const expectedDestination = { printerId: 'raw-printer', registeredPrinterId: null };
const job = { branchId: 'branch-b', idempotencyKey: 'manual-test', expectedDestination };
const request = (method: string, body?: unknown, bridge = false) =>
  new Request('http://localhost/api/restaurant/print-bridge?wait=0', {
    method,
    headers: bridge ? { authorization: 'Bearer rdk_test' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
let db: ReturnType<typeof makeDb>;
function makeDb() {
  const result = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'branch-b', active: true }]),
    restaurantBranch: {
      findUnique: vi.fn().mockResolvedValue({ id: 'branch-b' }),
      findMany: vi.fn(
        async (args?: {
          where?: { id?: { in?: string[] } };
        }): Promise<Array<{ id: string; name?: string; kitchenStations?: unknown[] }>> => {
          const ids = args?.where?.id?.in;
          return ids ? ids.map((id) => ({ id })) : [];
        }
      ),
    },
    restaurantStaffProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantBranchAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantKitchenStation: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantPrintRoute: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  result.$transaction.mockImplementation((fn: (tx: typeof result) => unknown) => fn(result));
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  mocks.context.mockResolvedValue({
    db,
    session: { user: { id: 'operator', organizationId: 'org' } },
    requestMeta: { ip: null },
  });
  mocks.can.mockImplementation((_user, action) => action !== 'restaurant:configure');
  mocks.enqueue.mockReset().mockResolvedValue({ status: 'QUEUED', replayed: false });
  mocks.ack.mockResolvedValue({ acknowledged: true, replayed: false });
  mocks.claim.mockResolvedValue({ id: 'job', claimToken: 'a'.repeat(64) });
});
describe('print bridge authorization boundary', () => {
  it('rejects sibling branch submission before branch lookup or queue writes', async () => {
    expect((await POST(request('POST', job))).status).toBe(403);
    expect(db.restaurantBranch.findUnique).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each(['primary', 'assignment'])('allows %s branch printer tests', async (kind) => {
    mocks.can.mockResolvedValue(true);
    (kind === 'primary'
      ? db.restaurantStaffProfile
      : db.restaurantBranchAssignment
    ).findFirst.mockResolvedValue({ id: 'allowed' });
    expect((await POST(request('POST', job))).status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
  it('allows organization configurator routing and rejects unauthorized routing', async () => {
    expect((await PUT(request('PUT', { branchId: 'branch-b', routes: [] }))).status).toBe(403);
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
    mocks.can.mockResolvedValue(true);
    expect((await PUT(request('PUT', { branchId: 'branch-b', routes: [] }))).status).toBe(200);
  });
  it('rejects caller-authored printable facts before authorization or persistence', async () => {
    mocks.can.mockResolvedValue(true);
    const response = await POST(request('POST', { ...job, document }));
    expect(response.status).toBe(400);
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('passes authenticated device identity when claiming', async () => {
    const response = await GET(request('GET', undefined, true));
    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith({}, 'branch-a', 'device-a');
    expect((await response.json()).job.claimToken).toBe('a'.repeat(64));
  });
  it('requires a claim token and never accepts client-supplied device identity', async () => {
    expect((await POST(request('POST', { jobId: 'job', status: 'PRINTED' }, true))).status).toBe(
      400
    );
    expect(
      (
        await POST(
          request(
            'POST',
            { jobId: 'job', status: 'PRINTED', claimToken: 'a'.repeat(64), deviceId: 'device-b' },
            true
          )
        )
      ).status
    ).toBe(400);
    expect(mocks.ack).not.toHaveBeenCalled();
  });
  it('forwards valid token with authenticated identity and rejects invalid claim', async () => {
    const body = { jobId: 'job', status: 'PRINTED', claimToken: 'a'.repeat(64) };
    expect((await POST(request('POST', body, true))).status).toBe(200);
    expect(mocks.ack).toHaveBeenCalledWith(
      {},
      { ...body, branchId: 'branch-a', deviceId: 'device-a' }
    );
    mocks.ack.mockResolvedValue({ acknowledged: false, replayed: false });
    expect((await POST(request('POST', body, true))).status).toBe(404);
  });
});

describe('registered routing REST compatibility', () => {
  const route = {
    documentType: 'RECEIPT',
    stationId: null,
    printerId: 'tcp://printer:9100',
    registeredPrinterId: 'inventory-id',
    enabled: true,
  };
  it('returns 409 without mutation when an older client omits registered bindings', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ id: 'existing' }]);
    const legacy = { ...route } as Partial<typeof route>;
    delete legacy.registeredPrinterId;
    const response = await PUT(request('PUT', { branchId: 'branch-b', routes: [legacy] }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'REFRESH_REQUIRED' });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('returns 400 before mutation when branch is no longer active', async () => {
    mocks.can.mockResolvedValue(true);
    db.$queryRaw.mockResolvedValue([{ id: 'branch-b', active: false }]);
    const response = await PUT(request('PUT', { branchId: 'branch-b', routes: [] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_ROUTE' });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('returns registered references alongside raw addresses in configuration GET', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'branch-b', name: 'Branch', kitchenStations: [] },
    ]);
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ ...route, branchId: 'branch-b' }]);
    const response = await GET(request('GET'));
    expect((await response.json()).branches[0].config.routes).toEqual([route]);
  });
  it('forwards the guarded destination without selecting caller-controlled routes', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'allowed' });
    db.restaurantPrintRoute.findMany.mockResolvedValue([route]);
    const guardedJob = {
      ...job,
      expectedDestination: { printerId: route.printerId, registeredPrinterId: 'inventory-id' },
    };
    expect((await POST(request('POST', guardedJob))).status).toBe(202);
    expect(db.restaurantPrintRoute.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'org',
      { branchId: 'branch-b', routes: [] },
      expect.objectContaining({
        branchId: 'branch-b',
        document: expect.objectContaining({
          type: 'RECEIPT',
          title: 'RECEIPT PRINTER TEST',
        }),
      }),
      guardedJob.expectedDestination
    );
  });
});

describe('guarded routing HTTP boundary', () => {
  const baseline = { branchId: 'branch-b', routes: [] };
  it('rejects malformed guards before opening a transaction', async () => {
    mocks.can.mockResolvedValue(true);
    expect(
      (
        await PUT(
          request('PUT', { ...baseline, expectedConfig: { branchId: 'other', routes: [] } })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(request('POST', { ...job, expectedDestination: { printerId: 'raw-printer' } })))
        .status
    ).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('compares guarded PUT with ReadCommitted and excludes request metadata from the response', async () => {
    mocks.can.mockResolvedValue(true);
    const result = await PUT(request('PUT', { ...baseline, expectedConfig: baseline }));
    expect(result.status).toBe(200);
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'ReadCommitted' });
    expect((await result.json()).config).toEqual(baseline);
  });
  it('reports a changed baseline as 409 without writing', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantPrintRoute.findMany.mockResolvedValue([
      {
        documentType: 'RECEIPT',
        stationId: null,
        printerId: 'other',
        registeredPrinterId: null,
        enabled: true,
      },
    ]);
    const result = await PUT(request('PUT', { ...baseline, expectedConfig: baseline }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'REFRESH_REQUIRED' });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('passes the destination to the service and leaves fresh route selection inside its locked transaction', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'allowed' });
    expect((await POST(request('POST', { ...job, expectedDestination }))).status).toBe(202);
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'ReadCommitted' });
    expect(db.restaurantPrintRoute.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'org',
      baseline,
      expect.objectContaining({ branchId: 'branch-b', idempotencyKey: 'manual-test' }),
      expectedDestination
    );
  });
  it('maps the service destination conflict to a definite 409', async () => {
    mocks.can.mockResolvedValue(true);
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'allowed' });
    mocks.enqueue.mockRejectedValue(
      new PrintRoutingError('REFRESH_REQUIRED', 'Destination changed')
    );
    const result = await POST(request('POST', { ...job, expectedDestination }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'REFRESH_REQUIRED' });
  });
  it('uses guarded isolation for printer tests while preserving default isolation for routing', async () => {
    mocks.can.mockResolvedValue(true);
    await PUT(request('PUT', baseline));
    await POST(request('POST', job));
    expect(db.$transaction.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      { isolationLevel: 'ReadCommitted' },
    ]);
  });
  it('does not let a destination guard bypass branch authorization', async () => {
    expect((await POST(request('POST', { ...job, expectedDestination }))).status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
