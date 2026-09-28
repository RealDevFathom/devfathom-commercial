import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async (subject: { role: string }) => subject.role === 'ADMIN'),
}));
vi.mock('@/lib/pharmacy/counter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter')>()),
  readCounterReceipt: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import { PharmacyCounterError, readCounterReceipt } from '@/lib/pharmacy/counter';
import type { CounterReceipt } from '@/lib/pharmacy/counter-receipt';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { PrintDocumentSchema, validateRawPrintDocument } from '@/lib/restaurant/printing/contract';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const receipt: CounterReceipt = {
  saleId: 'sale-history-1',
  receiptNumber: 77,
  branchName: 'Main Branch',
  businessDate: '2026-08-02',
  completedAt: '2026-08-02T10:00:00.000Z',
  currency: 'PKR',
  lines: [
    {
      saleLineId: 'line-1',
      identityStatus: 'ISSUED',
      medicineName: 'Augmentin',
      strength: '625 mg',
      presentation: 'Tablet',
      allocations: [
        {
          allocationId: 'a-1',
          inventoryLotId: 'lot-1',
          batchNumber: 'AG-11',
          expiresAt: '2027-05-31',
          canonicalUnits: 6,
        },
      ],
      batchNumber: 'AG-11 (6 units)',
      expiresAt: '2027-05-31',
      saleUnit: 'STRIP',
      quantity: 1,
      canonicalUnits: 6,
      unitPriceMinor: 45_000,
      discountMinor: 0,
      lineTotalMinor: 45_000,
    },
  ],
  tenders: [{ tenderId: 't-1', type: 'CARD', amountMinor: 45_000, changeGivenMinor: null }],
  totals: {
    grossMinor: 45_000,
    discountMinor: 0,
    netMinor: 45_000,
    tenderedMinor: 45_000,
    changeMinor: 0,
  },
};

function fixture(role = 'EMPLOYEE') {
  const branchRead = vi.fn().mockResolvedValue({
    name: 'Main Branch',
    receiptLayout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 },
    receiptLayoutRevision: 4,
  });
  const branchUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const profileRead = vi.fn().mockResolvedValue({ ntn: '7654321-0', strn: null });
  const db = {
    pharmacyBranch: { findFirst: branchRead, updateMany: branchUpdate },
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR' }) },
    branchRegulatoryProfile: { findFirst: profileRead },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  const caller = (overrides: Partial<TRPCContext> = {}) =>
    app.createCaller({ ...context, ...overrides }).pharmacySales;
  return { db, branchRead, branchUpdate, profileRead, caller };
}

const input = { branchId: 'branch-1', saleId: 'sale-history-1', locale: 'en' as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  vi.mocked(readCounterReceipt).mockResolvedValue(structuredClone(receipt));
});

describe('pharmacySales.counterReceiptPrintJob', () => {
  it('is a read that returns a validated ESC/POS RECEIPT job in the saved branch format', async () => {
    const f = fixture();
    expect(pharmacySalesRouter._def.procedures.counterReceiptPrintJob._def.type).toBe('query');
    const result = await f.caller().counterReceiptPrintJob({ ...input, reprint: false });

    expect(result.status).toBe('READY');
    if (result.status !== 'READY') return;
    expect(PrintDocumentSchema.safeParse(result.document).success).toBe(true);
    expect(validateRawPrintDocument(result.document)).toEqual(result.document);
    expect(result.paperWidth).toBe(58);
    const body = Buffer.from(result.escPos.data, 'base64').toString('latin1');
    expect(body).toContain('Invoice: Receipt 77');
    expect(body).toContain('NTN: 7654321-0');
    expect(hasModule).toHaveBeenCalledWith(expect.anything(), 'pharmacy-counter');
    expect(vi.mocked(readCounterReceipt).mock.calls[0]!.slice(1, 3)).toEqual([
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      'sale-history-1',
    ]);
    // NTN is read as of the original sale, not today.
    expect(f.profileRead.mock.calls[0]![0].where.effectiveFrom).toEqual({
      lte: new Date('2026-08-02T10:00:00.000Z'),
    });
    expect(f.branchUpdate).not.toHaveBeenCalled();
  });

  it('reprints from history with the stored receipt number and a reprint marker', async () => {
    const f = fixture();
    const result = await f.caller().counterReceiptPrintJob({ ...input, reprint: true });
    expect(result).toMatchObject({
      status: 'READY',
      reprint: true,
      document: { reference: 'receipt:77', title: 'Receipt 77 (reprint)' },
    });
    if (result.status !== 'READY') return;
    const body = Buffer.from(result.escPos.data, 'base64').toString('latin1');
    expect(body).toContain('REPRINT - not a new sale');
    expect(f.branchUpdate).not.toHaveBeenCalled();
  });

  it('returns the browser/OS fallback for Urdu without a payload', async () => {
    const f = fixture();
    await expect(
      f.caller().counterReceiptPrintJob({ ...input, locale: 'ur', reprint: false })
    ).resolves.toEqual({
      status: 'FALLBACK',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
    });
  });

  it('refuses an unsettled bill with CONFLICT', async () => {
    const f = fixture();
    vi.mocked(readCounterReceipt).mockResolvedValue({ ...receipt, receiptNumber: null });
    await expect(
      f.caller().counterReceiptPrintJob({ ...input, reprint: false })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.profileRead).not.toHaveBeenCalled();
  });

  it('maps a foreign sale to NOT_FOUND and a foreign branch to FORBIDDEN', async () => {
    const f = fixture();
    vi.mocked(readCounterReceipt).mockRejectedValue(new PharmacyCounterError('NOT_FOUND'));
    await expect(
      f.caller().counterReceiptPrintJob({ ...input, reprint: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    f.branchRead.mockResolvedValue(null);
    await expect(
      f.caller().counterReceiptPrintJob({ ...input, branchId: 'foreign', reprint: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a session and the counter module before reading the sale', async () => {
    const f = fixture();
    await expect(
      f.caller({ session: null }).counterReceiptPrintJob({ ...input, reprint: false })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(
      f.caller().counterReceiptPrintJob({ ...input, reprint: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readCounterReceipt).not.toHaveBeenCalled();
  });
});

describe('pharmacySales receipt format setting', () => {
  it('reads the branch format for any counter user', async () => {
    const f = fixture();
    await expect(f.caller().counterReceiptFormat({ branchId: 'branch-1' })).resolves.toEqual({
      layout: { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 },
      revision: 4,
    });
  });

  it('lets an admin save the branch format with an optimistic revision', async () => {
    const f = fixture('ADMIN');
    const layout = {
      ...DEFAULT_RECEIPT_LAYOUT,
      paperWidth: 80 as const,
      headerText: 'NTN on file',
    };
    await expect(
      f.caller().counterSaveReceiptFormat({ branchId: 'branch-1', revision: 4, layout })
    ).resolves.toEqual({ layout, revision: 5 });
    expect(f.branchUpdate).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1', active: true, receiptLayoutRevision: 4 },
      data: { receiptLayout: layout, receiptLayoutRevision: { increment: 1 } },
    });
  });

  it('refuses a non-admin save before writing', async () => {
    const f = fixture('EMPLOYEE');
    await expect(
      f.caller().counterSaveReceiptFormat({
        branchId: 'branch-1',
        revision: 4,
        layout: { ...DEFAULT_RECEIPT_LAYOUT },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.branchUpdate).not.toHaveBeenCalled();
  });
});
