// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  hasModule: vi.fn(),
  canProcure: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  line: vi.fn(),
  branch: vi.fn(),
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
import { PackLabelOcrError, normalizePackLabelExtraction } from '@/lib/pharmacy/pack-label-ocr';
import { packLabelAdapterSeam, pharmacyPackLabelRouter } from './pharmacy-pack-label';

// Production path, so the module-licence guard maps `pharmacyPackLabel` to procurement.
const testRouter = router({ pharmacyPackLabel: pharmacyPackLabelRouter });

function context(userId = 'user-a', organizationId = 'org-a') {
  return {
    db: {
      pharmacyPurchaseOrderLine: { findFirst: mocks.line },
      pharmacyBranch: { findFirst: mocks.branch },
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
const caller = (ctx = context()) => testRouter.createCaller(ctx).pharmacyPackLabel;

let photo: string;
const input = () => ({
  branchId: 'branch-a',
  purchaseOrderId: 'po-a',
  purchaseOrderLineId: 'pol-a',
  photo: { contentType: 'image/png' as const, dataBase64: photo },
});

function readable(overrides: Record<string, unknown> = {}) {
  return normalizePackLabelExtraction('FIXTURE', 'test-1', {
    batch: { value: 'SYN-B2741', confidence: 0.93 },
    expiry: { value: 'EXP 06/2028', confidence: 0.9 },
    serialPrinted: false,
    ...overrides,
  });
}

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
  mocks.line.mockResolvedValue({
    id: 'pol-a',
    medicineId: 'med-a',
    packLevelId: 'pack-a',
    purchaseOrder: { branchId: 'branch-a', status: 'SENT' },
  });
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.extract.mockResolvedValue(readable());
  packLabelAdapterSeam.resolve = () => ({
    name: 'FIXTURE',
    version: 'test-1',
    extract: mocks.extract,
  });
});

describe('pharmacyPackLabel.read', () => {
  it('returns an editable proposal and never the medicine or a quantity', async () => {
    const proposal = await caller().read(input());
    expect(proposal).toMatchObject({
      status: 'PROPOSED',
      requiresReceiverConfirmation: true,
      batch: { value: 'SYN-B2741' },
      expiry: { kind: 'read', candidate: { date: '2028-06-30', precision: 'MONTH' } },
    });
    expect(JSON.stringify(proposal)).not.toMatch(/medicineId|packLevelId|quantity|packs/i);
    // The reader only ever sees a re-encoded, metadata-free JPEG.
    const sent = mocks.extract.mock.calls[0]![0] as { content: Buffer; mimeType: string };
    expect(sent.mimeType).toBe('image/jpeg');
    expect((await sharp(sent.content).metadata()).format).toBe('jpeg');
    expect((await sharp(sent.content).metadata()).exif).toBeUndefined();
  });

  it('scopes the order line to the session tenant, never an input tenant', async () => {
    await caller(context('user-a', 'org-b')).read(input());
    expect(mocks.line).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-a', purchaseOrderId: 'po-a', organizationId: 'org-b' },
      })
    );
    expect(mocks.branch).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'branch-a', organizationId: 'org-b', active: true } })
    );
  });

  it('refuses an actor without receiving capability before reading anything', async () => {
    mocks.canProcure.mockResolvedValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.line).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses when the procurement module is not licensed', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it.each([
    ['another tenant or order (not found)', null],
    [
      'an order out for another branch',
      { id: 'pol-a', purchaseOrder: { branchId: 'branch-b', status: 'SENT' } },
    ],
    ['a draft order', { id: 'pol-a', purchaseOrder: { branchId: 'branch-a', status: 'DRAFT' } }],
  ])('refuses %s', async (_label, line) => {
    mocks.line.mockResolvedValue(line);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('accepts an organization-wide order received at the chosen branch', async () => {
    mocks.line.mockResolvedValue({
      id: 'pol-a',
      medicineId: 'med-a',
      packLevelId: 'pack-a',
      purchaseOrder: { branchId: null, status: 'RECEIVING' },
    });
    await expect(caller().read(input())).resolves.toMatchObject({ status: 'PROPOSED' });
  });

  it('refuses an inactive or foreign branch', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('explains manual entry when no reader is configured', async () => {
    packLabelAdapterSeam.resolve = () => null;
    await expect(caller().read(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/by hand/),
    });
  });

  it('rate-limits per tenant and actor before calling the reader', async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false, retryAfter: 30, remaining: 0 });
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('pharmacy-pack-label:org-a:user-a', 20, 60_000);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it.each([
    ['not an image', Buffer.from('not an image').toString('base64'), 'image/png'],
    ['a type that does not match its bytes', null, 'image/jpeg'],
    ['non-canonical base64', 'aGVsbG8=\n', 'image/png'],
  ])('rejects %s without calling the reader', async (_label, data, contentType) => {
    await expect(
      caller().read({
        ...input(),
        photo: { contentType: contentType as 'image/png', dataBase64: data ?? photo },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it.each([
    ['provider failure', new PackLabelOcrError('down', 'PROVIDER_FAILED'), 'BAD_GATEWAY'],
    ['malformed output', new PackLabelOcrError('bad', 'MALFORMED_OUTPUT'), 'BAD_GATEWAY'],
    [
      'unconfigured provider',
      new PackLabelOcrError('cfg', 'ADAPTER_UNAVAILABLE'),
      'PRECONDITION_FAILED',
    ],
    ['unexpected error', new Error('provider said secret-detail'), 'BAD_GATEWAY'],
  ])('maps %s to a manual-entry sentence without provider detail', async (_l, error, code) => {
    mocks.extract.mockRejectedValue(error);
    const failure = caller().read(input());
    await expect(failure).rejects.toMatchObject({
      code,
      message: 'The pack photo could not be read. Enter the batch and expiry by hand.',
    });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringMatching(/secret/) });
  });

  it('keeps unreadable values empty instead of inventing them', async () => {
    mocks.extract.mockResolvedValue(
      readable({
        batch: { value: null, confidence: 0.99 },
        expiry: { value: 'MFG 01/2026 EXP 01/2028', confidence: 0.8 },
      })
    );
    const proposal = await caller().read(input());
    expect(proposal.batch).toEqual({ value: null, confidence: 0 });
    expect(proposal.expiry.kind).toBe('unreadable');
    expect(proposal.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['BATCH_UNREADABLE', 'EXPIRY_UNREADABLE'])
    );
  });

  it('flags a printed serial so the bench cannot clone it across packs', async () => {
    mocks.extract.mockResolvedValue(readable({ serialPrinted: true }));
    const proposal = await caller().read(input());
    expect(proposal.serialPrinted).toBe(true);
    expect(proposal.warnings.map((w) => w.code)).toContain('SERIAL_PRINTED');
  });

  it('never writes the photo to the audit row, even when the request is denied', async () => {
    await caller().read(input());
    mocks.canProcure.mockResolvedValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.audit).toHaveBeenCalledTimes(3);
    for (const [row] of mocks.audit.mock.calls as [
      { ctx: TRPCContext & { audit: { detail: Record<string, unknown> } }; input: unknown },
    ][]) {
      expect(row.ctx.audit.detail.skipInput).toBe(true);
    }
    const success = mocks.audit.mock.calls[0]![0] as {
      ctx: { audit: { detail: { action?: string; metadata?: Record<string, unknown> } } };
    };
    expect(success.ctx.audit.detail.action).toBe('pack_label.read');
    expect(success.ctx.audit.detail.metadata).toMatchObject({
      purchaseOrderId: 'po-a',
      photoSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      suggestedBatch: 'SYN-B2741',
    });
    expect(JSON.stringify(success.ctx.audit.detail)).not.toContain(photo.slice(0, 24));
  });

  it('is not a stock or receipt write: it touches only the line and branch reads', async () => {
    const ctx = context();
    await caller(ctx).read(input());
    expect(Object.keys((ctx as unknown as { db: object }).db)).toEqual([
      'pharmacyPurchaseOrderLine',
      'pharmacyBranch',
    ]);
    expect(mocks.line).toHaveBeenCalledTimes(1);
    expect(mocks.branch).toHaveBeenCalledTimes(1);
  });
});
