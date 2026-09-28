import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECEIPT_LAYOUT, type ReceiptLayout } from '@/lib/receipts/configuration';
import {
  PrintDocumentSchema,
  RawPrintValidationError,
  validateRawPrintDocument,
} from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';

import { buildCounterBrowserReceipt } from './counter-browser-print';
import type { CounterReceipt } from './counter-receipt';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import {
  buildPharmacyReceiptEscPosJob,
  buildPharmacyReceiptPrintDocument,
  PharmacyReceiptPrintError,
  readPharmacyReceiptFormat,
  readPharmacyReceiptTaxIdentity,
  savePharmacyReceiptFormat,
} from './receipt-print';

/** A settled two-line fixture sale, as `readCounterReceipt` returns it. */
function fixtureSale(overrides: Partial<CounterReceipt> = {}): CounterReceipt {
  return {
    saleId: 'sale-1',
    receiptNumber: 1042,
    branchName: 'Gulberg Branch',
    businessDate: '2026-09-28',
    completedAt: '2026-09-28T09:15:00.000Z',
    currency: 'PKR',
    lines: [
      {
        saleLineId: 'line-1',
        identityStatus: 'ISSUED',
        medicineName: 'Panadol',
        strength: '500 mg',
        presentation: 'Tablet',
        allocations: [
          {
            allocationId: 'alloc-1',
            inventoryLotId: 'lot-1',
            batchNumber: 'PX-2291',
            expiresAt: '2027-03-31',
            canonicalUnits: 10,
          },
        ],
        batchNumber: 'PX-2291 (10 units)',
        expiresAt: '2027-03-31',
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnits: 10,
        unitPriceMinor: 12_000,
        discountMinor: 0,
        lineTotalMinor: 12_000,
      },
      {
        saleLineId: 'line-2',
        identityStatus: 'UNAVAILABLE',
        medicineName: 'Historical identity unavailable',
        strength: null,
        presentation: 'Historical identity unavailable',
        allocations: [
          {
            allocationId: 'alloc-2',
            inventoryLotId: 'lot-2',
            batchNumber: null,
            expiresAt: null,
            canonicalUnits: 2,
          },
        ],
        batchNumber: 'Historical batches unavailable',
        expiresAt: '',
        saleUnit: 'UNIT',
        quantity: 2,
        canonicalUnits: 2,
        unitPriceMinor: 500,
        discountMinor: 100,
        lineTotalMinor: 900,
      },
    ],
    tenders: [{ tenderId: 'tender-1', type: 'CASH', amountMinor: 15_000, changeGivenMinor: 2_100 }],
    totals: {
      grossMinor: 13_000,
      discountMinor: 100,
      netMinor: 12_900,
      tenderedMinor: 15_000,
      changeMinor: 2_100,
    },
    ...overrides,
  };
}

const taxIdentity = { ntn: '1234567-8', strn: null };
const layout: ReceiptLayout = { ...DEFAULT_RECEIPT_LAYOUT };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildPharmacyReceiptPrintDocument', () => {
  it('builds a RECEIPT job that validates against PrintDocumentSchema and the raw contract', () => {
    const document = buildPharmacyReceiptPrintDocument(fixtureSale(), 'en', {
      layout,
      taxIdentity,
      reprint: false,
    });

    expect(PrintDocumentSchema.safeParse(document).success).toBe(true);
    expect(validateRawPrintDocument(document)).toEqual(document);
    expect(document).toMatchObject({
      type: 'RECEIPT',
      reference: 'receipt:1042',
      title: 'Receipt 1042',
      createdAt: '2026-09-28T09:15:00.000Z',
      lines: [
        { quantity: 1, label: 'Panadol - 500 mg - Tablet' },
        { quantity: 2, label: 'Historical identity unavailable' },
      ],
    });
    expect(document.receiptSnapshot?.layout).toEqual(layout);
  });

  it('renders ESC/POS bytes with receipt number, NTN, batch, expiry and settled totals', () => {
    const job = buildPharmacyReceiptEscPosJob(fixtureSale(), 'en', {
      layout,
      taxIdentity,
      reprint: false,
    });
    const bytes = Buffer.from(job.escPos.data, 'base64');
    const body = decode(bytes);

    expect(job.escPos.byteCount).toBe(bytes.length);
    expect(Uint8Array.from(bytes)).toEqual(renderEscPos(job.document));
    // Initialize … cut.
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(-3)]).toEqual([0x1d, 0x56, 0x00]);
    expect(body).toContain('Gulberg Branch');
    expect(body).toContain('Invoice: Receipt 1042');
    expect(body).toContain('Date: 2026-09-28');
    expect(body).toContain('NTN: 1234567-8');
    expect(body).not.toContain('STRN');
    expect(body).toContain('Batch: PX-2291 | Expiry: 2027-03-31 | Units: 10');
    expect(body).toContain('1 strip x 120.00');
    // Unissued historical identity never borrows a live batch label.
    // (wrapped at the 80 mm / 48-column cell width)
    expect(body).toContain('Batch: Unavailable | Expiry: Unavailable |\nUnits: 2');
    expect(body).toContain('Total: 129.00');
    expect(body).toContain('Change: 21.00');
    expect(body).toContain('CASH: 150.00');
    expect(body).toContain('Tax breakdown unavailable in receipt source');
    expect(body).not.toContain('REPRINT');
    expect(body).toContain(DEFAULT_RECEIPT_LAYOUT.footerText);
  });

  it.each([58, 80] as const)('honours the branch %s mm paper width', (paperWidth) => {
    const job = buildPharmacyReceiptEscPosJob(fixtureSale(), 'en', {
      layout: { ...layout, paperWidth },
      taxIdentity,
      reprint: false,
    });
    const body = decode(Buffer.from(job.escPos.data, 'base64').subarray(8, -3));
    const columns = paperWidth === 58 ? 32 : 48;
    expect(job.paperWidth).toBe(paperWidth);
    expect(body.split('\n').every((line) => line.length <= columns)).toBe(true);
    expect(body).toContain('-'.repeat(columns));
  });

  it('reprints a historical sale with the same receipt number and an explicit marker', () => {
    const history = fixtureSale({
      businessDate: '2026-08-01',
      completedAt: '2026-08-01T12:00:00Z',
    });
    const original = buildPharmacyReceiptEscPosJob(history, 'en', {
      layout,
      taxIdentity,
      reprint: false,
    });
    const reprint = buildPharmacyReceiptEscPosJob(history, 'en', {
      layout,
      taxIdentity,
      reprint: true,
    });

    expect(reprint.reprint).toBe(true);
    expect(reprint.document.reference).toBe(original.document.reference);
    expect(reprint.document.title).toBe('Receipt 1042 (reprint)');
    expect(reprint.document.createdAt).toBe('2026-08-01T12:00:00.000Z');
    const originalBody = decode(Buffer.from(original.escPos.data, 'base64'));
    const reprintBody = decode(Buffer.from(reprint.escPos.data, 'base64'));
    expect(reprintBody).toContain('Invoice: Receipt 1042');
    expect(reprintBody).toContain('Date: 2026-08-01\nREPRINT - not a new sale');
    // Only the marker differs: same lines, totals and tenders.
    expect(reprintBody.replace('REPRINT - not a new sale\n', '')).toBe(originalBody);
  });

  it('prints STRN when registered and omits NTN when absent', () => {
    const job = buildPharmacyReceiptEscPosJob(fixtureSale(), 'en', {
      layout,
      taxIdentity: { ntn: null, strn: '17-00-1234-567-89' },
      reprint: false,
    });
    const body = decode(Buffer.from(job.escPos.data, 'base64'));
    expect(body).not.toContain('NTN');
    expect(body).toContain('STRN: 17-00-1234-567-89');
  });

  it('refuses Urdu with the browser/OS fallback instead of garbling the raw printer', () => {
    const attempt = () =>
      buildPharmacyReceiptPrintDocument(fixtureSale(), 'ur', {
        layout,
        taxIdentity,
        reprint: false,
      });
    expect(attempt).toThrow(RawPrintValidationError);
    expect(attempt).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' })
    );
  });

  it('refuses non-ASCII English data with the browser/OS fallback', () => {
    const sale = fixtureSale();
    sale.branchName = 'صدر برانچ';
    expect(() =>
      buildPharmacyReceiptPrintDocument(sale, 'en', { layout, taxIdentity, reprint: false })
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' }));
  });

  it('refuses unsettled bills: a print never issues a receipt number', () => {
    expect(() =>
      buildPharmacyReceiptPrintDocument(fixtureSale({ receiptNumber: null }), 'en', {
        layout,
        taxIdentity,
        reprint: false,
      })
    ).toThrow(PharmacyReceiptPrintError);
    expect(() =>
      buildPharmacyReceiptPrintDocument(fixtureSale({ completedAt: null }), 'en', {
        layout,
        taxIdentity,
        reprint: true,
      })
    ).toThrow(PharmacyReceiptPrintError);
  });

  it('rejects unsafe amounts and out-of-contract quantities without a payload', () => {
    const unsafe = fixtureSale();
    unsafe.totals.netMinor = Number.MAX_SAFE_INTEGER + 1;
    expect(() =>
      buildPharmacyReceiptPrintDocument(unsafe, 'en', { layout, taxIdentity, reprint: false })
    ).toThrow(expect.objectContaining({ code: 'INVALID_PRINT_DOCUMENT', fallback: null }));
    const bulk = fixtureSale();
    bulk.lines[0]!.quantity = 1000;
    expect(() =>
      buildPharmacyReceiptPrintDocument(bulk, 'en', { layout, taxIdentity, reprint: false })
    ).toThrow(expect.objectContaining({ code: 'INVALID_PRINT_DOCUMENT' }));
  });

  it('leaves the Unicode browser fallback unchanged', () => {
    const sale = fixtureSale();
    const html = buildCounterBrowserReceipt(sale, 'ur', 'THERMAL', true);
    const preview = buildCounterReceiptPreview(sale, 'ur', 80, true);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(preview);
    expect(preview).toContain('دوبارہ پرنٹ — نئی فروخت نہیں');
    expect(preview).toContain('رسید 1042');
  });
});

describe('per-branch receipt format', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1' };

  function formatDb(branch: unknown, profile: unknown = null) {
    return {
      pharmacyBranch: {
        findFirst: vi.fn().mockResolvedValue(branch),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchRegulatoryProfile: { findFirst: vi.fn().mockResolvedValue(profile) },
    };
  }

  it('defaults an unconfigured branch to the shared layout, scoped to tenant and branch', async () => {
    const db = formatDb({ receiptLayout: null, receiptLayoutRevision: 0 });
    await expect(readPharmacyReceiptFormat(db as never, scope)).resolves.toEqual({
      layout: DEFAULT_RECEIPT_LAYOUT,
      revision: 0,
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1', active: true },
      select: { receiptLayout: true, receiptLayoutRevision: true },
    });
  });

  it('returns a saved 58 mm branch format and fails closed on corrupt settings', async () => {
    const saved = { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58, headerText: 'Open 24 hours' };
    await expect(
      readPharmacyReceiptFormat(
        formatDb({ receiptLayout: saved, receiptLayoutRevision: 3 }) as never,
        scope
      )
    ).resolves.toEqual({ layout: saved, revision: 3 });
    await expect(
      readPharmacyReceiptFormat(
        formatDb({ receiptLayout: { paperWidth: 72 }, receiptLayoutRevision: 1 }) as never,
        scope
      )
    ).rejects.toThrow();
  });

  it('reports a foreign or inactive branch as not found', async () => {
    await expect(readPharmacyReceiptFormat(formatDb(null) as never, scope)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('saves with an optimistic revision and refuses a stale write', async () => {
    const db = formatDb(null);
    const next = { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 as const };
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-1', {
        branchId: 'branch-1',
        revision: 2,
        layout: next,
      })
    ).resolves.toEqual({ layout: next, revision: 3 });
    expect(db.pharmacyBranch.updateMany).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1', active: true, receiptLayoutRevision: 2 },
      data: { receiptLayout: next, receiptLayoutRevision: { increment: 1 } },
    });

    db.pharmacyBranch.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-1', {
        branchId: 'branch-1',
        revision: 2,
        layout: next,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects printer commands and markup in saved text before writing', async () => {
    const db = formatDb(null);
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-1', {
        branchId: 'branch-1',
        revision: 0,
        layout: { ...DEFAULT_RECEIPT_LAYOUT, headerText: '\x1b@<b>' },
      })
    ).rejects.toThrow();
    expect(db.pharmacyBranch.updateMany).not.toHaveBeenCalled();
  });

  it('reads NTN/STRN from the profile in force when the sale completed', async () => {
    const at = new Date('2026-08-01T12:00:00Z');
    const db = formatDb(null, { ntn: ' 1234567-8 ', strn: '' });
    await expect(readPharmacyReceiptTaxIdentity(db as never, scope, at)).resolves.toEqual({
      ntn: '1234567-8',
      strn: null,
    });
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { ntn: true, strn: true },
    });
    await expect(
      readPharmacyReceiptTaxIdentity(formatDb(null, null) as never, scope, at)
    ).resolves.toEqual({ ntn: null, strn: null });
  });
});
