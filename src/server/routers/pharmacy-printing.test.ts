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
// DEV-742: the output guard reads the branch's saved receipt format.
const format = vi.hoisted(() => ({ readPharmacyReceiptFormat: vi.fn() }));
vi.mock('@/lib/pharmacy/receipt-print', () => format);
const queue = vi.hoisted(() => ({
  enqueuePharmacyReceiptPrint: vi.fn(),
  enqueuePharmacyTestPagePrint: vi.fn(),
  findPharmacyPrintJobByKey: vi.fn(),
  readPharmacyPrintJob: vi.fn(),
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
  kind: 'RECEIPT',
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
  format.readPharmacyReceiptFormat.mockResolvedValue({
    layout: { paperWidth: 58 },
    output: 'THERMAL',
    revision: 1,
  });
  queue.findPharmacyPrintJobByKey.mockResolvedValue(null);
  queue.readPharmacyPrintJob.mockResolvedValue(jobRow);
});

describe('pharmacyPrinting.enqueueReceipt', () => {
  const input = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en' as const,
    reprint: false,
    paper: 'THERMAL_58' as const,
  };

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

describe('DEV-742 output guard on pharmacyPrinting.enqueueReceipt', () => {
  const input = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en' as const,
    reprint: false,
    paper: 'THERMAL_58' as const,
  };

  it('cannot express A4: paper must be a thermal roll', async () => {
    await expect(caller().enqueueReceipt({ ...input, paper: 'A4' as never })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    const { paper: _omitted, ...withoutPaper } = input;
    void _omitted;
    await expect(caller().enqueueReceipt(withoutPaper as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(sales.buildSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
  });

  it('never queues for a branch whose saved paper is A4', async () => {
    format.readPharmacyReceiptFormat.mockResolvedValue({
      layout: { paperWidth: 58 },
      output: 'A4',
      revision: 2,
    });
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'A4_OUTPUT',
      fallback: 'BROWSER_OS',
    });
    expect(sales.buildSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('refuses a paper that differs from the saved roll width (stale or loading default)', async () => {
    await expect(caller().enqueueReceipt({ ...input, paper: 'THERMAL_80' })).resolves.toMatchObject(
      { status: 'FALLBACK', code: 'PAPER_MISMATCH' }
    );
    expect(sales.buildSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('refuses when the saved width changed between the guard and the build', async () => {
    sales.buildSettledCounterReceiptPrintJob.mockResolvedValue({
      ...ready,
      job: { ...ready.job, paperWidth: 80 },
    });
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'PAPER_MISMATCH',
    });
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('checks receipt access before reading any settings', async () => {
    sales.requireCounterReceiptAccess.mockRejectedValueOnce(
      Object.assign(new Error('Branch is outside your scope.'), { code: 'FORBIDDEN' })
    );
    await expect(caller().enqueueReceipt(input)).rejects.toThrow();
    expect(format.readPharmacyReceiptFormat).not.toHaveBeenCalled();
  });
});

describe('DEV-742 review fixes: replay first, in-transaction recheck, retry guard, corrupt settings', () => {
  const input = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    locale: 'en' as const,
    reprint: false,
    paper: 'THERMAL_58' as const,
  };
  const a4 = { layout: { paperWidth: 58 }, output: 'A4', revision: 2 };

  it('answers a replayed original with the queued job even after the branch moved to A4', async () => {
    queue.findPharmacyPrintJobByKey.mockResolvedValue(jobRow);
    format.readPharmacyReceiptFormat.mockResolvedValue(a4);
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'QUEUED',
      replayed: true,
      job: { id: 'job-1', paperConfirmed: false },
    });
    expect(queue.findPharmacyPrintJobByKey).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'sale:sale-a:original'
    );
    expect(sales.buildSettledCounterReceiptPrintJob).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('answers a replayed test-page click with its job, before any settings guard', async () => {
    queue.findPharmacyPrintJobByKey.mockResolvedValue({
      ...jobRow,
      kind: 'TEST_PAGE',
      saleId: null,
      receiptNumber: null,
    });
    format.readPharmacyReceiptFormat.mockResolvedValue(a4);
    await expect(
      caller().enqueueTestPage({
        branchId: 'branch-a',
        paper: 'THERMAL_58',
        requestKey: 'click-0001',
      })
    ).resolves.toMatchObject({ status: 'QUEUED', replayed: true, job: { kind: 'TEST_PAGE' } });
    expect(queue.findPharmacyPrintJobByKey).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'test:click-0001'
    );
  });

  it('refuses when the saved format changes between the guard and the queue write', async () => {
    sales.buildSettledCounterReceiptPrintJob.mockResolvedValue(ready);
    format.readPharmacyReceiptFormat
      .mockResolvedValueOnce({ layout: { paperWidth: 58 }, output: 'THERMAL', revision: 1 })
      .mockResolvedValueOnce(a4);
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'SETTINGS_CHANGED',
    });
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
  });

  it('fails closed with an explanation when saved settings are unreadable', async () => {
    format.readPharmacyReceiptFormat.mockRejectedValue(new Error('ZodError: corrupt layout'));
    await expect(caller().enqueueReceipt(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'SETTINGS_UNAVAILABLE',
    });
    await expect(
      caller().enqueueTestPage({
        branchId: 'branch-a',
        paper: 'THERMAL_58',
        requestKey: 'click-0002',
      })
    ).resolves.toMatchObject({ status: 'FALLBACK', code: 'SETTINGS_UNAVAILABLE' });
    expect(queue.enqueuePharmacyReceiptPrint).not.toHaveBeenCalled();
    expect(queue.enqueuePharmacyTestPagePrint).not.toHaveBeenCalled();
  });

  it.each([
    ['moved to A4', a4],
    ['changed roll width', { layout: { paperWidth: 80 }, output: 'THERMAL', revision: 3 }],
  ])('never resends stored bytes after the branch %s', async (_label, saved) => {
    format.readPharmacyReceiptFormat.mockResolvedValue(saved);
    await expect(
      caller().retryJob({ branchId: 'branch-a', jobId: 'job-1', confirmNoPaperPrinted: true })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(queue.retryPharmacyPrintJob).not.toHaveBeenCalled();
  });
});

describe('DEV-742 pharmacyPrinting.enqueueTestPage', () => {
  const input = { branchId: 'branch-a', paper: 'THERMAL_58' as const, requestKey: 'test-click-01' };
  const testRow = {
    ...jobRow,
    id: 'job-test',
    kind: 'TEST_PAGE',
    saleId: null,
    receiptNumber: null,
  };

  it('accepts no printable content and requires a per-click key', async () => {
    await expect(
      caller().enqueueTestPage({ ...input, lines: ['Free text'] } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().enqueueTestPage({ branchId: 'branch-a', paper: 'THERMAL_58' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().enqueueTestPage({ ...input, requestKey: 'bad key!' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(queue.enqueuePharmacyTestPagePrint).not.toHaveBeenCalled();
  });

  it('queues the server-built test page for the saved roll width', async () => {
    queue.enqueuePharmacyTestPagePrint.mockResolvedValue({ job: testRow, replayed: false });
    const result = await caller().enqueueTestPage(input);
    expect(sales.requireCounterReceiptAccess).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(queue.enqueuePharmacyTestPagePrint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'user-a',
        requestKey: 'test-click-01',
        paperWidth: 58,
        document: expect.objectContaining({
          title: 'PRINTER TEST PAGE',
          reference: 'NOT A RECEIPT - NO SALE',
        }),
      })
    );
    expect(result).toMatchObject({
      status: 'QUEUED',
      job: { kind: 'TEST_PAGE', saleId: null, receiptNumber: null, paperConfirmed: false },
    });
  });

  it('applies the same A4 and width guard', async () => {
    await expect(
      caller().enqueueTestPage({ ...input, paper: 'THERMAL_80' })
    ).resolves.toMatchObject({ status: 'FALLBACK', code: 'PAPER_MISMATCH' });
    format.readPharmacyReceiptFormat.mockResolvedValue({
      layout: { paperWidth: 58 },
      output: 'A4',
      revision: 2,
    });
    await expect(caller().enqueueTestPage(input)).resolves.toMatchObject({
      status: 'FALLBACK',
      code: 'A4_OUTPUT',
    });
    expect(queue.enqueuePharmacyTestPagePrint).not.toHaveBeenCalled();
  });

  it('turns a missing or offline bridge into a browser fallback', async () => {
    for (const reason of ['NO_BRIDGE', 'BRIDGE_OFFLINE'] as const) {
      queue.enqueuePharmacyTestPagePrint.mockRejectedValueOnce(new PharmacyPrintQueueError(reason));
      await expect(caller().enqueueTestPage(input)).resolves.toMatchObject({
        status: 'FALLBACK',
        code: reason,
        fallback: 'BROWSER_OS',
      });
    }
    queue.enqueuePharmacyTestPagePrint.mockRejectedValueOnce(
      new PharmacyPrintQueueError('BRIDGE_REQUIRED')
    );
    await expect(caller().enqueueTestPage(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
