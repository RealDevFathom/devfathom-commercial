import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
const sales = vi.hoisted(() => ({
  buildSettledCounterReceiptPrintJob: vi.fn(),
  requireCounterReceiptAccess: vi.fn(),
  branchScopeOrForbidden: vi.fn(),
}));
vi.mock('./pharmacy-sales', () => sales);
const queue = vi.hoisted(() => ({
  enqueuePharmacyReceiptPrint: vi.fn(),
  retryPharmacyPrintJob: vi.fn(),
  enrollPharmacyPrintBridge: vi.fn(),
}));
vi.mock('@/lib/pharmacy/receipt-print-queue', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/receipt-print-queue')>()),
  ...queue,
}));

import { PharmacyPrintQueueError } from '@/lib/pharmacy/receipt-print-queue';
import { router, type TRPCContext } from '../trpc';
import { pharmacyPrintingRouter } from './pharmacy-printing';

const app = router({ pharmacyPrinting: pharmacyPrintingRouter });
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const NOW = new Date();

function caller(role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE') {
  const permissions =
    role === 'ADMIN' ? [{ capability: 'admin:access', effect: 'ALLOW' as const }] : [];
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions },
        permissionOverrides: [],
      })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role,
        status: 'ACTIVE',
        organizationId: 'org-a',
        department: 'COUNTER',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return app.createCaller(context as unknown as TRPCContext).pharmacyPrinting;
}

const ready = {
  status: 'READY' as const,
  scope,
  receiptNumber: 41,
  job: {
    document: { type: 'RECEIPT' },
    escPos: { encoding: 'base64', data: 'YQ==', byteCount: 120 },
    paperWidth: 58,
    reprint: false,
  },
};

const jobRow = {
  id: 'job-1',
  saleId: 'sale-a',
  receiptNumber: 41,
  reprint: false,
  bridgeId: 'bridge-1',
  paperWidth: 58,
  status: 'PENDING',
  attemptCount: 0,
  queuedAt: NOW,
  lastAttemptAt: null,
  acceptedAt: null,
  failureCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  sales.requireCounterReceiptAccess.mockResolvedValue(scope);
  sales.branchScopeOrForbidden.mockResolvedValue(scope);
});

describe('pharmacyPrinting.enqueueReceipt', () => {
  const input = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' as const, reprint: false };

  it('accepts no printable content from the caller (DEV-168 provenance)', async () => {
    await expect(
      caller().enqueueReceipt({
        ...input,
        document: { type: 'RECEIPT', lines: [{ quantity: 1, label: 'Free' }] },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sales.buildSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it('builds the receipt from the settled sale and queues exactly that document', async () => {
    sales.buildSettledCounterReceiptPrintJob.mockResolvedValue(ready);
    queue.enqueuePharmacyReceiptPrint.mockResolvedValue({ job: jobRow, replayed: false });
    const result = await caller().enqueueReceipt(input);
    expect(sales.buildSettledCounterReceiptPrintJob).toHaveBeenCalledWith(expect.anything(), input);
    expect(queue.enqueuePharmacyReceiptPrint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'user-a',
        saleId: 'sale-a',
        receiptNumber: 41,
        reprint: false,
        document: ready.job.document,
        byteCount: 120,
        paperWidth: 58,
      })
    );
    expect(result).toMatchObject({
      status: 'QUEUED',
      replayed: false,
      job: { id: 'job-1', state: 'QUEUED', paperConfirmed: false },
    });
  });

  it('requires a request key for a reprint', async () => {
    await expect(caller().enqueueReceipt({ ...input, reprint: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().enqueueReceipt({ ...input, reprint: true, requestKey: 'bad key!' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns the builder fallback (e.g. Urdu) and queues nothing', async () => {
    const fallback = {
      status: 'FALLBACK' as const,
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
    };
    sales.buildSettledCounterReceiptPrintJob.mockResolvedValue(fallback);
    await expect(caller().enqueueReceipt({ ...input, locale: 'ur' })).resolves.toEqual(fallback);
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('turns a missing or offline bridge into a browser fallback, not a silent queue', async () => {
    sales.buildSettledCounterReceiptPrintJob.mockResolvedValue(ready);
    for (const reason of ['NO_BRIDGE', 'BRIDGE_OFFLINE'] as const) {
      queue.enqueuePharmacyReceiptPrint.mockRejectedValueOnce(new PharmacyPrintQueueError(reason));
      await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
        status: 'FALLBACK',
        code: reason,
        fallback: 'BROWSER_OS',
      });
    }
    queue.enqueuePharmacyReceiptPrint.mockRejectedValueOnce(
      new PharmacyPrintQueueError('BRIDGE_REQUIRED')
    );
    await expect(caller().enqueueReceipt(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('pharmacyPrinting.retryJob', () => {
  it('passes the operator paper check through and maps refusal honestly', async () => {
    queue.retryPharmacyPrintJob.mockRejectedValueOnce(
      new PharmacyPrintQueueError('PAPER_CHECK_REQUIRED')
    );
    await expect(caller().retryJob({ branchId: 'branch-a', jobId: 'job-1' })).rejects.toMatchObject(
      { code: 'PRECONDITION_FAILED' }
    );
    expect(queue.retryPharmacyPrintJob).toHaveBeenCalledWith(expect.anything(), scope, {
      jobId: 'job-1',
      paperChecked: false,
      now: expect.any(Date),
    });
    queue.retryPharmacyPrintJob.mockResolvedValueOnce(jobRow);
    await expect(
      caller().retryJob({ branchId: 'branch-a', jobId: 'job-1', confirmNoPaperPrinted: true })
    ).resolves.toMatchObject({ state: 'QUEUED' });
  });
});

describe('pharmacyPrinting.enrollBridge', () => {
  it('is admin-only and returns the credential once', async () => {
    await expect(
      caller('EMPLOYEE').enrollBridge({
        branchId: 'branch-a',
        name: 'Front',
        printerId: 'tcp://192.0.2.10:9100',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    queue.enrollPharmacyPrintBridge.mockResolvedValue({
      bridge: {
        id: 'bridge-1',
        name: 'Front',
        status: 'ACTIVE',
        revokedAt: null,
        lastSeenAt: null,
        printerId: 'tcp://192.0.2.10:9100',
      },
      credential: 'ppb_secret.b3JnLWE',
    });
    await expect(
      caller('ADMIN').enrollBridge({
        branchId: 'branch-a',
        name: 'Front',
        printerId: 'tcp://192.0.2.10:9100',
      })
    ).resolves.toMatchObject({ credential: 'ppb_secret.b3JnLWE', bridge: { online: false } });
  });
});
