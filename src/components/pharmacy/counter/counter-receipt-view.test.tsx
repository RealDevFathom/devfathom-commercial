import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CounterReceiptView, type CounterReceiptViewProps } from './counter-receipt-view';

afterEach(cleanup);

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
