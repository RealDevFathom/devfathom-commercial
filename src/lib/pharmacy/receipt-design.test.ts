import { expect, it } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { buildCounterBrowserReceipt } from './counter-browser-print';
import { receiptDesignSample } from './receipt-design-sample';

it('prints the branch’s saved v1 business, header and footer on the browser receipt', () => {
  const sale = {
    ...receiptDesignSample,
    receiptLayout: {
      ...DEFAULT_RECEIPT_LAYOUT,
      businessText: 'Station Pharmacy',
      headerText: 'Open every day',
      footerText: 'Visit again',
    },
  };
  const html = buildCounterBrowserReceipt(sale, 'en', 'THERMAL_58', true);
  for (const text of ['Station Pharmacy', 'Open every day', 'Visit again', 'Reprint'])
    expect(html).toContain(text);
});

import {
  receiptDesign,
  SavePharmacyReceiptLayoutSchema,
  safePharmacyLayout,
  brandingCaption,
} from './receipt-layout';
import { buildPharmacyReceiptEscPosJob } from './receipt-print';
import { renderPharmacyThermal } from './receipt-thermal-design';
import { counterReceiptFacts } from './counter-receipt-presentation';
import { receiptBlocks } from './receipt-blocks';
const layout = receiptDesign({
  ...DEFAULT_RECEIPT_LAYOUT,
  businessText: 'Example brand',
  headerText: 'Welcome',
  footerText: 'See you soon',
});
const styled = {
  ...layout,
  alignment: { ...layout.alignment, headerText: 'end' as const },
  emphasis: { ...layout.emphasis, headerText: 'bold' as const },
  brandingQr: { url: 'https://example.test/shop' },
};
const taxIdentity = receiptDesignSample.taxIdentity!;
const facts = counterReceiptFacts(receiptDesignSample, 'en');
it.each([
  ['hidden protected facts', { sections: ['totals'] }],
  ['substituted money', { totals: ['0'] }],
  ['unknown style', { emphasis: { ...layout.emphasis, footerText: 'invisible' } }],
  ['markup', { headerText: '<sample>' }],
  ['control character', { businessText: 'test\x1b' }],
  ['non-HTTPS website', { brandingQr: { url: 'http://example.test' } }],
  ['website controls', { brandingQr: { url: 'https://example.test/\x1b' } }],
  ['raw logo reference', { logo: { assetId: 'sample.svg', maxWidthMm: 10 } }],
  ['repeated sections', { sections: ['logo', 'logo'] }],
])(
  'rejects %s at the server save boundary, and renders safe defaults for corrupt stored JSON',
  (_, extra) => {
    const corrupt = { ...styled, ...extra };
    expect(
      SavePharmacyReceiptLayoutSchema.safeParse({ branchId: 'b', revision: 3, layout: corrupt })
        .success
    ).toBe(false);
    expect(safePharmacyLayout(corrupt)).toEqual(DEFAULT_RECEIPT_LAYOUT);
    const job = buildPharmacyReceiptEscPosJob(receiptDesignSample, 'en', {
      taxIdentity,
      layout: corrupt as typeof layout,
      reprint: true,
    });
    const wire = Buffer.from(job.escPos.data, 'base64').toString('ascii');
    expect(wire).toContain('REPRINT - not a new sale');
    expect(wire).toContain('Total: 29.00');
  }
);
it('keeps every protected block identical across empty and reordered optional sections', () => {
  const protectedOnly = (value: unknown) =>
    receiptBlocks(value, facts, 'Original', 58)
      .filter((block) => block.kind === 'facts')
      .map((x) => x.text)
      .join('\n');
  for (const design of [
    { ...styled, sections: [] },
    { ...styled, sections: [...styled.sections].reverse() },
    { ...styled, showOrderNumber: false, showChannel: false },
  ]) {
    expect(protectedOnly(design)).toBe(protectedOnly(layout));
  }
  const protectedText = protectedOnly(layout).replace(/\s+/g, ' ');
  for (const fact of [
    'Example Registered Pharmacy',
    '12 Sample Road',
    'Drug-sale licence: SAMPLE-LIC',
    'NTN: SAMPLE-NTN',
    'STRN: SAMPLE-STRN',
    receiptDesignSample.branchName,
    'Receipt: 101',
    'Counter 2',
    '2026-10-01 11:15 PKT',
    'Sample extended release medicine with a long printed name',
    'Amount: 29.00',
    'Discount: 1.00',
    'Total: 29.00',
    'Cash: 29.00',
    'Change: 1.00',
    'Original',
  ])
    expect(protectedText).toContain(fact);
});
it.each(['THERMAL_58', 'THERMAL', 'A4'] as const)(
  'renders the sample and recorded long names identically on %s in English and Urdu',
  (paper) => {
    for (const locale of ['en', 'ur'] as const) {
      const receipt = {
        ...receiptDesignSample,
        receiptLayout: { ...styled, brandingQr: undefined, locale },
        branchName:
          locale === 'ur'
            ? 'نمونہ کمیونٹی فارمیسی پرانے ریلوے اسٹیشن کی مرکزی برانچ'
            : receiptDesignSample.branchName,
      };
      const preview = buildCounterBrowserReceipt(receipt, locale, paper, true);
      const serverFacts = {
        en: counterReceiptFacts(receipt, 'en'),
        ur: counterReceiptFacts(receipt, 'ur'),
      };
      expect(
        buildCounterBrowserReceipt({ ...receipt, printFacts: serverFacts }, locale, paper, true)
      ).toBe(preview);
      expect(preview).toMatchSnapshot(locale);
    }
  }
);
it('applies bounded commands and branding QR in optional order on download and queue replay', () => {
  const job = buildPharmacyReceiptEscPosJob(receiptDesignSample, 'en', {
    layout: styled,
    taxIdentity,
    reprint: true,
  });
  const bytes = Buffer.from(job.escPos.data, 'base64');
  expect(Buffer.from(renderPharmacyThermal(job.document))).toEqual(bytes);
  expect(bytes.indexOf(Buffer.from([27, 97, 2, 27, 69, 1, 29, 33, 0]))).toBeGreaterThan(-1);
  const text = bytes.toString('latin1');
  expect(text).toContain('REPRINT - not a new sale');
  for (const name of ['Example brand', 'Welcome', 'See you soon']) expect(text).toContain(name);
  expect(bytes.indexOf(Buffer.from([29, 118, 48, 0]))).toBeGreaterThan(
    text.indexOf('See you soon')
  );
  expect(text.replace(/\s+/g, ' ')).toContain(brandingCaption);
  const html = buildCounterBrowserReceipt(
    { ...receiptDesignSample, receiptLayout: styled },
    'en',
    'A4',
    true
  );
  expect(html).toContain('<svg');
  expect(html).toContain(brandingCaption);
  expect(html).toContain('class="end bold"');
});
it.each(['both', 'ur'] as const)(
  'uses browser output for saved %s designs and refuses raw before allocation',
  (locale) => {
    const receiptLayout = { ...styled, locale };
    expect(() =>
      buildPharmacyReceiptEscPosJob(receiptDesignSample, 'en', {
        layout: receiptLayout,
        taxIdentity,
        reprint: false,
      })
    ).toThrow('browser/OS');
    const html = buildCounterBrowserReceipt({ ...receiptDesignSample, receiptLayout }, 'en', 'A4');
    expect(html).toContain('lang="ur" dir="rtl"');
    if (locale === 'both') expect(html).toContain('<section lang="en"');
  }
);
it('moves a tall branding block below the complete marked sale', () => {
  const blocks = receiptBlocks(
    { ...layout, headerText: '\n'.repeat(200) + 'Header end' },
    facts,
    'Original',
    58
  );
  expect(blocks.findIndex((b) => b.kind === 'facts' && b.text.includes('Original'))).toBeLessThan(
    blocks.findIndex((b) => b.kind === 'text' && b.text.includes('Header end'))
  );
});

it('marks new thermal originals from legacy or absent settings', () => {
  const job = buildPharmacyReceiptEscPosJob(receiptDesignSample, 'en', {
    layout: DEFAULT_RECEIPT_LAYOUT,
    taxIdentity,
    reprint: false,
  });
  expect(Buffer.from(job.escPos.data, 'base64').toString('ascii')).toContain('\nOriginal\n');
});
it('prints the recorded facts ahead of oversized legacy branding', () => {
  const job = buildPharmacyReceiptEscPosJob(receiptDesignSample, 'en', {
    layout: { ...DEFAULT_RECEIPT_LAYOUT, headerText: '\n'.repeat(20) + 'Legacy branding' },
    taxIdentity,
    reprint: false,
  });
  const text = Buffer.from(job.escPos.data, 'base64').toString('ascii');
  expect(text.indexOf('Receipt: 101')).toBeGreaterThan(-1);
  expect(text.indexOf('Legacy branding')).toBeGreaterThan(text.indexOf('Receipt: 101'));
});

it.each(['THERMAL_58', 'THERMAL', 'A4'] as const)(
  'prints the saved logo only on A4 when rendering %s',
  (format) => {
    const sale = {
      ...receiptDesignSample,
      receiptLayout: {
        ...styled,
        logo: { assetId: '11111111-1111-4111-8111-111111111111', maxWidthMm: 32 },
      },
      receiptLogoPng: 'cG5n',
    };
    const html = buildCounterBrowserReceipt(sale, 'en', format);
    if (format === 'A4') expect(html).toContain('src="data:image/png;base64,cG5n"');
    else expect(html).not.toContain('<img');
    expect(html).toContain('Sample Community Pharmacy');
  }
);

it.each([DEFAULT_RECEIPT_LAYOUT, layout])(
  'keeps the original marking and recorded tier discount on thermal layout v$version',
  (design) => {
    const sale = {
      ...receiptDesignSample,
      lines: receiptDesignSample.lines.map((line) => ({
        ...line,
        tierDiscountMinor: 100,
        tierName: 'Member',
      })),
    };
    const job = buildPharmacyReceiptEscPosJob(sale, 'en', {
      layout: design,
      taxIdentity,
      reprint: false,
    });
    const text = Buffer.from(job.escPos.data, 'base64').toString('ascii');
    expect(text).toContain('\nOriginal\n');
    expect(text.replace(/\s+/g, ' ')).toContain('Prepaid tier discount - Member: -1.00');
  }
);
