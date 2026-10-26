import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: mocks.logActivity }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

function caller() {
  const db = {
    client: { findMany: vi.fn().mockResolvedValue([{ id: 'client-1' }]) },
    project: { findMany: vi.fn() },
    invoice: {
      count: vi.fn().mockResolvedValue(0),
      create: mocks.create,
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
    $queryRaw: mocks.queryRaw,
  };
  return financeRouter.createCaller({
    db: {
      ...db,
      $transaction: vi.fn(async (work: (tx: typeof db) => Promise<unknown>) => work(db)),
    },
    entitlements: { organizationId: 'org-1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.createInvoice money calculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.create.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-2026-001',
      total: 2.03,
      client: { name: 'Acme' },
    });
  });

  it('rounds each half-cent line and the tax half up before persisting totals', async () => {
    await caller().createInvoice({
      clientId: 'client-1',
      items: [
        { description: 'First', quantity: 1, rate: 1.005, amount: 0 },
        { description: 'Second', quantity: 3, rate: 0.335, amount: 0 },
      ],
      subtotal: 0,
      tax: 0.005,
      total: 0,
      currency: 'USD',
      dueDate: new Date('2026-11-30T00:00:00.000Z'),
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [
            { description: 'First', quantity: 1, rate: 1.005, amount: 1.01 },
            { description: 'Second', quantity: 3, rate: 0.335, amount: 1.01 },
          ],
          subtotal: 2.02,
          tax: 0.01,
          total: 2.03,
        }),
      })
    );
  });

  it.each([
    ['line amount', [{ description: 'Too large', quantity: 2, rate: 9_999_999_999.99 }], 0],
    [
      'subtotal',
      [
        { description: 'First', quantity: 1, rate: 5_000_000_000 },
        { description: 'Second', quantity: 1, rate: 5_000_000_000 },
      ],
      0,
    ],
    ['total', [{ description: 'At limit', quantity: 1, rate: 9_999_999_999.99 }], 0.01],
  ])('rejects a derived %s overflow before persistence', async (_kind, items, tax) => {
    await expect(
      caller().createInvoice({
        clientId: 'client-1',
        items: items.map((item) => ({ ...item, amount: 0 })),
        subtotal: 0,
        tax,
        total: 0,
        currency: 'USD',
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('finance.updateInvoice settlement serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-1' }]);
  });

  it('locks before rechecking status and refuses an invoice settled by a concurrent payment', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'PAID' });

    await expect(
      caller().updateInvoice({
        id: 'invoice-1',
        items: [{ description: 'Work', quantity: 1, rate: 10 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
