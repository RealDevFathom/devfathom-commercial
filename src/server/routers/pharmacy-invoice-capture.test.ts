// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  hasModule: vi.fn(),
  canProcure: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  branch: vi.fn(),
  supplier: vi.fn(),
  suppliers: vi.fn(),
  receipt: vi.fn(),
  medicines: vi.fn(),
  lastLine: vi.fn(),
  extract: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/pharmacy/procurement-access', () => ({ actorCanProcure: mocks.canProcure }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit }));
vi.mock('@/lib/storage', () => ({ putUpload: vi.fn(), getUpload: vi.fn() }));
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual<typeof import('@/server/audit')>('@/server/audit')),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.audit,
}));

import { router, type TRPCContext } from '../trpc';
import { InvoiceCaptureError, normalizeInvoiceExtraction } from '@/lib/pharmacy/invoice-capture';
import {
  invoiceCaptureAdapterSeam,
  pharmacyInvoiceCaptureRouter,
} from './pharmacy-invoice-capture';

const testRouter = router({ pharmacyInvoiceCapture: pharmacyInvoiceCaptureRouter });

function context(userId = 'user-a', organizationId = 'org-a') {
  return {
    db: {
      pharmacyBranch: { findFirst: mocks.branch },
      pharmacySupplier: { findFirst: mocks.supplier, findMany: mocks.suppliers },
      pharmacyGoodsReceipt: { findFirst: mocks.receipt },
      medicine: { findMany: mocks.medicines },
      pharmacyGoodsReceiptLine: { findFirst: mocks.lastLine },
    },
    entitlements: { organizationId, modules: [], enabledModules: ['pharmacy-procurement'] },
    session: {
      expires: 'later',
      user: { id: userId, organizationId, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
const caller = (ctx = context()) => testRouter.createCaller(ctx).pharmacyInvoiceCapture;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF'
);
let photo: string;
const input = (overrides: Record<string, unknown> = {}) => ({
  branchId: 'branch-a',
  document: { contentType: 'image/png' as const, dataBase64: photo },
  ...overrides,
});

const field = (value: string | null, confidence = 0.95) => ({ value, confidence });
function readable(overrides: Record<string, unknown> = {}) {
  return normalizeInvoiceExtraction('FIXTURE', 'test-1', {
    supplier: field('Synthetic Medical Distributors'),
    invoiceNumber: field('SYN-INV-1001'),
    invoiceDate: field('2026-11-14'),
    lines: [
      {
        product: field('Synthetic Paracetamol 500mg'),
        pack: field('Box'),
        quantity: field('20'),
        bonus: field('10+1'),
        batch: field('SYN-B2741'),
        expiry: field('06/2028'),
        mrp: field('450.00'),
        tradePrice: field('382.50'),
        discount: field('0'),
        tax: field('0'),
      },
    ],
    ...overrides,
  });
}

const level = (id: string, name: string, units: number, parent: string | null) => ({
  id,
  level: name,
  unitsPerParent: units,
  parentPackLevelId: parent,
  effectiveFrom: new Date('2020-01-01'),
  effectiveTo: null,
});

beforeEach(async () => {
  vi.resetAllMocks();
  photo = (
    await sharp({ create: { width: 40, height: 20, channels: 3, background: 'white' } })
      .png()
      .toBuffer()
  ).toString('base64');
  mocks.hasModule.mockReturnValue(true);
  mocks.canProcure.mockResolvedValue(true);
  mocks.rateLimit.mockResolvedValue({ ok: true, retryAfter: 0, remaining: 10 });
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.supplier.mockResolvedValue(null);
  mocks.suppliers.mockResolvedValue([{ id: 'sup-a', name: 'Synthetic Medical Distributors' }]);
  mocks.receipt.mockResolvedValue(null);
  mocks.medicines.mockResolvedValue([
    {
      id: 'med-a',
      productName: 'Synthetic Paracetamol 500mg',
      brandName: null,
      presentations: [
        {
          packLevels: [
            level('pack-box', 'BOX', 10, null),
            level('pack-strip', 'STRIP', 10, 'pack-box'),
          ],
        },
      ],
    },
  ]);
  mocks.lastLine.mockResolvedValue({
    printedMrpMinor: 40_000,
    invoicedPricePerPackMinor: 38_250,
    goodsReceipt: {
      reference: 'GRN-9',
      receivedAt: new Date('2026-10-01T00:00:00Z'),
      supplier: { name: 'Synthetic Medical Distributors' },
    },
  });
  mocks.extract.mockResolvedValue(readable());
  invoiceCaptureAdapterSeam.resolve = () => ({
    name: 'FIXTURE',
    version: 'test-1',
    extract: mocks.extract,
  });
});

describe('pharmacyInvoiceCapture.read', () => {
  it('returns a reviewable draft matched against the register and the last purchase', async () => {
    const proposal = await caller().read(input());
    expect(proposal).toMatchObject({
      status: 'PROPOSED',
      requiresReviewerConfirmation: true,
      supplier: { match: { supplierId: 'sup-a' } },
      duplicate: null,
      invoiceDate: { date: '2026-11-14' },
    });
    expect(proposal.lines[0]).toMatchObject({
      medicine: { medicineId: 'med-a' },
      pack: { packLevelId: 'pack-box', canonicalUnitsPerPack: 100 },
      receivedPacks: 20,
      bonusPacks: 2,
      lastPurchase: { reference: 'GRN-9', printedMrpMinor: 40_000, tradePriceMinor: 38_250 },
      mrpCheck: { differenceMinor: 5_000, differenceBps: 1_250 },
      tradePriceCheck: { differenceMinor: 0 },
      warnings: ['MRP_DIFFERS_FROM_LAST_PURCHASE'],
    });
    // The last purchase is the tenant's own, posted, for the chosen pack.
    expect(mocks.lastLine).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          packLevelId: 'pack-box',
          goodsReceipt: { status: 'POSTED' },
        },
      })
    );
    // The reader only ever sees a re-encoded, metadata-free JPEG.
    const sent = mocks.extract.mock.calls[0]![0] as { content: Buffer; mimeType: string };
    expect(sent.mimeType).toBe('image/jpeg');
    expect((await sharp(sent.content).metadata()).exif).toBeUndefined();
  });

  it('flags a supplier bill already filed, case-insensitively, for this tenant and supplier', async () => {
    mocks.receipt.mockResolvedValue({ id: 'gr-1', reference: 'GRN-7', status: 'POSTED' });
    const proposal = await caller(context('user-a', 'org-b')).read(input());
    expect(proposal.duplicate).toEqual({
      goodsReceiptId: 'gr-1',
      reference: 'GRN-7',
      status: 'POSTED',
    });
    expect(proposal.warnings).toContain('DUPLICATE_SUPPLIER_INVOICE');
    expect(mocks.receipt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-b',
          supplierId: 'sup-a',
          supplierInvoiceRef: { equals: 'SYN-INV-1001', mode: 'insensitive' },
        },
      })
    );
  });

  it('uses the supplier already chosen on the form, scoped to the session tenant', async () => {
    mocks.supplier.mockResolvedValue({ id: 'sup-chosen', name: 'Chosen' });
    const proposal = await caller().read(input({ supplierId: 'sup-chosen' }));
    expect(proposal.supplier.match).toEqual({ supplierId: 'sup-chosen', name: 'Chosen' });
    expect(mocks.supplier).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sup-chosen', organizationId: 'org-a' } })
    );
    expect(mocks.suppliers).not.toHaveBeenCalled();
  });

  it('refuses a supplier from another tenant before reading anything', async () => {
    await expect(caller().read(input({ supplierId: 'sup-foreign' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('never picks a supplier or medicine when the name is not exactly one record', async () => {
    mocks.suppliers.mockResolvedValue([
      { id: 'sup-a', name: 'A' },
      { id: 'sup-b', name: 'A' },
    ]);
    mocks.medicines
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'med-z', productName: 'Synthetic Paracetamol 250mg' }]);
    const proposal = await caller().read(input());
    expect(proposal.supplier.match).toBeNull();
    expect(proposal.duplicate).toBeNull();
    expect(proposal.lines[0]).toMatchObject({
      medicine: null,
      pack: null,
      candidates: [{ medicineId: 'med-z', productName: 'Synthetic Paracetamol 250mg' }],
      lastPurchase: null,
    });
    expect(mocks.lastLine).not.toHaveBeenCalled();
  });

  it('reads a PDF as a PDF and refuses a file that is not one', async () => {
    await caller().read(
      input({ document: { contentType: 'application/pdf', dataBase64: PDF.toString('base64') } })
    );
    expect(mocks.extract).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/pdf', organizationId: 'org-a' })
    );
    mocks.extract.mockClear();
    await expect(
      caller().read(input({ document: { contentType: 'application/pdf', dataBase64: photo } }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses a PDF longer than one invoice', async () => {
    const long = Buffer.from(
      `%PDF-1.4\n2 0 obj << /Type /Pages /Count 9 >> endobj\n${'<< /Type /Page >>\n'.repeat(9)}`
    );
    await expect(
      caller().read(
        input({ document: { contentType: 'application/pdf', dataBase64: long.toString('base64') } })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/9 pages/) });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses an actor without receiving capability before reading anything', async () => {
    mocks.canProcure.mockResolvedValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branch).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses when the procurement module is not licensed', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses an inactive or foreign branch', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('explains manual entry when no reader is configured', async () => {
    invoiceCaptureAdapterSeam.resolve = () => null;
    await expect(caller().read(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/by hand/),
    });
  });

  it('rate-limits per actor and per tenant before calling the reader', async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ ok: true, retryAfter: 0, remaining: 1 })
      .mockResolvedValueOnce({ ok: false, retryAfter: 30, remaining: 0 });
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      'pharmacy-invoice-capture:org-a:user-a',
      6,
      60_000
    );
    expect(mocks.rateLimit).toHaveBeenLastCalledWith(
      'pharmacy-invoice-capture:org:org-a',
      20,
      60_000
    );
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('maps a reader failure to a manual-entry sentence without provider detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.extract.mockRejectedValue(
      new InvoiceCaptureError('invoice text echo', 'PROVIDER_FAILED')
    );
    const failure = caller().read(input());
    await expect(failure).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: 'The invoice could not be read. Enter the lines by hand.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('invoice text echo');
    log.mockRestore();
  });

  it('never writes the file to the audit row and writes nothing else', async () => {
    const ctx = context();
    await caller(ctx).read(input());
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const [row] = mocks.audit.mock.calls[0] as [
      { ctx: { audit: { detail: { skipInput?: boolean; action?: string } } } },
    ];
    expect(row.ctx.audit.detail.skipInput).toBe(true);
    expect(row.ctx.audit.detail.action).toBe('invoice_capture.read');
    expect(JSON.stringify(row.ctx.audit.detail)).not.toContain(photo.slice(0, 24));
    // Reads only: every model the procedure touches exposes a read, never a write.
    for (const model of Object.values((ctx as unknown as { db: Record<string, object> }).db)) {
      expect(Object.keys(model).every((name) => name.startsWith('find'))).toBe(true);
    }
  });
});
