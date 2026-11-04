import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptPrintControls, type ReceiptPrinting } from './receipt-print-controls';
import { requestReceiptDialog } from './receipt-browser-print';
import type { Receipt } from './receipt-view';
import type { TerminalRequest } from './checkout-panel';
import { buildReceiptPreview, SAMPLE_RECEIPT } from '@/lib/receipts/preview';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';

const receipt: Receipt = {
  billId: 'bill-1',
  orderNumber: 42,
  channel: 'DINE_IN',
  branchName: 'Main',
  businessDate: '2026-09-05',
  receiptNumber: 7,
  settledAt: '2026-09-05T10:00:00Z',
  splitKind: 'NONE',
  loyaltyWallet: null,
  lines: [
    {
      id: 'line-1',
      name: '<img src=x onerror=alert(1)> اردو e\u0301 𐐀 👩‍🍳',
      quantity: 1,
      unitPrice: '24.00',
      lineSubtotal: '24.00',
      compAmount: '4.00',
      lineTotal: '20.00',
    },
  ],
  tenders: [
    { id: 'tender-1', type: 'CASH', amount: '26.05', tipAmount: '1.50', changeGiven: '3.95' },
  ],
  totals: {
    subtotal: '24.00',
    discountTotal: '0.00',
    taxTotal: '2.00',
    serviceChargeTotal: '1.00',
    deliveryFeeTotal: '3.00',
    compTotal: '4.00',
    roundingAdjustment: '0.05',
    grandTotal: '26.05',
  },
};
const previewText = (width: 58 | 80) =>
  buildReceiptPreview(
    {
      ...DEFAULT_RECEIPT_LAYOUT,
      paperWidth: width,
      businessText: 'کاروبار',
      headerText: 'خوش آمدید',
      footerText: 'شکریہ',
    },
    {
      ...SAMPLE_RECEIPT,
      lines: [receipt.lines[0].name],
      totals: ['TOTAL 26.05', 'Delivery 3.00', 'Rounding 0.05'],
      payments: ['Tip 1.50 / Change 3.95'],
    }
  );
const initial: ReceiptPrinting = {
  branchId: 'branch-1',
  registerId: 'register-1',
  registerName: 'Counter',
  printerId: 'queue:///Receipt',
  latestJob: null,
  preview: { text: previewText(80), paperWidth: 80, source: 'saved' },
};
const queued: ReceiptPrinting = {
  ...initial,
  latestJob: {
    id: 'job-1',
    status: 'PENDING',
    printerId: initial.printerId,
    attemptCount: 0,
    lastAttemptAt: null,
    printedAt: null,
    createdAt: receipt.settledAt,
  },
};
const printed: ReceiptPrinting = {
  ...queued,
  latestJob: { ...queued.latestJob!, status: 'PRINTED' },
};
afterEach(() => vi.restoreAllMocks());

describe('Receipt print controls', () => {
  it('names branch/register/printer, prevents duplicate clicks and reports queued honestly', async () => {
    let resolve!: (value: ReceiptPrinting) => void;
    const request = vi.fn(
      () =>
        new Promise<ReceiptPrinting>((done) => {
          resolve = done;
        })
    );
    render(
      <ReceiptPrintControls
        receipt={receipt}
        initial={initial}
        request={request as TerminalRequest}
      />
    );
    expect(screen.getByText(/Branch: Main.*Register: Counter.*queue:\/\/\/Receipt/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Working…' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/restaurant/checkout/receipt', {
      method: 'POST',
      intent: 'receipt:bill-1:original',
      body: { billId: 'bill-1', action: 'print' },
    });
    resolve(queued);
    expect(await screen.findByText(/Receipt queued/)).toHaveTextContent(
      'paper output is not confirmed'
    );
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
  });
  it('disables dispatch without a printer while keeping browser fallback available', () => {
    render(
      <ReceiptPrintControls
        receipt={receipt}
        initial={{ ...initial, printerId: null }}
        request={vi.fn()}
      />
    );
    expect(screen.getByText(/No receipt printer configured/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open browser print dialog' })).toBeEnabled();
  });
  it('requires a reprint reason and preserves its request ID after uncertain failure', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(queued);
    render(<ReceiptPrintControls receipt={receipt} initial={printed} request={request} />);
    expect(screen.getByRole('button', { name: 'Reprint receipt' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reprint reason'), {
      target: { value: 'Customer copy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reprint receipt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery may be uncertain');
    expect(screen.getByLabelText('Reprint reason')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same print request' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[0][1].body).toMatchObject({
      action: 'reprint',
      reason: 'Customer copy',
    });
    expect(await screen.findByText(/Receipt queued/)).toBeVisible();
  });
  it('refreshes actual offline status without resubmitting', async () => {
    const request = vi.fn().mockResolvedValue({
      ...receipt,
      printing: { ...queued, latestJob: { ...queued.latestJob!, status: 'OFFLINE' } },
    });
    render(<ReceiptPrintControls receipt={receipt} initial={queued} request={request} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check print status' }));
    expect(await screen.findByText(/Printer unavailable or delivery failed/)).toBeVisible();
    expect(request).toHaveBeenCalledWith('/api/restaurant/checkout/receipt?billId=bill-1');
  });
  it('requires duplicate acknowledgement for browser copies and never treats afterprint as success', () => {
    const popup = {
      document: document.implementation.createHTMLDocument(),
      focus: vi.fn(),
      print: vi.fn(),
      opener: window,
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<ReceiptPrintControls receipt={receipt} initial={printed} request={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Open browser print dialog' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    expect(popup.print).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('afterprint'));
    expect(screen.getByText(/Print dialog requested/)).toHaveTextContent(
      'does not confirm printing'
    );
  });
});

describe('Browser receipt fallback', () => {
  it('prints the identical captured shared preview at its captured width after settings change', () => {
    const popup = {
      document: document.implementation.createHTMLDocument(),
      focus: vi.fn(),
      print: vi.fn(),
      opener: window,
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const text = 'Saved header\nInvoice: 7\nTOTAL 26.05\nSaved footer';
    render(
      <ReceiptPrintControls
        receipt={receipt}
        initial={{ ...queued, preview: { text, paperWidth: 58, source: 'queued' } }}
        request={vi.fn()}
      />
    );
    expect(screen.getByText(/Using the queued receipt layout/)).toHaveTextContent('58 mm');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Open browser print dialog' }));
    expect(popup.document.querySelector('pre')?.textContent).toBe(text);
    expect(popup.document.querySelector('style')?.textContent).toContain('width: 54mm');
  });
  it('keeps shared Unicode browser output available while disabling unsupported raw dispatch', () => {
    render(
      <ReceiptPrintControls
        receipt={receipt}
        initial={{
          ...initial,
          preview: {
            text: previewText(58),
            paperWidth: 58,
            source: 'saved',
            validation: {
              code: 'UNSUPPORTED_PRINT_TEXT',
              fallback: 'BROWSER_OS',
              error: new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT').message,
            },
          },
        }}
        request={vi.fn()}
      />
    );
    expect(screen.getByText(/Unsupported printer text/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open browser print dialog' })).toBeEnabled();
  });
  it('disables all printing for invalid previews, without a plain-text bypass', () => {
    render(
      <ReceiptPrintControls
        receipt={receipt}
        initial={{
          ...initial,
          preview: {
            text: null,
            paperWidth: 80,
            source: 'saved',
            validation: {
              code: 'INVALID_PRINT_DOCUMENT',
              fallback: null,
              error: new RawPrintValidationError('INVALID_PRINT_DOCUMENT').message,
            },
          },
        }}
        request={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open browser print dialog' })).toBeDisabled();
  });
  it.each(['INVALID_PRINT_DOCUMENT', 'UNSUPPORTED_PRINT_TEXT'] as const)(
    'handles a server %s refusal without claiming uncertain delivery',
    async (code) => {
      const failure = Object.assign(new RawPrintValidationError(code), { status: 422 });
      render(
        <ReceiptPrintControls
          receipt={receipt}
          initial={initial}
          request={vi.fn().mockRejectedValue(failure)}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(failure.message);
      expect(screen.getByRole('alert')).not.toHaveTextContent('uncertain');
      expect(screen.queryByRole('checkbox')).toBeNull();
      const button = screen.getByRole('button', { name: 'Open browser print dialog' });
      if (code === 'INVALID_PRINT_DOCUMENT') expect(button).toBeDisabled();
      else expect(button).toBeEnabled();
    }
  );
  it.each([58, 80] as const)(
    'requests %s mm paper with canonical facts and inert Unicode text',
    (width) => {
      const popup = {
        document: document.implementation.createHTMLDocument(),
        focus: vi.fn(),
        print: vi.fn(),
        opener: window,
      };
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      const text = previewText(width);
      requestReceiptDialog(receipt, width, text);
      expect(popup.document.querySelector('pre')?.textContent).toBe(text);
      expect(popup.document.querySelector('style')?.textContent).toContain('white-space: pre-wrap');
      expect(popup.document.querySelector('style')?.textContent).toContain(`width: ${width - 4}mm`);
      for (const fact of [
        'TOTAL 26.05',
        'Delivery 3.00',
        'Rounding 0.05',
        'Tip 1.50',
        'Change 3.95',
        receipt.lines[0].name,
      ])
        expect(popup.document.body.textContent).toContain(fact);
      expect(popup.document.querySelector('img')).toBeNull();
      expect(popup.opener).toBeNull();
      expect(popup.print).toHaveBeenCalledOnce();
    }
  );
  it('reports blocked popups without claiming a dialog', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => requestReceiptDialog(receipt, 80, previewText(80))).toThrow(
      'Print window blocked'
    );
  });
  it('refuses missing validated text before opening a popup', () => {
    const open = vi.spyOn(window, 'open');
    expect(() => requestReceiptDialog(receipt, 80, '')).toThrow(
      'Validated receipt preview unavailable'
    );
    expect(open).not.toHaveBeenCalled();
  });
});
