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
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';

const document = {
  type: 'BAR_TICKET',
  reference: 'KOT 1',
  title: 'BAR',
  createdAt: '2026-09-05T12:00:00Z',
  lines: [{ quantity: 1, label: 'Soda' }],
};
const fabricatedReceipt = {
  type: 'RECEIPT',
  reference: 'INV-0001',
  title: 'RECEIPT',
  createdAt: '2026-09-05T12:00:00Z',
  lines: [{ quantity: 1, label: 'Grand total PKR 0.00 - PAID' }],
};
const legacyJob = {
  branchId: 'branch-b',
  stationId: null,
  idempotencyKey: 'manual-test',
  document,
};
const job = { branchId: 'branch-b', idempotencyKey: 'receipt-test:0123456789abcdef' };
const serverJob = {
  branchId: 'branch-b',
  stationId: null,
  idempotencyKey: 'receipt-test:0123456789abcdef',
  document: {
    type: 'RECEIPT',
    reference: 'PRINTER TEST',
    title: 'RECEIPT PRINTER TEST',
    createdAt: expect.any(String),
    lines: [{ quantity: 1, label: 'Setup test - not a sale or payment' }],
    footer: 'Confirm this test at the selected printer. No financial transaction.',
  },
};
const configureOnly = () =>
  mocks.can.mockImplementation(async (_user, action) => action === 'restaurant:configure');
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
  it.each(['primary', 'assignment'])(
    'rejects read-only %s branch staff without printer configuration authority',
    async (kind) => {
      (kind === 'primary'
        ? db.restaurantStaffProfile
        : db.restaurantBranchAssignment
      ).findFirst.mockResolvedValue({ id: 'allowed' });
      expect((await POST(request('POST', job))).status).toBe(403);
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['fabricated receipt', { ...legacyJob, document: fabricatedReceipt }],
    ['kitchen ticket', { ...legacyJob, document: { ...document, type: 'KITCHEN_TICKET' } }],
    ['bar ticket', legacyJob],
  ])('rejects a %s from a money:read/orders:read branch user', async (_label, body) => {
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'allowed' });
    mocks.can.mockImplementation(async (_user, action) =>
      ['money:read', 'orders:read'].includes(action)
    );
    const response = await POST(request('POST', body));
    expect(response.status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('lets a printer configurator queue only the server-authored receipt test', async () => {
    configureOnly();
    expect((await POST(request('POST', job))).status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'org',
      { branchId: 'branch-b', routes: [] },
      serverJob,
      undefined
    );
  });
  it.each([
    ['caller-authored receipt', { ...job, document: fabricatedReceipt }],
    ['caller-authored ticket', { ...job, document }],
    ['legacy job shape', legacyJob],
    ['station-routed test', { ...job, stationId: 'hot' }],
    ['producer idempotency key', { ...job, idempotencyKey: 'order:abc:receipt' }],
  ])('rejects a %s even for a printer configurator', async (_label, body) => {
    configureOnly();
    expect((await POST(request('POST', body))).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('allows organization configurator routing and rejects unauthorized routing', async () => {
    expect((await PUT(request('PUT', { branchId: 'branch-b', routes: [] }))).status).toBe(403);
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
    mocks.can.mockResolvedValue(true);
    expect((await PUT(request('PUT', { branchId: 'branch-b', routes: [] }))).status).toBe(200);
  });
  it('rejects caller-supplied Unicode print text before the enqueue service runs', async () => {
    configureOnly();
    const response = await POST(
      request('POST', {
        ...job,
        document: { ...document, lines: [{ quantity: 1, label: 'اردو' }] },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('maps raw print validation from the service to an actionable 422', async () => {
    configureOnly();
    mocks.enqueue.mockRejectedValue(new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT'));
    const response = await POST(request('POST', job));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      retryable: false,
    });
  });
  it('validates the server-authored test document with the real enqueue service', async () => {
    configureOnly();
    const { PrintBridgeService } = await vi.importActual<
      typeof import('@/lib/restaurant/printing/service')
    >('@/lib/restaurant/printing/service');
    const create = vi.fn();
    const serviceDb = {
      $executeRawUnsafe: vi.fn(),
      restaurantPrintJob: { findUnique: vi.fn().mockResolvedValue(null), create },
    };
    const config = {
      branchId: 'branch-b',
      routes: [
        {
          documentType: 'RECEIPT' as const,
          stationId: null,
          printerId: 'printer-a',
          enabled: true,
        },
      ],
    };
    mocks.enqueue.mockImplementation((_org, _config, input) =>
      new PrintBridgeService(
        serviceDb as unknown as import('@/lib/tenancy/scoped-db').ScopedDb
      ).enqueue('org', config, input)
    );
    const response = await POST(request('POST', { ...job, document: fabricatedReceipt }));
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect((await POST(request('POST', job))).status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({
      documentType: 'RECEIPT',
      stationId: null,
      idempotencyKey: 'receipt-test:0123456789abcdef',
      document: serverJob.document,
    });
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
  it('selects and forwards the registered reference for a receipt printer test', async () => {
    configureOnly();
    db.restaurantPrintRoute.findMany.mockResolvedValue([route]);
    expect((await POST(request('POST', job))).status).toBe(202);
    expect(db.restaurantPrintRoute.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-b' },
      select: {
        documentType: true,
        stationId: true,
        printerId: true,
        registeredPrinterId: true,
        enabled: true,
      },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'org',
      { branchId: 'branch-b', routes: [route] },
      serverJob,
      undefined
    );
  });
});

describe('guarded routing HTTP boundary', () => {
  const baseline = { branchId: 'branch-b', routes: [] };
  const expectedDestination = { printerId: 'raw-printer', registeredPrinterId: null };
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
    configureOnly();
    expect((await POST(request('POST', { ...job, expectedDestination }))).status).toBe(202);
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'ReadCommitted' });
    expect(db.restaurantPrintRoute.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith('org', baseline, serverJob, expectedDestination);
  });
  it('maps the service destination conflict to a definite 409', async () => {
    configureOnly();
    mocks.enqueue.mockRejectedValue(
      new PrintRoutingError('REFRESH_REQUIRED', 'Destination changed')
    );
    const result = await POST(request('POST', { ...job, expectedDestination }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'REFRESH_REQUIRED' });
  });
  it('preserves default isolation for unguarded HTTP callers', async () => {
    mocks.can.mockResolvedValue(true);
    await PUT(request('PUT', baseline));
    await POST(request('POST', job));
    expect(db.$transaction.mock.calls.map((call) => call[1])).toEqual([undefined, undefined]);
  });
  it('does not let a destination guard bypass branch authorization', async () => {
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'allowed' });
    expect((await POST(request('POST', { ...job, expectedDestination }))).status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
