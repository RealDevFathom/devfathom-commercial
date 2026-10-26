import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
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
      invoice: {
        findUnique: mocks.findUnique,
        update: mocks.update,
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

describe('finance.updateInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', discount: 10, tax: 0 });
    mocks.update.mockResolvedValue({
      id: 'invoice-1',
      total: 90,
      payments: [],
      client: { contacts: [] },
      project: null,
    });
  });

  it('preserves a stored discount when another field is updated', async () => {
    const dueDate = new Date('2026-11-30T00:00:00.000Z');

    await caller().updateInvoice({
      id: 'invoice-1',
      items: [{ description: 'Consulting', quantity: 1, rate: 100 }],
      dueDate,
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invoice-1' },
        data: expect.objectContaining({
          subtotal: 100,
          discount: 10,
          tax: 0,
          total: 90,
          dueDate,
        }),
      })
    );
  });
});
