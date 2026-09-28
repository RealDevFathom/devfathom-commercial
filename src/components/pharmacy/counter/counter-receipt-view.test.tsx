import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CounterReceiptView, type CounterReceiptViewProps } from './counter-receipt-view';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

function stubPrintBridge(...responses: Array<{ status: number; body: unknown }>) {
  const fetch = vi.fn();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const readyJob = (reprint: boolean) => ({
  status: 200,
  body: {
    mode: 'ESC_POS_JOB',
    status: 'READY',
    escPos: { encoding: 'base64', data: 'G0AdVgA=', byteCount: 5 },
    paperWidth: 58,
    reprint,
  },
});

it('keeps browser printing only when no branch is bound to the thermal bridge', () => {
  render(<CounterReceiptView {...props()} />);
  expect(screen.getByRole('button', { name: 'Print receipt' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /thermal/i })).toBeNull();
});

it('prints to thermal, then offers a reprint of the same receipt', async () => {
  const fetch = stubPrintBridge(readyJob(false), readyJob(true));
  const input = props({ branchId: 'branch-1' });
  render(<CounterReceiptView {...input} />);

  fireEvent.click(screen.getByRole('button', { name: 'Print to thermal (ESC/POS)' }));
  const link = await screen.findByRole('link', { name: 'Save ESC/POS job' });
  expect(fetch.mock.calls[0]![0]).toBe(
    '/api/pharmacy/print?branchId=branch-1&saleId=sale-1&locale=en&reprint=0'
  );
  expect(link).toHaveAttribute('href', 'data:application/octet-stream;base64,G0AdVgA=');
  expect(link).toHaveAttribute('download', 'receipt-12.bin');
  expect(screen.getByRole('status')).toHaveTextContent('5 bytes, 58 mm branch format');
  expect(input.onPrint).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Reprint to thermal (ESC/POS)' }));
  await waitFor(() =>
    expect(screen.getByRole('link', { name: 'Save ESC/POS job' })).toHaveAttribute(
      'download',
      'receipt-12-reprint.bin'
    )
  );
  expect(fetch.mock.calls[1]![0]).toContain('reprint=1');
});

it('reprints a historical receipt directly when the receipt is already a reprint', async () => {
  const fetch = stubPrintBridge(readyJob(true));
  render(<CounterReceiptView {...props({ branchId: 'branch-1', reprint: true })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reprint to thermal (ESC/POS)' }));
  await screen.findByRole('link', { name: 'Save ESC/POS job' });
  expect(fetch.mock.calls[0]![0]).toContain('reprint=1');
  expect(screen.getByRole('status')).toHaveTextContent('marked as a reprint');
});

it('points Urdu receipts to the unchanged browser/OS fallback', async () => {
  stubPrintBridge({
    status: 422,
    body: { error: 'Unsupported', code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' },
  });
  const input = props({ branchId: 'branch-1', locale: 'ur' });
  render(<CounterReceiptView {...input} />);
  fireEvent.click(screen.getByRole('button', { name: 'Print to thermal (ESC/POS)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use Print receipt');
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }));
  expect(input.onPrint).toHaveBeenCalledOnce();
});

it('shows bridge errors and disables thermal printing for unissued receipts', async () => {
  stubPrintBridge({ status: 403, body: { error: 'Forbidden.' } });
  render(<CounterReceiptView {...props({ branchId: 'branch-1' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Print to thermal (ESC/POS)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden.');
  cleanup();

  const input = props({ branchId: 'branch-1' });
  input.receipt = { ...input.receipt!, receiptNumber: null };
  render(<CounterReceiptView {...input} />);
  expect(screen.getByRole('button', { name: 'Print to thermal (ESC/POS)' })).toBeDisabled();
});
