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

  it('caps reads tenant-wide so many receivers cannot multiply provider spend', async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ ok: true, retryAfter: 0, remaining: 10 })
      .mockResolvedValueOnce({ ok: false, retryAfter: 30, remaining: 0 });
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mocks.rateLimit).toHaveBeenLastCalledWith('pharmacy-pack-label:org:org-a', 60, 60_000);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('attributes provider spend to the session tenant', async () => {
    await caller(context('user-a', 'org-b')).read(input());
    expect(mocks.extract).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-b', mimeType: 'image/jpeg' })
    );
  });

  it('flattens a transparent label onto white instead of black', async () => {
    const transparent = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    await caller().read({
      ...input(),
      photo: { contentType: 'image/png', dataBase64: transparent.toString('base64') },
    });
    const sent = mocks.extract.mock.calls[0]![0] as { content: Buffer };
    const { channels } = await sharp(sent.content).stats();
    expect(channels[0]!.mean).toBeGreaterThan(250);
  });

  it('logs only the reason and adapter when the reader fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.extract.mockRejectedValue(new PackLabelOcrError('label text echo', 'PROVIDER_FAILED'));
    await expect(caller().read(input())).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(log).toHaveBeenCalledWith('[pharmacyPackLabel.read] reader failed', {
      adapter: 'FIXTURE',
      reason: 'PROVIDER_FAILED',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('label text echo');
    log.mockRestore();
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

describe('pharmacyPackLabel.read printed price (DEV-770)', () => {
  const packPrice = vi.fn();
  function pricedContext(organizationId = 'org-a') {
    const ctx = context('user-a', organizationId) as unknown as { db: Record<string, unknown> };
    ctx.db.pharmacyPackPrice = { findFirst: packPrice };
    return ctx as unknown as TRPCContext;
  }
  const priced = (value: string | null, confidence = 0.9) =>
    readable({ price: { value, confidence } });

  beforeEach(() => {
    packPrice.mockReset();
  });

  it('suggests batch, expiry and MRP from a clear label that matches the current price', async () => {
    mocks.extract.mockResolvedValue(priced('MRP Rs. 450.00'));
    packPrice.mockResolvedValueOnce({ mrpMinor: 45_000 });
    const proposal = await caller(pricedContext()).read(input());
    expect(proposal).toMatchObject({
      status: 'PROPOSED',
      requiresReceiverConfirmation: true,
      batch: { value: 'SYN-B2741' },
      expiry: { kind: 'read', candidate: { date: '2028-06-30' } },
      price: { kind: 'read', amountMinor: 45_000, confidence: 0.9 },
      currentMrpMinor: 45_000,
      warnings: [],
    });
  });

  it('reads the current price from the pack record of the session tenant, branch first', async () => {
    mocks.extract.mockResolvedValue(priced('MRP Rs. 495.00'));
    packPrice.mockResolvedValueOnce(null).mockResolvedValueOnce({ mrpMinor: 45_000 });
    const proposal = await caller(pricedContext('org-b')).read(input());
    expect(packPrice).toHaveBeenCalledTimes(2);
    expect(packPrice.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: 'org-b', packLevelId: 'pack-a', branchId: 'branch-a' },
    });
    expect(packPrice.mock.calls[1]![0]).toMatchObject({
      where: { organizationId: 'org-b', packLevelId: 'pack-a', branchId: null },
    });
    // Both prices go back so the receiver chooses; neither is applied here.
    expect(proposal.price).toMatchObject({ kind: 'read', amountMinor: 49_500 });
    expect(proposal.currentMrpMinor).toBe(45_000);
    expect(proposal.warnings.map((w) => w.code)).toEqual(['PRICE_DIFFERS_FROM_CURRENT']);
  });

  it('leaves an unreadable price empty, says so, and does not look up a price', async () => {
    mocks.extract.mockResolvedValue(priced(null, 0.99));
    const proposal = await caller(pricedContext()).read(input());
    expect(proposal.price).toEqual({ kind: 'unreadable', printed: null, confidence: 0 });
    expect(proposal.currentMrpMinor).toBeNull();
    expect(proposal.warnings.map((w) => w.code)).toEqual(['PRICE_UNREADABLE']);
    expect(packPrice).not.toHaveBeenCalled();
  });

  it('rejects two prices on one label without choosing one', async () => {
    mocks.extract.mockResolvedValue(priced('MRP Rs 450 | MRP Rs 495', 0.97));
    const proposal = await caller(pricedContext()).read(input());
    expect(proposal.price).toEqual({
      kind: 'ambiguous',
      printed: 'MRP Rs 450 | MRP Rs 495',
      confidence: 0,
    });
    expect(proposal.warnings.map((w) => w.code)).toEqual(['PRICE_AMBIGUOUS']);
    expect(packPrice).not.toHaveBeenCalled();
  });

  it('audits the suggested and current price, and writes nothing', async () => {
    mocks.extract.mockResolvedValue(priced('MRP Rs. 495.00'));
    packPrice.mockResolvedValueOnce({ mrpMinor: 45_000 });
    const ctx = pricedContext();
    await caller(ctx).read(input());
    const row = mocks.audit.mock.calls[0]![0] as {
      ctx: { audit: { detail: { metadata?: Record<string, unknown> } } };
    };
    expect(row.ctx.audit.detail.metadata).toMatchObject({
      priceKind: 'read',
      suggestedMrpMinor: 49_500,
      currentMrpMinor: 45_000,
    });
    expect(
      Object.values((ctx as unknown as { db: Record<string, object> }).db).flatMap(Object.keys)
    ).toEqual(['findFirst', 'findFirst', 'findFirst']);
  });
});
