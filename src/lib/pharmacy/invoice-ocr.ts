/**
 * AI-03 invoice OCR. This is a proposal mapper, never an inventory writer.
 * It reuses the menu pipeline's neutral extraction adapter contract while
 * keeping pharmacy field rules in the pharmacy domain.
 */
import {
  clampConfidence,
  sanitizeExtractedText,
  type DocumentExtractionAdapter,
} from '@/lib/restaurant/menu-extraction';

export type SourceBox = Readonly<{
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type OcrField<T> = Readonly<{
  value: T | null;
  confidence: number;
  sourceBox: SourceBox | null;
}>;

export type InvoiceOcrRequest = Readonly<{
  content: Buffer;
  mimeType: string;
  pageCount: number;
  importId: string;
}>;

export type InvoiceOcrLine = Readonly<{
  productName: OcrField<string>;
  productMatchCandidates: readonly Readonly<{ medicineId: string; label: string }>[];
  packLevel: OcrField<string>;
  quantity: OcrField<number>;
  bonusUnits: OcrField<number>;
  batch: OcrField<string>;
  expiry: OcrField<string>;
  printedMrpMinor: OcrField<number>;
  unitCostMinor: OcrField<number>;
  taxBps: OcrField<number>;
}>;

export type InvoiceOcrExtraction = Readonly<{
  adapterVersion: string;
  supplier: OcrField<string>;
  supplierMatchCandidates: readonly Readonly<{ supplierId: string; label: string }>[];
  invoiceNumber: OcrField<string>;
  invoiceDate: OcrField<string>;
  lines: readonly InvoiceOcrLine[];
}>;

export type InvoiceOcrAdapter = DocumentExtractionAdapter<InvoiceOcrRequest, InvoiceOcrExtraction>;

export const REGULATED_INVOICE_FIELDS = [
  'packLevel',
  'quantity',
  'batch',
  'expiry',
  'printedMrpMinor',
] as const;
export type RegulatedInvoiceField = (typeof REGULATED_INVOICE_FIELDS)[number];

export type InvoiceGoodsReceiptDraft = InvoiceOcrExtraction &
  Readonly<{
    status: 'DRAFT';
    source: 'OCR';
    confirmations: readonly Readonly<{
      lineIndex: number;
      field: RegulatedInvoiceField;
      confirmedById: string;
      confirmedAt: string;
    }>[];
  }>;

export class InvoiceOcrError extends Error {
  constructor(readonly reason: 'MALFORMED_EXTRACTION' | 'OCR_CONFIRMATION_REQUIRED') {
    super(reason);
  }
}

function validBox(box: SourceBox | null): boolean {
  return Boolean(
    box &&
    Number.isInteger(box.page) &&
    box.page > 0 &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0
  );
}

function normalized<T>(field: OcrField<T>): OcrField<T> {
  if (field.value !== null && !validBox(field.sourceBox)) {
    throw new InvoiceOcrError('MALFORMED_EXTRACTION');
  }
  return { ...field, confidence: clampConfidence(field.confidence) };
}

/** Normalize all provider output before it becomes a reviewable draft. */
export function createInvoiceGoodsReceiptDraft(
  extraction: InvoiceOcrExtraction
): InvoiceGoodsReceiptDraft {
  if (!extraction.lines.length) throw new InvoiceOcrError('MALFORMED_EXTRACTION');
  const cleanText = (field: OcrField<string>): OcrField<string> => ({
    ...normalized(field),
    value: sanitizeExtractedText(field.value, 300),
  });
  return {
    ...extraction,
    supplier: cleanText(extraction.supplier),
    invoiceNumber: cleanText(extraction.invoiceNumber),
    invoiceDate: cleanText(extraction.invoiceDate),
    lines: extraction.lines.map((line) => ({
      ...line,
      productName: cleanText(line.productName),
      packLevel: cleanText(line.packLevel),
      quantity: normalized(line.quantity),
      bonusUnits: normalized(line.bonusUnits),
      batch: cleanText(line.batch),
      expiry: cleanText(line.expiry),
      printedMrpMinor: normalized(line.printedMrpMinor),
      unitCostMinor: normalized(line.unitCostMinor),
      taxBps: normalized(line.taxBps),
    })),
    status: 'DRAFT',
    source: 'OCR',
    confirmations: [],
  };
}

export function confirmInvoiceField(
  draft: InvoiceGoodsReceiptDraft,
  input: { lineIndex: number; field: RegulatedInvoiceField; confirmedById: string; at: Date }
): InvoiceGoodsReceiptDraft {
  if (!draft.lines[input.lineIndex] || !input.confirmedById.trim()) {
    throw new InvoiceOcrError('OCR_CONFIRMATION_REQUIRED');
  }
  const confirmations = draft.confirmations.filter(
    (item) => item.lineIndex !== input.lineIndex || item.field !== input.field
  );
  return {
    ...draft,
    confirmations: [
      ...confirmations,
      { ...input, confirmedById: input.confirmedById.trim(), confirmedAt: input.at.toISOString() },
    ],
  };
}

/** Fail closed before an OCR draft can be handed to the goods-receipt writer. */
export function assertInvoiceDraftConfirmed(draft: InvoiceGoodsReceiptDraft): void {
  for (const lineIndex of draft.lines.keys()) {
    for (const field of REGULATED_INVOICE_FIELDS) {
      const confirmed = draft.confirmations.some(
        (item) => item.lineIndex === lineIndex && item.field === field
      );
      // Confidence only changes review urgency. It can never replace confirmation.
      if (!confirmed) {
        throw new InvoiceOcrError('OCR_CONFIRMATION_REQUIRED');
      }
    }
  }
}

const box = (page: number, x: number, y: number, width: number, height: number): SourceBox => ({
  page,
  x,
  y,
  width,
  height,
});
const field = <T>(value: T, confidence: number, sourceBox: SourceBox): OcrField<T> => ({
  value,
  confidence,
  sourceBox,
});

/** Deterministic capture-mode adapter; no external credentials or network. */
export function createFixtureInvoiceOcrAdapter(): InvoiceOcrAdapter {
  return {
    async extract(request) {
      if (!request.content.length || request.pageCount < 1) {
        throw new InvoiceOcrError('MALFORMED_EXTRACTION');
      }
      return {
        adapterVersion: 'fixture-invoice-2026-09-04.1',
        supplier: field('Sehat Medical Distributors', 0.97, box(1, 40, 52, 260, 28)),
        supplierMatchCandidates: [
          { supplierId: 'supplier-sehat', label: 'Sehat Medical Distributors' },
        ],
        invoiceNumber: field('INV-240901', 0.96, box(1, 410, 52, 140, 24)),
        invoiceDate: field('2026-09-01', 0.92, box(1, 410, 80, 110, 22)),
        lines: [
          {
            productName: field('Paracetamol 500mg', 0.95, box(1, 36, 180, 190, 24)),
            productMatchCandidates: [
              { medicineId: 'med-paracetamol', label: 'Paracetamol 500mg tablets' },
            ],
            packLevel: field('box / 10 strips', 0.42, box(1, 230, 180, 90, 24)),
            quantity: field(20, 0.93, box(1, 325, 180, 45, 24)),
            bonusUnits: field(2, 0.89, box(1, 375, 180, 40, 24)),
            batch: field('PCM6A41', 0.94, box(1, 420, 180, 75, 24)),
            expiry: field('2028-03', 0.91, box(1, 500, 180, 70, 24)),
            printedMrpMinor: field(12500, 0.97, box(1, 575, 180, 65, 24)),
            unitCostMinor: field(9800, 0.88, box(1, 645, 180, 65, 24)),
            taxBps: field(0, 0.42, box(1, 715, 180, 45, 24)),
          },
        ],
      };
    },
  };
}
