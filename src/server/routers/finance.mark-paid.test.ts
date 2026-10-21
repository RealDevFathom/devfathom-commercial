import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://example.test'),
  sendEmail: vi.fn(),
  templates: {},
}));

import { financeRouter } from './finance';

const paidAt = new Date('2026-10-21T12:00:00.000Z');
const invoiceUpdate = vi.fn();
const paymentAggregate = vi.fn();
const paymentCreate = vi.fn();
const tx = {
  invoice: { update: invoiceUpdate },
  payment: { aggregate: paymentAggregate, create: paymentCreate },
};
const db = {
  invoice: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
};

function caller() {
  return financeRouter.createCaller({
    db,
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [], limits: {} },
    session: {
      expires: 'later',
      user: {
        id: 'admin_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('finance invoice mark-paid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(paidAt);
    db.invoice.findUnique.mockResolvedValue({ status: 'SENT' });
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-2026-001',
      total: 100,
      currency: 'USD',
      client: { name: 'Acme' },
    });
    paymentAggregate.mockResolvedValue({ _sum: { amount: 25 } });
    paymentCreate.mockResolvedValue({ id: 'payment_1' });
  });

  it('records the outstanding balance while marking an invoice paid', async () => {
    await caller().updateInvoiceStatus({ id: 'inv_1', status: 'PAID' });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAID', paidAt } })
    );
    expect(paymentCreate).toHaveBeenCalledWith({
      data: {
        invoiceId: 'inv_1',
        amount: 75,
        currency: 'USD',
        method: 'Manual status update',
        paidAt,
      },
    });
  });
});
