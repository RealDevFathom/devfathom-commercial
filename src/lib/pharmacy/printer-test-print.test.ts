import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPrinterTestPage,
  openPrinterTestPage,
  PRINTER_TEST_FORMATS,
  PRINTER_TEST_SAMPLES,
  PRINTER_TEST_STRINGS,
  PrinterTestPrintError,
} from './printer-test-print';

const printedAt = new Date('2026-11-04T09:30:00.000Z');
const page = (overrides: Partial<Parameters<typeof buildPrinterTestPage>[0]> = {}) =>
  buildPrinterTestPage({
    format: 'THERMAL',
    locale: 'en',
    branchName: 'Saddar branch',
    printedAt,
    timeZone: 'Asia/Karachi',
    ...overrides,
  });

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('buildPrinterTestPage', () => {
  it('says plainly it is not a receipt and carries no sale facts', () => {
    const html = page();
    const text = parse(html).body.textContent ?? '';
    expect(text).toContain('PRINTER TEST PAGE');
    expect(text).toContain('Not a receipt. No sale, no receipt number, no money.');
    expect(text).toContain('Saddar branch');
    expect(text).toContain('Thermal roll, 80 mm');
    // Nothing that could pass for an original or a reprint.
    for (const forbidden of ['Receipt 1', 'Invoice', 'PKR', 'Total', 'Reprint', 'CASH']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('escapes the branch name as inert text', () => {
    const doc = parse(page({ branchName: '<img src=x onerror=alert(1)>"&\'' }));
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>"&\'');
  });

  it.each([
    ['THERMAL', '80mm', 'auto', '0'],
    ['THERMAL_58', '58mm', 'auto', '0'],
    ['A4', '190mm', 'A4', '10mm'],
  ] as const)('sizes %s paper like the counter receipt', (format, width, size, margin) => {
    const html = page({ format });
    expect(html).toContain(`width: ${width};`);
    expect(html).toContain(`@page { size: ${size}; margin: ${margin}; }`);
  });

  it('prints English left-to-right with both language samples', () => {
    const doc = parse(page());
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.documentElement.dir).toBe('ltr');
    expect(doc.querySelector('bdi[lang="en"]')?.textContent).toBe(PRINTER_TEST_SAMPLES.en);
    expect(doc.querySelector('bdi[lang="ur"]')?.getAttribute('dir')).toBe('rtl');
    expect(doc.querySelector('bdi[lang="ur"]')?.textContent).toBe(PRINTER_TEST_SAMPLES.ur);
  });

  it('prints Urdu right-to-left with Urdu labels and the same font samples', () => {
    const doc = parse(page({ locale: 'ur', format: 'THERMAL_58' }));
    const text = doc.body.textContent ?? '';
    expect(doc.documentElement.lang).toBe('ur');
    expect(doc.documentElement.dir).toBe('rtl');
    expect(text).toContain(PRINTER_TEST_STRINGS.ur.title);
    expect(text).toContain(PRINTER_TEST_STRINGS.ur.notReceipt);
    expect(text).toContain(PRINTER_TEST_STRINGS.ur.paperName.THERMAL_58);
    expect(text).not.toContain(PRINTER_TEST_STRINGS.en.notReceipt);
    expect(doc.querySelector('bdi[lang="en"]')?.textContent).toBe(PRINTER_TEST_SAMPLES.en);
    // Edge arrows keep their physical left/right meaning in an RTL page.
    expect(doc.querySelector('.edges')).not.toBeNull();
    expect(page({ locale: 'ur' })).toContain('direction: ltr');
  });

  it('keeps both language tables complete', () => {
    const keys = (value: object) => Object.keys(value).sort();
    expect(keys(PRINTER_TEST_STRINGS.ur)).toEqual(keys(PRINTER_TEST_STRINGS.en));
    for (const format of PRINTER_TEST_FORMATS) {
      expect(PRINTER_TEST_STRINGS.ur.paperName[format]).toBeTruthy();
      expect(PRINTER_TEST_STRINGS.en.paperName[format]).toBeTruthy();
    }
  });

  it('prints the time in the workspace zone and survives an unknown zone', () => {
    expect(parse(page()).body.textContent).toMatch(/2:30/);
    expect(() => page({ timeZone: 'Not/AZone' })).not.toThrow();
  });

  it.each([
    { format: 'LABEL_50x30' as never },
    { locale: 'fr' as never },
    { printedAt: new Date('not a date') },
  ])('rejects unsupported input %j', (overrides) => {
    expect(() => page(overrides)).toThrow('Choose a supported paper size and language.');
  });
});

describe('openPrinterTestPage', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakePopup(print = vi.fn()) {
    return {
      opener: {} as unknown,
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      print,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    };
  }

  it('writes the page into an isolated window and asks for the print dialog', () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as never);
    openPrinterTestPage('<p>test</p>');
    expect(popup.opener).toBeNull();
    expect(popup.document.write).toHaveBeenCalledWith('<p>test</p>');
    expect(popup.print).toHaveBeenCalledOnce();
  });

  it('reports a blocked pop-up', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => openPrinterTestPage('<p>test</p>')).toThrow(
      expect.objectContaining({ code: 'POPUP_BLOCKED' })
    );
  });

  it('reports a pop-up that throws on open as blocked', () => {
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => openPrinterTestPage('<p>test</p>')).toThrow(PrinterTestPrintError);
  });

  it('closes the window and reports a dialog that fails to open', () => {
    const popup = fakePopup(
      vi.fn(() => {
        throw new Error('print blocked');
      })
    );
    vi.spyOn(window, 'open').mockReturnValue(popup as never);
    expect(() => openPrinterTestPage('<p>test</p>')).toThrow(
      expect.objectContaining({ code: 'DIALOG_FAILED' })
    );
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
