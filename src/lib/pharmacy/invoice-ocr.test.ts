import { describe, expect, it } from 'vitest';

import {
  REGULATED_INVOICE_FIELDS,
  assertInvoiceDraftConfirmed,
  confirmInvoiceField,
  createFixtureInvoiceOcrAdapter,
  createInvoiceGoodsReceiptDraft,
} from './invoice-ocr';

async function fixtureDraft() {
  const extraction = await createFixtureInvoiceOcrAdapter().extract({
    content: Buffer.from('fixture invoice'),
    mimeType: 'application/pdf',
    pageCount: 1,
    importId: 'invoice-fixture-1',
  });
  return createInvoiceGoodsReceiptDraft(extraction);
}

describe('invoice OCR goods-receipt draft', () => {
  it('produces a draft with match candidates, confidence and source boxes', async () => {
    const draft = await fixtureDraft();
    expect(draft.status).toBe('DRAFT');
    expect(draft.supplierMatchCandidates).toHaveLength(1);
    expect(draft.lines[0]?.productMatchCandidates).toHaveLength(1);
    expect(draft.lines[0]?.batch).toMatchObject({
      value: 'PCM6A41',
      confidence: 0.94,
      sourceBox: { page: 1 },
    });
  });

  it('refuses posting while any OCR-regulated field is unconfirmed', async () => {
    const draft = await fixtureDraft();
    expect(() => assertInvoiceDraftConfirmed(draft)).toThrowError('OCR_CONFIRMATION_REQUIRED');
  });

  it('requires explicit confirmation even when confidence is low', async () => {
    let draft = await fixtureDraft();
    expect(draft.lines[0]?.packLevel.confidence).toBeLessThan(0.6);
    for (const regulatedField of REGULATED_INVOICE_FIELDS.filter(
      (field) => field !== 'packLevel'
    )) {
      draft = confirmInvoiceField(draft, {
        lineIndex: 0,
        field: regulatedField,
        confirmedById: 'user-pharmacist',
        at: new Date('2026-09-04T10:00:00.000Z'),
      });
    }
    expect(() => assertInvoiceDraftConfirmed(draft)).toThrowError('OCR_CONFIRMATION_REQUIRED');
    draft = confirmInvoiceField(draft, {
      lineIndex: 0,
      field: 'packLevel',
      confirmedById: 'user-pharmacist',
      at: new Date('2026-09-04T10:01:00.000Z'),
    });
    expect(() => assertInvoiceDraftConfirmed(draft)).not.toThrow();
    expect(draft.confirmations).toHaveLength(REGULATED_INVOICE_FIELDS.length);
  });
});
