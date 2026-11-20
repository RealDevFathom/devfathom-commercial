import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildDispensingLabels, type DispensingLabelSource } from './dispensing-label';
import { buildCounterBrowserReceipt, printCounterBrowserReceipt } from './counter-browser-print';
import type { CounterReceipt } from './counter-receipt';
import { installFakePrintWindows } from '@/lib/testing/print-window';

// Synthetic text only: these fixtures are not medical instructions or real licences.
export const source: DispensingLabelSource = {
  saleId: 'sale',
  saleLineId: 'line',
  rx: true,
  pharmacistRegistration: 'REG',
  licenceNumber: 'TEST-LICENCE',
  directionsEnglish: 'English directions fixture',
  directionsUrdu: 'اردو',
};
export const receipt: CounterReceipt = {
  saleId: 'sale',
  receiptNumber: 42,
  branchName: 'Test pharmacy',
  businessDate: '2026-09-29',
  completedAt: '2026-09-29T10:00:00Z',
  currency: 'PKR',
  lines: [
    {
      saleLineId: 'line',
      identityStatus: 'ISSUED',
      medicineName: 'Test medicine',
      strength: '500 mg',
      presentation: 'Tablet',
      batchNumber: 'STALE',
      expiresAt: '2099-01-01',
      saleUnit: 'UNIT',
      quantity: 2,
      canonicalUnits: 2,
      unitPriceMinor: 10,
      discountMinor: 0,
      lineTotalMinor: 20,
      allocations: [
        {
          allocationId: 'a',
          inventoryLotId: 'a',
          batchNumber: 'A',
          expiresAt: '2027-01-01',
          canonicalUnits: 1,
        },
        {
          allocationId: 'b',
          inventoryLotId: 'b',
          batchNumber: 'B',
          expiresAt: '2028-02-02',
          canonicalUnits: 1,
        },
      ],
    },
  ],
  tenders: [],
  totals: { grossMinor: 20, discountMinor: 0, netMinor: 20, tenderedMinor: 20, changeMinor: 0 },
};
afterEach(() => vi.restoreAllMocks());
describe('50 × 30 mm dispensing labels', () => {
  it('omits optional name and preserves registration; rejects non-Rx sources', () => {
    expect(buildDispensingLabels(receipt, [source])).toContain('Pharmacist: <bdi>REG</bdi>');
    expect(buildDispensingLabels(receipt, [{ ...source, pharmacistName: 'Actor' }])).toContain(
      'Pharmacist: Actor · <bdi>REG</bdi>'
    );
    expect(() =>
      buildDispensingLabels(receipt, [{ ...source, rx: false } as unknown as DispensingLabelSource])
    ).toThrow();
  });
  it('snapshots both issued batch labels with exact bilingual source text', () => {
    const before = JSON.stringify(receipt);
    const html = buildCounterBrowserReceipt(receipt, 'en', 'LABEL_50x30', false, [source]);
    expect(html).toMatchSnapshot();
    expect(html).not.toContain('STALE');
    expect(html).not.toContain('2099');
    expect(JSON.stringify(receipt)).toBe(before);
  });
  it('escapes supplied text and excludes unrelated patient/payment fields', () => {
    const html = buildDispensingLabels({ ...receipt, patientName: 'PRIVATE' } as CounterReceipt, [
      { ...source, directionsEnglish: '<script>alert(1)</script>' },
    ]);
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('script,img,iframe,link')).toBeNull();
    expect(document.body.textContent).toContain('<script>alert(1)</script>');
    expect(html).not.toContain('PRIVATE');
    expect(document.querySelector('[lang="ur"]')?.getAttribute('dir')).toBe('rtl');
  });
  it.each(['licenceNumber', 'directionsEnglish', 'directionsUrdu'] as const)(
    'rejects missing %s',
    (field) => {
      expect(() => buildDispensingLabels(receipt, [{ ...source, [field]: '' }])).toThrow();
    }
  );
  it('rejects missing sources, wrong sale/line, duplicates and unissued identity', () => {
    for (const sources of [
      [],
      [{ ...source, saleId: 'other' }],
      [{ ...source, saleLineId: 'other' }],
      [source, source],
    ]) {
      expect(() => buildDispensingLabels(receipt, sources)).toThrow();
    }
    for (const identityStatus of [undefined, 'UNAVAILABLE'] as const) {
      expect(() =>
        buildDispensingLabels({ ...receipt, lines: [{ ...receipt.lines[0]!, identityStatus }] }, [
          source,
        ])
      ).toThrow();
    }
    expect(() => buildDispensingLabels({ ...receipt, receiptNumber: null }, [source])).toThrow();
  });
  it.each([null, '', 'not-a-date', '2027-02-30'])(
    'rejects expiry %s without legacy fallback',
    (expiresAt) => {
      const line = receipt.lines[0]!;
      expect(() =>
        buildDispensingLabels(
          {
            ...receipt,
            lines: [{ ...line, allocations: [{ ...line.allocations![0]!, expiresAt }] }],
          },
          [source]
        )
      ).toThrow();
    }
  );
  it('rejects absent allocations, batch or control text', () => {
    const line = receipt.lines[0]!;
    expect(() =>
      buildDispensingLabels({ ...receipt, lines: [{ ...line, allocations: [] }] }, [source])
    ).toThrow();
    expect(() =>
      buildDispensingLabels(
        {
          ...receipt,
          lines: [{ ...line, allocations: [{ ...line.allocations![0]!, batchNumber: null }] }],
        },
        [source]
      )
    ).toThrow();
    expect(() =>
      buildDispensingLabels(receipt, [{ ...source, directionsUrdu: '\u202eBAD' }])
    ).toThrow();
  });
  it.each([false, true])(
    'prints only labels fitting physical paper; overflow=%s',
    async (overflow) => {
      // Labels are laid out (never printed) in this page before the print window gets them.
      const measured: string[] = [];
      const size = (label: number, fallback: number) =>
        function (this: Element) {
          if (!this.classList.contains('dispensing-label')) return fallback;
          measured.push(this.textContent ?? '');
          return label;
        };
      // The measuring frame has its own realm, so its layout is stubbed there.
      const frameDocument = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        'contentDocument'
      )!.get!;
      vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function (
        this: HTMLIFrameElement
      ) {
        const doc = frameDocument.call(this) as Document;
        const element = doc.defaultView!.Element.prototype;
        for (const [name, value] of [
          ['clientHeight', 113],
          ['scrollHeight', overflow ? 150 : 113],
          ['clientWidth', 189],
          ['scrollWidth', 189],
        ] as const)
          Object.defineProperty(element, name, { configurable: true, get: size(value, 0) });
        return doc;
      });
      const windows = installFakePrintWindows();
      const print = () =>
        printCounterBrowserReceipt(receipt, 'en', 'LABEL_50x30', false, undefined, [source]);
      if (overflow) {
        expect(print).toThrow('exceeds 50 × 30 mm');
        expect(windows.last().printRequests()).toBe(0);
        expect(windows.last().proxy.close).toHaveBeenCalledOnce();
      } else {
        await print();
        expect(windows.last().printRequests()).toBe(1);
        expect(windows.last().html()).toBe(
          buildCounterBrowserReceipt(receipt, 'en', 'LABEL_50x30', false, [source])
        );
        // noopener: the print window has no reference back to the counter.
        expect(windows.last().features).toMatch(/^noopener,/);
        expect(windows.last().proxy.print).not.toHaveBeenCalled();
        windows.closeAll();
      }
      expect(measured.length).toBeGreaterThan(0);
    }
  );
});
