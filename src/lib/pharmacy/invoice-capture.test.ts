import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  createAIModel: vi.fn(() => {
    throw new Error('no provider configured');
  }),
}));
vi.mock('@/lib/ai/provider', () => ({ createAIModel: mocks.createAIModel }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: mocks.generateObject,
}));

import { NoObjectGeneratedError } from 'ai';

import {
  FIXTURE_INVOICE_CAPTURE_VERSION,
  MAX_INVOICE_LINES,
  choosePrintedPack,
  configuredInvoiceCaptureAdapterName,
  createFixtureInvoiceCaptureAdapter,
  createVisionInvoiceCaptureAdapter,
  normalizeInvoiceExtraction,
  parseInvoiceAmountMinor,
  parseInvoiceBonus,
  parseInvoiceCount,
  parseInvoiceDate,
  parseInvoicePercentBps,
  proposeInvoiceCapture,
  type InvoiceExtraction,
  type InvoiceLineContext,
  type InvoiceProposalContext,
} from './invoice-capture';

afterEach(() => vi.clearAllMocks());

const read = (value: string | null, confidence = 0.95) => ({
  value,
  confidence: value === null ? 0 : confidence,
});

function extraction(lineOverrides: Record<string, unknown> = {}): InvoiceExtraction {
  return normalizeInvoiceExtraction('FIXTURE', 'test-1', {
    supplier: read('Synthetic Medical Distributors'),
    invoiceNumber: read('SYN-INV-1001'),
    invoiceDate: read('2026-11-14'),
    lines: [
      {
        product: read('Synthetic Paracetamol 500mg'),
        pack: read('Box'),
        quantity: read('20'),
        bonus: read('10+1'),
        batch: read('B.No. SYN-B2741'),
        expiry: read('06/2028'),
        mrp: read('450.00'),
        tradePrice: read('382.50'),
        discount: read('2%'),
        tax: read('0'),
        ...lineOverrides,
      },
    ],
  });
}

const matched: InvoiceLineContext = {
  medicine: { medicineId: 'med-1', productName: 'Synthetic Paracetamol 500mg' },
  pack: { packLevelId: 'pack-box', level: 'BOX', canonicalUnitsPerPack: 100 },
  candidates: [],
  lastPurchase: {
    reference: 'GRN-9',
    receivedAt: '2026-10-01T00:00:00.000Z',
    supplierName: 'Synthetic Medical Distributors',
    printedMrpMinor: 40_000,
    tradePriceMinor: 34_000,
  },
};

function context(overrides: Partial<InvoiceProposalContext> = {}): InvoiceProposalContext {
  return {
    supplier: { supplierId: 'sup-1', name: 'Synthetic Medical Distributors' },
    duplicate: null,
    lines: [matched],
    ...overrides,
  };
}

describe('printed column parsing', () => {
  it.each([
    ['450', 45_000],
    ['450.5', 45_050],
    ['1,250.00', 125_000],
    ['1,25,000', 12_500_000],
    ['Rs. 382.50', 38_250],
    ['382.50/-', 38_250],
    ['PKR 10', 1_000],
  ])('reads %s as %d paisa', (printed, minor) => {
    expect(parseInvoiceAmountMinor(printed)).toBe(minor);
  });

  it.each([null, '', '0', '-450', '450.555', '4.50.00', '$450', '450 TP', '12,34', '9999999.99'])(
    'never guesses an amount from %s',
    (printed) => {
      expect(parseInvoiceAmountMinor(printed)).toBeNull();
    }
  );

  it('reads whole counts only', () => {
    expect(parseInvoiceCount('20')).toBe(20);
    expect(parseInvoiceCount('1,200')).toBe(1_200);
    expect(parseInvoiceCount('2.5')).toBeNull();
    expect(parseInvoiceCount('-2')).toBeNull();
    expect(parseInvoiceCount('ten')).toBeNull();
  });

  it('reads percentages into basis points and refuses more than 100%', () => {
    expect(parseInvoicePercentBps('17%')).toBe(1_700);
    expect(parseInvoicePercentBps('2.5')).toBe(250);
    expect(parseInvoicePercentBps('0')).toBe(0);
    expect(parseInvoicePercentBps('101%')).toBeNull();
    expect(parseInvoicePercentBps('-2%')).toBeNull();
  });

  it('computes a bonus scheme from the billed packs, whole multiples only', () => {
    expect(parseInvoiceBonus('10+1', 25)).toEqual({ kind: 'scheme', buy: 10, free: 1, packs: 2 });
    expect(parseInvoiceBonus('10 + 2', 9)).toEqual({ kind: 'scheme', buy: 10, free: 2, packs: 0 });
    expect(parseInvoiceBonus('10+1', null)).toMatchObject({ kind: 'scheme', packs: null });
    expect(parseInvoiceBonus('3', 25)).toEqual({ kind: 'packs', packs: 3 });
    expect(parseInvoiceBonus('0', 25)).toEqual({ kind: 'none' });
    expect(parseInvoiceBonus(null, 25)).toEqual({ kind: 'none' });
    expect(parseInvoiceBonus('free', 25)).toEqual({ kind: 'unreadable', printed: 'free' });
  });

  it('accepts only a day-precise, unambiguous invoice date', () => {
    expect(parseInvoiceDate('2026-11-14')).toBe('2026-11-14');
    expect(parseInvoiceDate('14/11/2026')).toBe('2026-11-14');
    expect(parseInvoiceDate('03/04/2026')).toBeNull();
    expect(parseInvoiceDate('11/2026')).toBeNull();
    expect(parseInvoiceDate(null)).toBeNull();
  });
});

describe('normalizeInvoiceExtraction', () => {
  it('sanitizes values, drops rows with no product and refuses an oversized read', () => {
    const normalized = normalizeInvoiceExtraction('FIXTURE', 'v1', {
      supplier: { value: 'Synthetic\u0000 Distributors', confidence: 7 },
      invoiceNumber: { value: 'x'.repeat(61), confidence: 0.9 },
      invoiceDate: null,
      lines: [{ product: read('Total') }, { product: read(null), quantity: read('5') }],
    });
    expect(normalized.supplier).toEqual({ value: 'Synthetic Distributors', confidence: 1 });
    expect(normalized.invoiceNumber).toEqual({ value: null, confidence: 0 });
    expect(normalized.invoiceDate).toEqual({ value: null, confidence: 0 });
    expect(normalized.lines).toHaveLength(1);
    expect(() =>
      normalizeInvoiceExtraction('FIXTURE', 'v1', {
        lines: Array.from({ length: MAX_INVOICE_LINES + 1 }, () => ({ product: read('x') })),
      })
    ).toThrow(expect.objectContaining({ reason: 'MALFORMED_OUTPUT' }));
    expect(() => normalizeInvoiceExtraction('FIXTURE', 'v1', [])).toThrow(
      expect.objectContaining({ reason: 'MALFORMED_OUTPUT' })
    );
  });
});

describe('proposeInvoiceCapture', () => {
  it('builds a reviewable draft whose every number is computed, not read', () => {
    const proposal = proposeInvoiceCapture(extraction(), context());
    expect(proposal).toMatchObject({
      status: 'PROPOSED',
      requiresReviewerConfirmation: true,
      supplier: { match: { supplierId: 'sup-1' } },
      invoiceNumber: { value: 'SYN-INV-1001' },
      invoiceDate: { date: '2026-11-14' },
      duplicate: null,
      warnings: [],
    });
    expect(proposal.lines[0]).toMatchObject({
      batch: { value: 'SYN-B2741' },
      expiry: { kind: 'read', candidate: { date: '2028-06-30', precision: 'MONTH' } },
      receivedPacks: 20,
      bonusPacks: 2,
      printedMrpMinor: 45_000,
      tradePriceMinor: 38_250,
      discountBps: 200,
      taxBps: 0,
      // 45000 - 40000 = +5000 paisa, +12.5% of the last MRP.
      mrpCheck: { lastMinor: 40_000, differenceMinor: 5_000, differenceBps: 1_250 },
      // 38250 - 34000 = +4250 paisa, +12.5% of the last trade price.
      tradePriceCheck: { lastMinor: 34_000, differenceMinor: 4_250, differenceBps: 1_250 },
      warnings: ['MRP_DIFFERS_FROM_LAST_PURCHASE', 'TRADE_PRICE_DIFFERS_FROM_LAST_PURCHASE'],
    });
  });

  it('reports no difference when the invoice matches the last purchase', () => {
    const proposal = proposeInvoiceCapture(
      extraction({ mrp: read('400'), tradePrice: read('340.00') }),
      context()
    );
    expect(proposal.lines[0]!.mrpCheck).toMatchObject({ differenceMinor: 0, differenceBps: 0 });
    expect(proposal.lines[0]!.warnings).toEqual([]);
  });

  it('flags a price drop, a trade price above MRP and a pack never bought before', () => {
    const drop = proposeInvoiceCapture(extraction({ mrp: read('300') }), context());
    expect(drop.lines[0]!.mrpCheck).toMatchObject({
      differenceMinor: -10_000,
      differenceBps: -2_500,
    });
    expect(drop.lines[0]!.warnings).toContain('TRADE_PRICE_ABOVE_MRP');

    const fresh = proposeInvoiceCapture(
      extraction(),
      context({ lines: [{ ...matched, lastPurchase: null }] })
    );
    expect(fresh.lines[0]).toMatchObject({ mrpCheck: null, tradePriceCheck: null });
    expect(fresh.lines[0]!.warnings).toEqual(['NO_EARLIER_PURCHASE']);
  });

  it('flags a supplier bill that is already filed', () => {
    const proposal = proposeInvoiceCapture(
      extraction(),
      context({ duplicate: { goodsReceiptId: 'gr-1', reference: 'GRN-7', status: 'POSTED' } })
    );
    expect(proposal.duplicate).toEqual({
      goodsReceiptId: 'gr-1',
      reference: 'GRN-7',
      status: 'POSTED',
    });
    expect(proposal.warnings).toContain('DUPLICATE_SUPPLIER_INVOICE');
  });

  it('never chooses a medicine, pack or value it could not read', () => {
    const proposal = proposeInvoiceCapture(
      extraction({
        batch: read(null),
        expiry: read('03/04/2028'),
        quantity: read('two'),
        bonus: read('free'),
        mrp: read('MRP 450 / TP 380'),
        tradePrice: read(null),
        discount: read('a lot'),
        tax: read('17%', 0.4),
      }),
      context({
        supplier: null,
        lines: [
          {
            medicine: null,
            pack: { packLevelId: 'ignored', level: 'BOX', canonicalUnitsPerPack: 1 },
            candidates: [{ medicineId: 'med-2', productName: 'Synthetic Paracetamol' }],
            lastPurchase: null,
          },
        ],
      })
    );
    const line = proposal.lines[0]!;
    expect(line).toMatchObject({
      medicine: null,
      pack: null,
      batch: { value: null },
      expiry: { kind: 'ambiguous' },
      receivedPacks: null,
      bonusPacks: null,
      printedMrpMinor: null,
      tradePriceMinor: null,
      discountBps: null,
      taxBps: 1_700,
    });
    expect(line.warnings).toEqual([
      'MEDICINE_NOT_MATCHED',
      'BATCH_UNREADABLE',
      'EXPIRY_AMBIGUOUS',
      'QUANTITY_UNREADABLE',
      'BONUS_UNREADABLE',
      'MRP_UNREADABLE',
      'TRADE_PRICE_UNREADABLE',
      'LOW_CONFIDENCE',
    ]);
    expect(proposal.warnings).toEqual(['SUPPLIER_NOT_MATCHED']);
  });

  it('reports an invoice it could not read at all', () => {
    const proposal = proposeInvoiceCapture(
      normalizeInvoiceExtraction('FIXTURE', 'v1', { lines: [] }),
      context({ supplier: null, lines: [] })
    );
    expect(proposal.warnings).toEqual([
      'SUPPLIER_NOT_MATCHED',
      'INVOICE_NUMBER_UNREADABLE',
      'INVOICE_DATE_UNREADABLE',
      'NO_LINES',
    ]);
  });
});

describe('choosePrintedPack', () => {
  const box = { level: 'BOX', id: 'box' };
  const strip = { level: 'STRIP', id: 'strip' };
  it('takes the only pack, or the one level the printed text names', () => {
    expect(choosePrintedPack([box], null)).toBe(box);
    expect(choosePrintedPack([box, strip], 'Strips 10x10')).toBe(strip);
    expect(choosePrintedPack([box, strip], 'BOX')).toBe(box);
  });
  it('leaves a two-way or unnamed pack for the receiver', () => {
    expect(choosePrintedPack([box, strip], 'box of 10 strips')).toBeNull();
    expect(choosePrintedPack([box, strip], '10x10')).toBeNull();
    expect(choosePrintedPack([box, strip], null)).toBeNull();
    expect(choosePrintedPack([], 'box')).toBeNull();
  });
});

describe('adapters', () => {
  it('is off unless an adapter is named explicitly', () => {
    expect(configuredInvoiceCaptureAdapterName({})).toBeNull();
    expect(
      configuredInvoiceCaptureAdapterName({ PHARMACY_INVOICE_OCR_ADAPTER: 'true' })
    ).toBeNull();
    expect(configuredInvoiceCaptureAdapterName({ PHARMACY_INVOICE_OCR_ADAPTER: ' vision ' })).toBe(
      'VISION'
    );
    expect(configuredInvoiceCaptureAdapterName({ PHARMACY_INVOICE_OCR_ADAPTER: 'fixture' })).toBe(
      'FIXTURE'
    );
  });

  it('fixture adapter returns synthetic values and refuses an empty file', async () => {
    const adapter = createFixtureInvoiceCaptureAdapter();
    const result = await adapter.extract({ content: Buffer.from('x'), mimeType: 'image/jpeg' });
    expect(result.adapterVersion).toBe(FIXTURE_INVOICE_CAPTURE_VERSION);
    expect(result.lines).toHaveLength(1);
    await expect(
      adapter.extract({ content: Buffer.alloc(0), mimeType: 'image/jpeg' })
    ).rejects.toMatchObject({ reason: 'MALFORMED_OUTPUT' });
  });

  it('vision adapter selects its own feature and reports a missing model as unavailable', async () => {
    await expect(
      createVisionInvoiceCaptureAdapter().extract({
        content: Buffer.from('%PDF-1.4'),
        mimeType: 'application/pdf',
        organizationId: 'org-synthetic',
      })
    ).rejects.toMatchObject({ reason: 'ADAPTER_UNAVAILABLE' });
    expect(mocks.createAIModel).toHaveBeenCalledWith(process.env, {
      feature: 'pharmacy-invoice-ocr',
      organizationId: 'org-synthetic',
    });
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it('vision adapter sends a PDF as a file part and normalizes what comes back', async () => {
    mocks.generateObject.mockResolvedValue({
      object: {
        supplier: read('Synthetic Distributors'),
        invoiceNumber: read('INV-1'),
        invoiceDate: read('2026-11-14'),
        lines: [],
      },
    });
    const selectModel = vi.fn(() => ({
      model: 'fake-model' as never,
      provider: 'google' as const,
      modelId: 'fake-model',
    }));
    const result = await createVisionInvoiceCaptureAdapter({ selectModel }).extract({
      content: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });
    expect(result).toMatchObject({ adapter: 'VISION', invoiceNumber: { value: 'INV-1' } });
    const call = mocks.generateObject.mock.calls[0]![0] as {
      temperature: number;
      messages: { content: { type: string; mediaType?: string }[] }[];
    };
    expect(call.temperature).toBe(0);
    expect(call.messages[0]!.content[1]).toMatchObject({
      type: 'file',
      mediaType: 'application/pdf',
    });
  });

  it('vision adapter maps an unusable structure to MALFORMED_OUTPUT', async () => {
    mocks.generateObject.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'no object',
        text: '',
        response: { id: 'r', timestamp: new Date(), modelId: 'm' },
        usage: {} as never,
        finishReason: 'stop',
      })
    );
    const selectModel = () => ({
      model: 'fake-model' as never,
      provider: 'google' as const,
      modelId: 'fake-model',
    });
    await expect(
      createVisionInvoiceCaptureAdapter({ selectModel }).extract({
        content: Buffer.from('x'),
        mimeType: 'image/jpeg',
      })
    ).rejects.toMatchObject({ reason: 'MALFORMED_OUTPUT' });
  });
});
