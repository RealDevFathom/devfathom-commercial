import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { reserveCounterBrowserPrint } from '@/lib/pharmacy/counter-browser-print';

import { CounterReceiptView, type CounterReceiptViewProps } from './counter-receipt-view';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function props(overrides: Partial<CounterReceiptViewProps> = {}): CounterReceiptViewProps {
  return {
    receipt: {
      saleId: 'sale-1',
      receiptNumber: 12,
      branchName: 'Branch',
      businessDate: '2026-09-05',
      completedAt: '2026-09-05T10:00:00Z',
      currency: 'PKR',
      lines: [
        {
          saleLineId: 'line-1',
          medicineName: 'Medicine',
          strength: null,
          presentation: 'Tablet',
          batchNumber: 'Batch',
          expiresAt: '2027-01-01',
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnits: 1,
          unitPriceMinor: 100,
          discountMinor: 0,
          lineTotalMinor: 100,
        },
      ],
      tenders: [],
      totals: {
        grossMinor: 100,
        discountMinor: 0,
        netMinor: 100,
        tenderedMinor: 100,
        changeMinor: 0,
      },
    },
    state: 'ready',
    locale: 'en',
    format: 'THERMAL',
    reprint: false,
    onLocaleChange: vi.fn(),
    onFormatChange: vi.fn(),
    onPrint: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

it('offers labeled paper selection and routes printing through the provided handler', () => {
  const input = props();
  render(<CounterReceiptView {...input} />);
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'THERMAL_58' } });
  expect(input.onFormatChange).toHaveBeenCalledWith('THERMAL_58');
  fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
  expect(input.onPrint).toHaveBeenCalledOnce();
  expect(screen.getByText(/saved designer settings are not connected yet/i)).toBeTruthy();
});

it('disables controls while refreshing the receipt', () => {
  render(<CounterReceiptView {...props({ printing: true })} />);
  expect(screen.getByLabelText('Format')).toBeDisabled();
  expect(screen.getByLabelText('Language')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Loading receipt…' })).toBeDisabled();
});

it('labels reprints and disables unissued receipts', () => {
  const input = props({ reprint: true });
  input.receipt = { ...input.receipt!, receiptNumber: null };
  render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('button', { name: 'Reprint receipt' })).toBeDisabled();
});

it('shows retry on failed or permission-denied receipt reads', () => {
  const input = props({ state: 'error', error: 'You do not have permission for this action.' });
  render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission');
  fireEvent.click(screen.getByRole('button', { name: 'Retry receipt' }));
  expect(input.onRetry).toHaveBeenCalledOnce();
  expect(screen.queryByText('Medicine')).toBeNull();
});

it.each(['idle', 'loading'] as const)('does not expose print actions while %s', (state) => {
  render(<CounterReceiptView {...props({ state, receipt: null })} />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows both allocation subrows, Unicode and one unchanged financial line', () => {
  const input = props();
  input.receipt!.lines[0] = {
    ...input.receipt!.lines[0]!,
    identityStatus: 'ISSUED',
    medicineName: 'دوا 👩‍⚕️',
    expiresAt: '',
    allocations: [
      {
        allocationId: 'a',
        inventoryLotId: 'a',
        batchNumber: '<img src=x>',
        expiresAt: '2027-01-01',
        canonicalUnits: 3,
      },
      {
        allocationId: 'b',
        inventoryLotId: 'b',
        batchNumber: 'بیچ ب',
        expiresAt: '2028-02-02',
        canonicalUnits: 7,
      },
    ],
  };
  const { container } = render(<CounterReceiptView {...input} />);
  const region = within(screen.getByRole('region', { name: 'Receipt 12' }));
  expect(region.getAllByRole('listitem')).toHaveLength(1);
  expect(region.getByText(/دوا 👩‍⚕️/)).toBeTruthy();
  expect(
    region.getByText('Batch: <img src=x> · Expiry: 2027-01-01 · Canonical units: 3')
  ).toBeTruthy();
  expect(region.getByText('Batch: بیچ ب · Expiry: 2028-02-02 · Canonical units: 7')).toBeTruthy();
  expect(within(region.getByRole('listitem')).getAllByText('1.00')).toHaveLength(1);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('pre')).toHaveClass('whitespace-pre-wrap');
});

it.each(['UNAVAILABLE', undefined] as const)(
  'localizes %s identity and hides unverified catalog labels',
  (identityStatus) => {
    const input = props({ locale: 'ur' });
    input.receipt!.lines[0] = {
      ...input.receipt!.lines[0]!,
      identityStatus,
      medicineName: 'LIVE_CATALOG',
      allocations: [
        {
          allocationId: 'a',
          inventoryLotId: 'a',
          batchNumber: null,
          expiresAt: null,
          canonicalUnits: 7,
        },
      ],
    };
    render(<CounterReceiptView {...input} />);
    const region = within(screen.getByRole('region', { name: 'رسید 12' }));
    expect(region.getByText('تاریخی شناخت دستیاب نہیں')).toBeTruthy();
    expect(
      region.getByText('بیچ: دستیاب نہیں · میعاد: دستیاب نہیں · بنیادی اکائیاں: 7')
    ).toBeTruthy();
    expect(screen.queryByText(/LIVE_CATALOG/)).toBeNull();
  }
);

it('disables printing when shared semantic validation rejects the receipt', () => {
  const input = props();
  input.receipt!.branchName = 'Bad\u001b';
  render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('cannot be previewed');
});

function printWindow() {
  return {
    opener: window,
    closed: false,
    document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
}

function confirmed(autoPrint = true) {
  return { status: 'confirmed' as const, saleId: 'sale-1', receiptNumber: 12, autoPrint };
}

it('reveals and focuses each new confirmed receipt once, including StrictMode and rerenders', () => {
  const popup = printWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const input = props({ onSettlementPresented: vi.fn() });
  const { rerender } = render(
    <StrictMode>
      <CounterReceiptView {...input} />
    </StrictMode>
  );
  const region = screen.getByRole('region', { name: 'Receipt 12' });
  region.scrollIntoView = vi.fn();
  expect(region).not.toHaveFocus();
  expect(open).not.toHaveBeenCalled();

  const reservation = reserveCounterBrowserPrint();
  expect(popup.print).not.toHaveBeenCalled();
  const settlement = { ...confirmed(), printReservation: reservation };
  rerender(
    <StrictMode>
      <CounterReceiptView {...input} settlement={settlement} />
    </StrictMode>
  );
  expect(region).toBeVisible();
  expect(region).toHaveFocus();
  expect(region.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
  expect(popup.print).toHaveBeenCalledOnce();
  expect(input.onSettlementPresented).toHaveBeenCalledExactlyOnceWith({
    saleId: 'sale-1',
    receiptNumber: 12,
    printStatus: 'dialog-requested',
  });
  expect(input.onPrint).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('Physical printing is not confirmed');

  rerender(
    <StrictMode>
      <CounterReceiptView
        {...input}
        receipt={{ ...input.receipt! }}
        settlement={{ ...settlement }}
        locale="ur"
        format="A4"
        onSettlementPresented={vi.fn()}
      />
    </StrictMode>
  );
  expect(popup.print).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();

  const nextReceipt = { ...input.receipt!, saleId: 'sale-2', receiptNumber: 13 };
  const nextEvent = { ...confirmed(), saleId: 'sale-2', receiptNumber: 13 };
  rerender(
    <StrictMode>
      <CounterReceiptView {...input} receipt={nextReceipt} settlement={nextEvent} />
    </StrictMode>
  );
  expect(screen.getByRole('region', { name: 'Receipt 13' })).toHaveFocus();
  expect(popup.print).toHaveBeenCalledTimes(2);
  rerender(
    <StrictMode>
      <CounterReceiptView {...input} settlement={{ ...confirmed() }} />
    </StrictMode>
  );
  expect(popup.print).toHaveBeenCalledTimes(2);
  expect(input.onSettlementPresented).toHaveBeenCalledTimes(2);
});

it('consumes an initial explicit new-settlement event once during StrictMode effect replay', () => {
  const popup = printWindow();
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const input = props({ settlement: confirmed(), onSettlementPresented: vi.fn() });
  render(
    <StrictMode>
      <CounterReceiptView {...input} />
    </StrictMode>
  );
  expect(popup.print).toHaveBeenCalledOnce();
  expect(input.onSettlementPresented).toHaveBeenCalledOnce();
});

it.each([undefined, null, { status: 'pending' }, { status: 'unknown' }] as const)(
  'keeps historical/absent or unresolved settlement %j inert even with issued receipt data',
  (settlement) => {
    const open = vi.spyOn(window, 'open');
    const input = props({ settlement, onSettlementPresented: vi.fn() });
    const { rerender } = render(<CounterReceiptView {...input} />);
    rerender(<CounterReceiptView {...input} receipt={{ ...input.receipt! }} />);
    expect(screen.getByRole('region', { name: 'Receipt 12' })).not.toHaveFocus();
    expect(open).not.toHaveBeenCalled();
    expect(input.onSettlementPresented).not.toHaveBeenCalled();
    expect(input.onPrint).not.toHaveBeenCalled();
  }
);

it('presents without auto-print when disabled and does not print after a preference rerender', () => {
  const open = vi.spyOn(window, 'open');
  const input = props({ settlement: confirmed(false), onSettlementPresented: vi.fn() });
  const { rerender } = render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('region', { name: 'Receipt 12' })).toHaveFocus();
  expect(input.onSettlementPresented).toHaveBeenCalledExactlyOnceWith({
    saleId: 'sale-1',
    receiptNumber: 12,
    printStatus: 'manual',
  });
  expect(screen.getByRole('status')).toHaveTextContent('Use Print receipt');
  rerender(<CounterReceiptView {...input} settlement={confirmed()} />);
  expect(open).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Print receipt' });
  expect(button).toBeEnabled();
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(input.onPrint).toHaveBeenCalledOnce();
});

it.each(['idle', 'loading', 'error'] as const)('waits for a ready receipt while %s', (state) => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const input = props({ settlement: confirmed(), onSettlementPresented: vi.fn() });
  const { rerender } = render(<CounterReceiptView {...input} state={state} />);
  expect(open).not.toHaveBeenCalled();
  expect(input.onSettlementPresented).not.toHaveBeenCalled();
  rerender(<CounterReceiptView {...input} />);
  expect(open).toHaveBeenCalledOnce();
});

it('waits while refreshing, then presents when the authoritative receipt is ready', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const input = props({ settlement: confirmed(), onSettlementPresented: vi.fn() });
  const { rerender } = render(<CounterReceiptView {...input} printing />);
  expect(open).not.toHaveBeenCalled();
  expect(input.onSettlementPresented).not.toHaveBeenCalled();
  rerender(<CounterReceiptView {...input} />);
  expect(open).toHaveBeenCalledOnce();
});

it.each([
  { saleId: 'different-sale' },
  { receiptNumber: 13 },
  { receiptNumber: null },
  { completedAt: null },
  { lines: [] },
  { branchName: 'Bad\u001b' },
])('has no effects for mismatched or invalid receipt %j', (change) => {
  const open = vi.spyOn(window, 'open');
  const input = props({ settlement: confirmed(), onSettlementPresented: vi.fn() });
  render(<CounterReceiptView {...input} receipt={{ ...input.receipt!, ...change }} />);
  expect(open).not.toHaveBeenCalled();
  expect(input.onSettlementPresented).not.toHaveBeenCalled();
  expect(screen.getByRole('region')).not.toHaveFocus();
});

it('announces blocked-popup recovery and keeps manual Print accessible without automatic retries', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  const reservation = reserveCounterBrowserPrint();
  const input = props({
    settlement: { ...confirmed(), printReservation: reservation },
    onSettlementPresented: vi.fn(),
  });
  const { rerender } = render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Allow pop-ups');
  expect(screen.getByRole('alert')).toHaveTextContent('retry Print receipt');
  expect(input.onSettlementPresented).toHaveBeenCalledExactlyOnceWith({
    saleId: 'sale-1',
    receiptNumber: 12,
    printStatus: 'manual-required',
  });
  const button = screen.getByRole('button', { name: 'Print receipt' });
  expect(button.tagName).toBe('BUTTON');
  expect(button.tabIndex).toBe(0);
  expect(button).toBeEnabled();
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(input.onPrint).toHaveBeenCalledOnce();
  rerender(<CounterReceiptView {...input} />);
  expect(open).toHaveBeenCalledOnce();
  expect(print).not.toHaveBeenCalled();
});
