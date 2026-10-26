import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  create: vi.fn(),
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
  return financeRouter.createCaller({
    db: {
      client: { findMany: vi.fn().mockResolvedValue([{ id: 'client-1' }]) },
      project: { findMany: vi.fn() },
      invoice: {
        count: vi.fn().mockResolvedValue(0),
        create: mocks.create,
      },
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
