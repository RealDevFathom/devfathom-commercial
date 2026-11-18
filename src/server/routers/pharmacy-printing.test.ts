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
  allocateSettledCounterReceiptPrintJob: vi.fn(),
  requireCounterReceiptAccess: vi.fn(),
  branchScopeOrForbidden: vi.fn(),
}));
vi.mock('./pharmacy-sales', () => sales);
const queue = vi.hoisted(() => ({
  enqueuePharmacyReceiptPrint: vi.fn(),
  selectPharmacyPrintBridge: vi.fn(),
  readPharmacyPrintJob: vi.fn(),
  retryPharmacyPrintJob: vi.fn(),
  enrollPharmacyPrintBridge: vi.fn(),
  listPharmacyPrintBridges: vi.fn(),
  revokePharmacyPrintBridge: vi.fn(),
}));
vi.mock('@/lib/pharmacy/receipt-print-queue', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/receipt-print-queue')>()),
  ...queue,
}));

import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { TRPCError } from '@trpc/server';
import { hasModule } from '@/lib/entitlements';
import { PharmacyPrintQueueError } from '@/lib/pharmacy/receipt-print-queue';
import { router, type TRPCContext } from '../trpc';
import { pharmacyPrintingRouter } from './pharmacy-printing';

const app = router({ pharmacyPrinting: pharmacyPrintingRouter });
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const NOW = new Date();

const storage = {
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => []),
  pharmacyPrintJob: { findUnique: vi.fn() },
  pharmacyBranch: { findFirst: vi.fn() },
};

function caller(role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE') {
  const permissions =
    role === 'ADMIN' ? [{ capability: 'admin:access', effect: 'ALLOW' as const }] : [];
  const db = {
    ...storage,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        role,
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
  receiptNumber: 41,
  result: {
    status: 'READY' as const,
    copyNumber: 1,
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
  copyNumber: 1,
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
  vi.resetAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  storage.pharmacyPrintJob.findUnique.mockResolvedValue(null);
  storage.pharmacyBranch.findFirst.mockResolvedValue({
    receiptLayout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 },
    receiptLayoutRevision: 2,
  });
  queue.selectPharmacyPrintBridge.mockResolvedValue({ id: 'bridge-1' });
  queue.readPharmacyPrintJob.mockResolvedValue(jobRow);
  sales.allocateSettledCounterReceiptPrintJob.mockResolvedValue(ready);
  queue.enqueuePharmacyReceiptPrint.mockResolvedValue({ job: jobRow, replayed: false });
  sales.requireCounterReceiptAccess.mockResolvedValue(scope);
  sales.branchScopeOrForbidden.mockResolvedValue(scope);
});

describe('pharmacyPrinting.enqueueReceipt', () => {
  const input = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en' as const,
    paper: 'THERMAL_58' as const,
    requestKey: 'click-0001',
  };

  it('accepts no printable content from the caller (DEV-168 provenance)', async () => {
    await expect(
      caller().enqueueReceipt({
        ...input,
        document: { type: 'RECEIPT', lines: [{ quantity: 1, label: 'Free' }] },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it('builds the receipt from the settled sale and queues exactly that document', async () => {
    sales.allocateSettledCounterReceiptPrintJob.mockResolvedValue(ready);
    queue.enqueuePharmacyReceiptPrint.mockResolvedValue({ job: jobRow, replayed: false });
    const result = await caller().enqueueReceipt(input);
    expect(sales.allocateSettledCounterReceiptPrintJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      scope,
      input
    );
    expect(queue.enqueuePharmacyReceiptPrint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'user-a',
        saleId: 'sale-a',
        receiptNumber: 41,
        reprint: false,
        document: ready.result.document,
        copyNumber: 1,
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

  it('requires a request key for every copy and refuses caller reprint overrides', async () => {
    await expect(
      caller().enqueueReceipt({ ...input, reprint: true } as never)
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().enqueueReceipt({ ...input, reprint: true, requestKey: 'bad key!' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns the builder fallback (e.g. Urdu) and queues nothing', async () => {
    const fallback = {
      status: 'FALLBACK' as const,
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
    };
    sales.allocateSettledCounterReceiptPrintJob.mockRejectedValue(
      new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT')
    );
    await expect(caller().enqueueReceipt({ ...input, locale: 'ur' })).resolves.toEqual(fallback);
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('turns a missing or offline bridge into a browser fallback, not a silent queue', async () => {
    sales.allocateSettledCounterReceiptPrintJob.mockResolvedValue(ready);
    for (const reason of ['NO_BRIDGE', 'BRIDGE_OFFLINE'] as const) {
      queue.selectPharmacyPrintBridge.mockRejectedValueOnce(new PharmacyPrintQueueError(reason));
      await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
        status: 'FALLBACK',
        code: reason,
        fallback: 'BROWSER_OS',
      });
    }
    queue.selectPharmacyPrintBridge.mockRejectedValueOnce(
      new PharmacyPrintQueueError('BRIDGE_REQUIRED')
    );
    await expect(caller().enqueueReceipt(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('current receipt-copy and settings contract', () => {
  const input = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en' as const,
    paper: 'THERMAL_58' as const,
    requestKey: 'click-0001',
  };

  it('uses the shared durable copy number and server reprint marking', async () => {
    sales.allocateSettledCounterReceiptPrintJob.mockResolvedValue({
      ...ready,
      result: { ...ready.result, copyNumber: 3, reprint: true },
    });
    await caller().enqueueReceipt(input);
    expect(queue.enqueuePharmacyReceiptPrint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ copyNumber: 3, reprint: true })
    );
  });

  it.each([false, true])(
    'rejects caller control over reprint=%s before allocation',
    async (reprint) => {
      await expect(caller().enqueueReceipt({ ...input, reprint } as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    }
  );

  it('requires a valid stable request key even for the first copy', async () => {
    await expect(
      caller().enqueueReceipt({ ...input, requestKey: undefined } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().enqueueReceipt({ ...input, requestKey: 'bad key!' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it('replays before allocating another copy or checking changed/offline settings', async () => {
    storage.pharmacyPrintJob.findUnique.mockResolvedValue(jobRow);
    storage.pharmacyBranch.findFirst.mockRejectedValue(new Error('settings unavailable'));
    queue.selectPharmacyPrintBridge.mockRejectedValue(
      new PharmacyPrintQueueError('BRIDGE_OFFLINE')
    );
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      replayed: true,
      job: { id: 'job-1' },
    });
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
    expect(storage.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...DEFAULT_RECEIPT_LAYOUT, browserPaper: 'A4' }, 'A4_OUTPUT'],
    [{ ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 80 }, 'PAPER_MISMATCH'],
  ])('refuses incompatible saved paper before allocation %#', async (layout, code) => {
    storage.pharmacyBranch.findFirst.mockResolvedValue({
      receiptLayout: layout,
      receiptLayoutRevision: 2,
    });
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code,
    });
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('checks receipt authorization before any queue access', async () => {
    sales.requireCounterReceiptAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller().enqueueReceipt(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(storage.pharmacyPrintJob.findUnique).not.toHaveBeenCalled();
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it('requires the pharmacy counter module', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().enqueueReceipt(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sales.requireCounterReceiptAccess).not.toHaveBeenCalled();
  });

  it('does not allocate a receipt for offline fallback', async () => {
    queue.selectPharmacyPrintBridge.mockRejectedValue(
      new PharmacyPrintQueueError('BRIDGE_OFFLINE')
    );
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'BRIDGE_OFFLINE',
    });
    expect(sales.allocateSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it.each([
    { ...DEFAULT_RECEIPT_LAYOUT, browserPaper: 'A4' },
    { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 80 },
  ])('refuses retry when the saved paper no longer matches %#', async (layout) => {
    storage.pharmacyBranch.findFirst.mockResolvedValue({
      receiptLayout: layout,
      receiptLayoutRevision: 3,
    });
    await expect(
      caller().retryJob({ branchId: input.branchId, jobId: 'job-1', confirmNoPaperPrinted: true })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(queue.retryPharmacyPrintJob).not.toHaveBeenCalled();
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

describe('DEV-904 bridge administration is admin-only and branch-scoped on the server', () => {
  const bridgeRow = {
    id: 'bridge-1',
    name: 'Front',
    status: 'ACTIVE' as const,
    revokedAt: null,
    lastSeenAt: null,
    printerId: 'queue:///Receipt_Printer',
    createdAt: NOW,
  };
  const outOfScope = () =>
    new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });

  it('lists bridges for administrators only, inside the branch scope', async () => {
    queue.listPharmacyPrintBridges.mockResolvedValue([bridgeRow]);
    await expect(caller('EMPLOYEE').bridges({ branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(queue.listPharmacyPrintBridges).not.toHaveBeenCalled();

    sales.branchScopeOrForbidden.mockRejectedValueOnce(outOfScope());
    await expect(caller('ADMIN').bridges({ branchId: 'branch-b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(queue.listPharmacyPrintBridges).not.toHaveBeenCalled();

    const listed = await caller('ADMIN').bridges({ branchId: 'branch-a' });
    expect(queue.listPharmacyPrintBridges).toHaveBeenCalledWith(expect.anything(), scope);
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'bridge-1',
        printerId: 'queue:///Receipt_Printer',
        online: false,
        createdAt: NOW.toISOString(),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/deviceSecretHash|ppb_/);
  });

  it('enrols only inside the administrator’s branch scope', async () => {
    sales.branchScopeOrForbidden.mockRejectedValueOnce(outOfScope());
    await expect(
      caller('ADMIN').enrollBridge({
        branchId: 'branch-b',
        name: 'Front',
        printerId: 'queue:///Receipt_Printer',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(queue.enrollPharmacyPrintBridge).not.toHaveBeenCalled();
  });

  it('revokes for administrators only, inside the branch scope', async () => {
    queue.revokePharmacyPrintBridge.mockResolvedValue({ ...bridgeRow, status: 'REVOKED' });
    await expect(
      caller('EMPLOYEE').revokeBridge({ branchId: 'branch-a', bridgeId: 'bridge-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    sales.branchScopeOrForbidden.mockRejectedValueOnce(outOfScope());
    await expect(
      caller('ADMIN').revokeBridge({ branchId: 'branch-b', bridgeId: 'bridge-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(queue.revokePharmacyPrintBridge).not.toHaveBeenCalled();

    queue.revokePharmacyPrintBridge.mockRejectedValueOnce(
      new PharmacyPrintQueueError('BRIDGE_NOT_FOUND')
    );
    await expect(
      caller('ADMIN').revokeBridge({ branchId: 'branch-a', bridgeId: 'other-branch-bridge' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      caller('ADMIN').revokeBridge({ branchId: 'branch-a', bridgeId: 'bridge-1' })
    ).resolves.toEqual({ bridgeId: 'bridge-1', status: 'REVOKED' });
    expect(queue.revokePharmacyPrintBridge).toHaveBeenLastCalledWith(
      expect.anything(),
      scope,
      'bridge-1',
      expect.any(Date)
    );
  });
});
