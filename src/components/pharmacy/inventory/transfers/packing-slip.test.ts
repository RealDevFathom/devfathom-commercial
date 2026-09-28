import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPackingSlipHtml,
  buildPackingSlipText,
  printPackingSlip,
  type PackingSlip,
} from './packing-slip';

const slip: PackingSlip = {
  reference: 'TR-ABCD1234',
  status: 'APPROVED',
  fromBranch: 'Saddar branch · Karachi',
  toBranch: 'Clifton branch · Karachi',
  allocatedBy: 'Rabia Receiver',
  approvedBy: 'Adnan Approver',
  dispatchedBy: null,
  dispatchedAt: null,
  lines: [
    {
      medicineName: 'Amoxicillin 500mg <script>alert(1)</script>',
      batchNumber: 'B-7',
      expiresAt: '2027-03-01T00:00:00.000Z',
      sourceLocation: 'Front shelf',
      destinationLocation: 'Back store',
      quantityUnits: 30,
      sealedPacks: 3,
      looseUnits: 0,
      unitsPerPack: 10,
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('packing slip', () => {
  it('lists every physical fact the dispatcher and receiver sign against', () => {
    const text = buildPackingSlipText(slip, 72);
    expect(text).toContain('Transfer TR-ABCD1234');
    expect(text).toContain('From: Saddar branch · Karachi');
    expect(text).toContain('To:   Clifton branch · Karachi');
    expect(text).toContain('Batch B-7 · exp 2027-03-01');
    expect(text).toContain('30 units = 3 sealed × 10 + 0 loose');
    expect(text).toContain('Pick: Front shelf');
    expect(text).toContain('Put:  Back store');
    expect(text).toContain('Dispatched:   not yet');
    expect(text).toContain('1 line(s) · 30 units');
    expect(text).toContain('Witness to any shortfall');
  });

  it('carries no money: the slip travels with the goods', () => {
    expect(buildPackingSlipText(slip, 72)).not.toMatch(/PKR|cost|price|MRP/i);
  });

  it('renders untrusted names as inert escaped text', () => {
    const html = buildPackingSlipHtml(slip, 'A4');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it.each([
    ['A4', '190mm'],
    ['THERMAL', '80mm'],
    ['THERMAL_58', '58mm'],
  ] as const)('sizes %s paper to %s', (format, width) => {
    expect(buildPackingSlipHtml(slip, format)).toContain(`width: ${width}`);
  });

  it('refuses an unsupported paper size or an empty transfer', () => {
    expect(() => buildPackingSlipHtml(slip, 'LETTER' as never)).toThrow(/paper size/);
    expect(() => buildPackingSlipHtml({ ...slip, lines: [] }, 'A4')).toThrow(/no lines/);
  });

  it('prints from an isolated pop-up with no opener', () => {
    const popup = {
      opener: {} as unknown,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    printPackingSlip(slip, 'THERMAL');

    expect(popup.opener).toBeNull();
    expect(popup.document.write).toHaveBeenCalledWith(expect.stringContaining('TR-ABCD1234'));
    expect(popup.print).toHaveBeenCalledOnce();
  });

  it('explains a blocked pop-up instead of failing silently', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => printPackingSlip(slip, 'A4')).toThrow(/Allow pop-ups/);
  });

  it('closes the pop-up and reports when the print dialog cannot open', () => {
    const popup = {
      opener: null,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(() => {
        throw new Error('blocked');
      }),
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    expect(() => printPackingSlip(slip, 'A4')).toThrow(/print dialog could not open/);
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
