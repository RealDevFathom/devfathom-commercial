import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

it('keeps Rx printing disabled when receipt has no sourced directions or licence', () => {
  render(<CounterReceiptView {...props()} />);
  expect(screen.getByRole('button', { name: /Print Rx labels/ })).toBeDisabled();
  expect(screen.getByText(/sourced Rx directions/)).toBeTruthy();
});

it('opens isolated Rx labels and exposes popup failure with retry available', () => {
  const input = props();
  input.receipt!.lines[0]!.identityStatus = 'ISSUED';
  input.receipt!.lines[0]!.allocations = [
    {
      allocationId: 'a',
      inventoryLotId: 'a',
      batchNumber: 'TEST',
      expiresAt: '2027-01-01',
      canonicalUnits: 1,
    },
  ];
  input.dispensingLabelSources = [
    {
      saleId: 'sale-1',
      saleLineId: 'line-1',
      rx: true,
      pharmacistRegistration: 'REG',
      licenceNumber: 'TEST',
      directionsEnglish: 'English fixture',
      directionsUrdu: 'اردو',
    },
  ];
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<CounterReceiptView {...input} />);
  const button = screen.getByRole('button', { name: /Print Rx labels/ });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(screen.getByRole('alert')).toHaveTextContent('Allow pop-ups');
  const popup = {
    opener: window,
    document: { open: vi.fn(), write: vi.fn(), close: vi.fn(), querySelectorAll: () => [] },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
  open.mockReturnValue(popup as unknown as Window);
  fireEvent.click(button);
  expect(popup.document.write).toHaveBeenCalledWith(expect.stringContaining('size: 50mm 30mm'));
  expect(popup.print).toHaveBeenCalledOnce();
  expect(input.onPrint).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  open.mockRestore();
});

it('selects only the clicked line source from the production receipt payload', () => {
  const input = props();
  const line = input.receipt!.lines[0]!;
  input.receipt!.lines = ['first', 'second'].map((saleLineId) => ({
    ...line,
    saleLineId,
    identityStatus: 'ISSUED',
    allocations: [
      {
        allocationId: saleLineId,
        inventoryLotId: saleLineId,
        batchNumber: saleLineId,
        expiresAt: '2027-01-01',
        canonicalUnits: 1,
      },
    ],
  }));
  input.receipt!.dispensingLabelSources = ['first', 'second'].map((saleLineId) => ({
    saleId: input.receipt!.saleId,
    saleLineId,
    rx: true,
    licenceNumber: 'LIC',
    pharmacistRegistration: 'REG',
    directionsEnglish: `${saleLineId} directions`,
    directionsUrdu: 'اردو',
  }));
  const popup = {
    opener: window,
    document: { open: vi.fn(), write: vi.fn(), close: vi.fn(), querySelectorAll: () => [] },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  render(<CounterReceiptView {...input} />);
  fireEvent.click(screen.getAllByRole('button', { name: /Print Rx labels/ })[1]!);
  expect(popup.document.write).toHaveBeenCalledWith(expect.stringContaining('second directions'));
  expect(popup.document.write.mock.calls[0]![0]).not.toContain('first directions');
  open.mockRestore();
});

const still = 'data:image/png;base64,iVBORw0KGgo=';

it('shows the refund still beside the receipt, outside the printable document', () => {
  const { container } = render(
    <CounterReceiptView
      {...props({
        reprint: true,
        evidence: [
          {
            id: 'e-tender',
            kind: 'TENDER',
            status: 'PURGED',
            requestedAt: '2026-09-05T10:00:00.000Z',
            capturedAt: '2026-09-05T10:00:05.000Z',
            image: null,
          },
          {
            id: 'e-refund',
            kind: 'REFUND',
            status: 'CAPTURED',
            requestedAt: '2026-09-06T08:30:00.000Z',
            capturedAt: '2026-09-06T08:31:00.000Z',
            image: still,
          },
        ],
      })}
    />
  );
  const evidence = within(screen.getByRole('region', { name: 'Camera evidence' }));
  const image = evidence.getByRole('img', {
    name: 'Camera still at refund, 2026-09-06 08:31 UTC',
  });
  expect(image).toHaveAttribute('src', still);
  expect(evidence.getByText('Still removed under the camera retention period.')).toBeTruthy();
  expect(evidence.getByText('Captured 2026-09-06 08:31 UTC')).toBeTruthy();
  const receipt = screen.getByRole('region', { name: 'Receipt 12' });
  expect(within(receipt).queryByRole('img')).toBeNull();
  expect(container.querySelector('pre')?.textContent ?? '').not.toContain('Camera');
});

it.each([
  ['PENDING', 'Still pending capture.', 'Requested 2026-09-06 08:30 UTC'],
  ['FAILED', 'No still was captured.', 'Requested 2026-09-06 08:30 UTC'],
] as const)('explains %s evidence without an image', (status, message, time) => {
  render(
    <CounterReceiptView
      {...props({
        evidence: [
          {
            id: 'e',
            kind: 'REFUND',
            status,
            requestedAt: '2026-09-06T08:30:00.000Z',
            capturedAt: null,
            image: null,
          },
        ],
      })}
    />
  );
  const evidence = within(screen.getByRole('region', { name: 'Camera evidence' }));
  expect(evidence.getByText(message)).toBeTruthy();
  expect(evidence.getByText(time)).toBeTruthy();
  expect(evidence.queryByRole('img')).toBeNull();
});

it.each([undefined, null, []])('renders no evidence section for %j', (evidence) => {
  render(<CounterReceiptView {...props({ evidence })} />);
  expect(screen.queryByRole('region', { name: 'Camera evidence' })).toBeNull();
});


it.each(['en', 'ur'] as const)('#727 shows issued promotion savings in %s alongside the original line net', (locale) => {
  const input = props({ locale });
  input.receipt!.lines[0] = {
    ...input.receipt!.lines[0]!, promotionName: 'Nov offer', discountMinor: 10, lineTotalMinor: 90,
  };
  input.receipt!.totals = {
    grossMinor: 100, discountMinor: 10, netMinor: 90, tenderedMinor: 90, changeMinor: 0,
  };
  render(<CounterReceiptView {...input} />);
  const line = screen.getByRole('listitem');
  expect(within(line).getByText(/Nov offer \(-0\.10\)/)).toBeVisible();
  expect(line).toHaveTextContent('0.90');
});
