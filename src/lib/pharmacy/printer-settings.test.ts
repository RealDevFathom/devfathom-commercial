import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import {
  counterFormatForSettings,
  readPharmacyPrinterSettings,
  SavePharmacyReceiptFormatSchema,
  storedPharmacyPrinterSettings,
} from './printer-settings';
import { readPharmacyReceiptFormat, savePharmacyReceiptFormat } from './receipt-print';

const layout = { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58 as const, footerText: 'Get well soon.' };
const scope = { organizationId: 'org-a', branchId: 'branch-a' };

describe('readPharmacyPrinterSettings', () => {
  it('gives absent settings the shared default layout on a thermal roll', () => {
    expect(readPharmacyPrinterSettings(null)).toEqual({
      layout: DEFAULT_RECEIPT_LAYOUT,
      output: 'THERMAL',
    });
  });

  it('reads a layout saved before DEV-742 as thermal, keeping every shared field', () => {
    expect(readPharmacyPrinterSettings(layout)).toEqual({ layout, output: 'THERMAL' });
  });

  it('splits the pharmacy output from the strict shared layout', () => {
    const settings = readPharmacyPrinterSettings({ ...layout, output: 'A4' });
    expect(settings).toEqual({ layout, output: 'A4' });
    expect(settings.layout).not.toHaveProperty('output');
  });

  it.each([
    ['an unknown output', { ...layout, output: 'LABEL_50x30' }],
    ['a corrupt width', { ...layout, paperWidth: 72 }],
    ['an unknown layout key', { ...layout, kitchenRoute: 'grill' }],
    ['an array', [layout]],
    ['a string', 'A4'],
  ])('fails closed on %s', (_name, value) => {
    expect(() => readPharmacyPrinterSettings(value)).toThrow();
  });

  it('round-trips the stored JSON', () => {
    const stored = storedPharmacyPrinterSettings({ layout, output: 'A4' });
    expect(stored).toEqual({ ...layout, output: 'A4' });
    expect(readPharmacyPrinterSettings(stored)).toEqual({ layout, output: 'A4' });
  });
});

describe('counterFormatForSettings', () => {
  it.each([
    ['THERMAL', 80, 'THERMAL'],
    ['THERMAL', 58, 'THERMAL_58'],
    ['A4', 80, 'A4'],
    ['A4', 58, 'A4'],
  ] as const)('maps %s with a %i mm roll to %s', (output, paperWidth, expected) => {
    expect(counterFormatForSettings({ output, layout: { paperWidth } })).toBe(expected);
  });
});

describe('SavePharmacyReceiptFormatSchema', () => {
  const base = { branchId: 'branch-a', revision: 3, layout };
  it('accepts a save with or without the counter output', () => {
    expect(SavePharmacyReceiptFormatSchema.parse(base)).toEqual(base);
    expect(SavePharmacyReceiptFormatSchema.parse({ ...base, output: 'A4' }).output).toBe('A4');
  });
  it.each([
    { ...base, output: 'LABEL_50x30' },
    { ...base, organizationId: 'org-b' },
    { ...base, layout: { ...layout, output: 'A4' } },
    { ...base, layout: { ...layout, paperWidth: 110 } },
  ])('rejects %j', (input) => {
    expect(SavePharmacyReceiptFormatSchema.safeParse(input).success).toBe(false);
  });
});

function fakeDb(row: { receiptLayout: unknown; receiptLayoutRevision: number } | null) {
  return {
    pharmacyBranch: {
      findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: row ? 1 : 0 })),
    },
    branchRegulatoryProfile: { findFirst: vi.fn() },
  };
}

describe('readPharmacyReceiptFormat', () => {
  it('returns the shared layout, the counter output and the revision', async () => {
    const db = fakeDb({ receiptLayout: { ...layout, output: 'A4' }, receiptLayoutRevision: 4 });
    await expect(readPharmacyReceiptFormat(db as never, scope)).resolves.toEqual({
      layout,
      output: 'A4',
      revision: 4,
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch-a', organizationId: 'org-a', active: true },
      })
    );
  });

  it('is not found for an inactive or foreign branch', async () => {
    await expect(readPharmacyReceiptFormat(fakeDb(null) as never, scope)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('savePharmacyReceiptFormat', () => {
  it('writes the output beside the layout under the revision predicate', async () => {
    const db = fakeDb({ receiptLayout: null, receiptLayoutRevision: 2 });
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-a', {
        branchId: 'branch-a',
        revision: 2,
        layout,
        output: 'A4',
      })
    ).resolves.toEqual({ layout, output: 'A4', revision: 3 });
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.updateMany).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true, receiptLayoutRevision: 2 },
      data: { receiptLayout: { ...layout, output: 'A4' }, receiptLayoutRevision: { increment: 1 } },
    });
  });

  it('keeps the stored output when an older caller saves only the layout', async () => {
    const db = fakeDb({ receiptLayout: { ...layout, output: 'A4' }, receiptLayoutRevision: 5 });
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-a', { branchId: 'branch-a', revision: 5, layout })
    ).resolves.toMatchObject({ output: 'A4', revision: 6 });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true, receiptLayoutRevision: 5 },
      select: { receiptLayout: true },
    });
    expect(db.pharmacyBranch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ receiptLayout: { ...layout, output: 'A4' } }),
      })
    );
  });

  it('reports a stale revision as a conflict without writing', async () => {
    const db = fakeDb(null);
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-a', { branchId: 'branch-a', revision: 1, layout })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.pharmacyBranch.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost race on the write as a conflict', async () => {
    const db = fakeDb({ receiptLayout: null, receiptLayoutRevision: 1 });
    db.pharmacyBranch.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-a', {
        branchId: 'branch-a',
        revision: 1,
        layout,
        output: 'THERMAL',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects input outside the schema before touching the database', async () => {
    const db = fakeDb({ receiptLayout: null, receiptLayoutRevision: 0 });
    await expect(
      savePharmacyReceiptFormat(db as never, 'org-a', {
        branchId: 'branch-a',
        revision: 0,
        layout,
        output: 'KITCHEN',
      })
    ).rejects.toThrow();
    expect(db.pharmacyBranch.updateMany).not.toHaveBeenCalled();
  });
});
