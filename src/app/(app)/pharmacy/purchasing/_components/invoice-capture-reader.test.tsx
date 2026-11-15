import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyInvoiceCapture: {
      read: { useMutation: () => ({ mutateAsync: h.mutateAsync, isPending: false }) },
    },
  },
}));

import { InvoiceCaptureReader } from './invoice-capture-reader';
import { ProgressiveLines } from './progressive-lines';

const line = (index: number, overrides: Record<string, unknown> = {}) => ({
  index,
  product: { value: `Synthetic Product ${index + 1}`, confidence: 0.95 },
  packPrinted: 'Box',
  medicine: { medicineId: 'med-a', productName: 'Synthetic Paracetamol 500mg' },
  pack: { packLevelId: 'pack-box', level: 'BOX', canonicalUnitsPerPack: 100 },
  candidates: [],
  batch: { value: 'SYN-B2741', confidence: 0.95 },
  expiry: {
    kind: 'read',
    printed: '06/2028',
    candidate: { date: '2028-06-30', precision: 'MONTH' },
    confidence: 0.9,
  },
  receivedPacks: 20,
  bonus: { kind: 'scheme', buy: 10, free: 1, packs: 2 },
  bonusPacks: 2,
  printedMrpMinor: 45_000,
  tradePriceMinor: 38_250,
  discountBps: 250,
  taxBps: 1_700,
  lastPurchase: {
    reference: 'GRN-9',
    receivedAt: '2026-10-01T00:00:00.000Z',
    supplierName: 'Synthetic Medical Distributors',
    printedMrpMinor: 40_000,
    tradePriceMinor: 38_250,
  },
  mrpCheck: { lastMinor: 40_000, differenceMinor: 5_000, differenceBps: 1_250 },
  tradePriceCheck: { lastMinor: 38_250, differenceMinor: 0, differenceBps: 0 },
  warnings: ['MRP_DIFFERS_FROM_LAST_PURCHASE'],
  ...overrides,
});

const PROPOSAL = {
  status: 'PROPOSED',
  requiresReviewerConfirmation: true,
  adapter: 'FIXTURE',
  adapterVersion: 'test',
  supplier: {
    printed: 'Synthetic Medical Distributors',
    confidence: 0.95,
    match: { supplierId: 'sup-a', name: 'Synthetic Medical Distributors' },
  },
  invoiceNumber: { value: 'SYN-INV-1001', confidence: 0.95 },
  invoiceDate: { printed: '14/11/2026', confidence: 0.95, date: '2026-11-14' },
  duplicate: null,
  lines: [
    line(0),
    line(1, {
      medicine: null,
      pack: null,
      candidates: [{ medicineId: 'med-z', productName: 'Synthetic Other' }],
      lastPurchase: null,
      mrpCheck: null,
      tradePriceCheck: null,
      warnings: ['MEDICINE_NOT_MATCHED'],
    }),
  ],
  warnings: [],
};

const FIELDS = [
  'batchNumber',
  'printedExpiry',
  'expiryPrecision',
  'printedMrp',
  'receivedPacks',
  'bonusPacks',
  'invoicedPrice',
  'discount',
  'tax',
];

function harness() {
  const lines = [0, 1, 2].map((slot) => ({
    selector: (
      <label>
        Line {slot + 1}
        <select defaultValue="" name={`directPack-${slot}`}>
          <option value="">Skip this line</option>
          <option value="med-a|pack-box|100">Synthetic Paracetamol — BOX</option>
          <option value="med-a|pack-strip|10">Synthetic Paracetamol — STRIP</option>
        </select>
      </label>
    ),
    fields: (
      <div>
        {FIELDS.map((field) =>
          field === 'expiryPrecision' ? (
            <select defaultValue="MONTH" key={field} name={`${field}:d${slot}`}>
              <option value="MONTH">Month</option>
              <option value="DAY">Day</option>
            </select>
          ) : (
            <input aria-label={`${field} ${slot + 1}`} key={field} name={`${field}:d${slot}`} />
          )
        )}
      </div>
    ),
  }));
  render(
    <form aria-label="Direct purchase">
      <InvoiceCaptureReader
        branchId="branch-a"
        lineSlots={3}
        names={{
          supplier: 'supplierId',
          invoiceRef: 'directInvoiceRef',
          invoiceDate: 'directInvoiceDate',
          packPrefix: 'directPack-',
          linePrefix: 'd',
        }}
      />
      <select aria-label="Supplier" defaultValue="" name="supplierId">
        <option value="">Choose</option>
        <option value="sup-a">Synthetic Medical Distributors</option>
      </select>
      <input name="directInvoiceRef" />
      <input name="directInvoiceDate" type="date" />
      <ProgressiveLines lines={lines} />
    </form>
  );
  return () =>
    new FormData(screen.getByRole('form', { name: 'Direct purchase' }) as HTMLFormElement);
}

async function upload() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Fill from a distributor invoice (photo or PDF)' })
  );
  const pdf = new File(['%PDF-1.4 synthetic'], 'invoice.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('Invoice photo or PDF'), { target: { files: [pdf] } });
  await screen.findByRole('table');
}

beforeEach(() => {
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue(PROPOSAL);
});

describe('InvoiceCaptureReader', () => {
  it('sends the PDF and shows the server-computed price differences for review', async () => {
    harness();
    await upload();
    expect(h.mutateAsync).toHaveBeenCalledWith({
      branchId: 'branch-a',
      supplierId: undefined,
      document: { contentType: 'application/pdf', dataBase64: expect.any(String) },
    });
    expect(screen.getByText('+Rs 50.00 (+12.5%) on last Rs 400.00')).toBeInTheDocument();
    expect(screen.getByText('same as last (Rs 382.50)')).toBeInTheDocument();
    expect(screen.getByText('MRP differs from the last purchase.')).toBeInTheDocument();
    expect(screen.getByText('Possible: Synthetic Other')).toBeInTheDocument();
  });

  it('copies nothing until the reviewer confirms, then fills the form for them to file', async () => {
    const values = harness();
    await upload();
    const copy = screen.getByRole('button', { name: 'Copy into the direct purchase form' });
    expect(copy).toBeDisabled();
    fireEvent.click(copy);
    expect(values().get('directInvoiceRef')).toBe('');

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I have checked these values against the paper invoice.',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy into the direct purchase form' }));

    const form = values();
    expect(form.get('supplierId')).toBe('sup-a');
    expect(form.get('directInvoiceRef')).toBe('SYN-INV-1001');
    expect(form.get('directInvoiceDate')).toBe('2026-11-14');
    expect(form.get('directPack-0')).toBe('med-a|pack-box|100');
    expect(Object.fromEntries(FIELDS.map((field) => [field, form.get(`${field}:d0`)]))).toEqual({
      batchNumber: 'SYN-B2741',
      printedExpiry: '2028-06-30',
      expiryPrecision: 'MONTH',
      printedMrp: '450.00',
      receivedPacks: '20',
      bonusPacks: '2',
      invoicedPrice: '382.50',
      discount: '2.5',
      tax: '17',
    });
    // The unmatched line is revealed and filled, but its medicine is left to the receiver.
    expect(form.get('directPack-1')).toBe('');
    expect(form.get('batchNumber:d1')).toBe('SYN-B2741');
    expect(form.get('directPack-2')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Copied 2 lines.*Choose the medicine and pack on line 2\./
    );
  });

  it('never copies a supplier bill that is already filed', async () => {
    h.mutateAsync.mockResolvedValue({
      ...PROPOSAL,
      duplicate: { goodsReceiptId: 'gr-1', reference: 'GRN-7', status: 'POSTED' },
      warnings: ['DUPLICATE_SUPPLIER_INVOICE'],
    });
    const values = harness();
    await upload();
    expect(screen.getByRole('alert')).toHaveTextContent(/Already filed as receipt GRN-7/);
    expect(screen.queryByRole('button', { name: 'Copy into the direct purchase form' })).toBeNull();
    expect(values().get('directInvoiceRef')).toBe('');
  });

  it('sends the supplier already chosen on the form', async () => {
    const values = harness();
    fireEvent.change(screen.getByRole('combobox', { name: 'Supplier' }), { target: { value: 'sup-a' } });
    expect(values().get('supplierId')).toBe('sup-a');
    await upload();
    await waitFor(() =>
      expect(h.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ supplierId: 'sup-a' }))
    );
  });

  it('keeps manual entry open when the invoice cannot be read', async () => {
    h.mutateAsync.mockRejectedValue(
      new Error('The invoice could not be read. Enter the lines by hand.')
    );
    harness();
    fireEvent.click(
      screen.getByRole('button', { name: 'Fill from a distributor invoice (photo or PDF)' })
    );
    fireEvent.change(screen.getByLabelText('Invoice photo or PDF'), {
      target: { files: [new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The invoice could not be read. Enter the lines by hand. The form below still works by hand.'
    );
  });
});
