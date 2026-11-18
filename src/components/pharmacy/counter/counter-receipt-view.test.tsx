import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    onPrint: vi.fn(async () => true),
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
  expect(
    screen.getByText(/saved printer settings; a change here applies to this session only/i)
  ).toBeTruthy();
  expect(screen.getByText(/Printing cannot be confirmed here/i)).toBeTruthy();
});

it('shows recorded payment, exact change and an issued receipt preview without printing again', () => {
  const input = props();
  input.receipt!.lines[0]!.identityStatus = 'ISSUED';
  input.receipt!.tenders = [
    {
      tenderId: 'cash-1',
      type: 'CASH',
      amountMinor: 100,
      cashReceivedMinor: 200,
      changeGivenMinor: 100,
    },
  ];
  input.receipt!.totals.tenderedMinor = 200;
  input.receipt!.totals.changeMinor = 100;
  render(<CounterReceiptView {...input} />);

  const recorded = within(screen.getByRole('status'));
  expect(recorded.getByRole('heading', { name: 'Payment recorded' })).toBeTruthy();
  expect(recorded.getByText('Receipt 12')).toBeTruthy();
  expect(recorded.getByText('Change').nextElementSibling).toHaveTextContent('PKR 1.00');
  expect(recorded.getByText('Total').nextElementSibling).toHaveTextContent('PKR 1.00');
  expect(screen.getByRole('heading', { name: 'Receipt preview' })).toBeTruthy();
  const preview = within(screen.getByRole('region', { name: 'Receipt 12' }));
  expect(preview.getByText(/Medicine/)).toBeTruthy();
  expect(preview.getByText('CASH')).toBeTruthy();
  expect(preview.getByText('Tendered').nextElementSibling).toHaveTextContent('2.00');
  expect(preview.getByText('Cash received').nextElementSibling).toHaveTextContent('2.00');
  expect(input.onPrint).not.toHaveBeenCalled();
});

it('shows cash received separately from other tenders and omits it for incomplete legacy data', () => {
  const input = props();
  input.receipt!.tenders = [
    {
      tenderId: 'cash',
      type: 'CASH',
      amountMinor: 100,
      cashReceivedMinor: 200,
      changeGivenMinor: 100,
    },
    { tenderId: 'wallet', type: 'WALLET', amountMinor: 300, changeGivenMinor: null },
  ];
  const view = render(<CounterReceiptView {...input} />);
  expect(screen.getByText('Cash received').nextElementSibling).toHaveTextContent('2.00');
  input.receipt!.tenders[0]!.cashReceivedMinor = null;
  view.rerender(<CounterReceiptView {...input} />);
  expect(screen.queryByText('Cash received')).toBeNull();
});

it.each([{ receiptNumber: null }, { completedAt: null }])(
  'does not announce recorded payment for an incomplete receipt: %j',
  (incomplete) => {
    const input = props();
    input.receipt = { ...input.receipt!, ...incomplete };
    render(<CounterReceiptView {...input} />);
    expect(screen.queryByRole('heading', { name: 'Payment recorded' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeDisabled();
  }
);

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

it('renders every Urdu receipt amount in Urdu digits', () => {
  const input = props({ locale: 'ur' });
  input.receipt = {
    ...input.receipt!,
    lines: [{ ...input.receipt!.lines[0]!, unitPriceMinor: 123_456, lineTotalMinor: 123_456 }],
    tenders: [
      {
        tenderId: 'tender-1',
        type: 'CASH',
        amountMinor: 123_456,
        cashReceivedMinor: 234_567,
        changeGivenMinor: 0,
      },
    ],
  };
  const { container } = render(<CounterReceiptView {...input} />);
  const region = screen.getByRole('region', { name: 'رسید 12' });
  const item = within(region).getByRole('listitem');
  // Line total (its own span) and the unit price (inside the quantity line).
  expect(within(item).getByText('۱۲۳۴٫۵۶')).toBeTruthy();
  expect(within(item).getByText(/×\s*۱۲۳۴٫۵۶/)).toBeTruthy();
  // Gross, net and tendered are 100; discount and change are 0; the tender is 123456.
  expect(within(region).getAllByText('۱٫۰۰')).toHaveLength(3);
  expect(within(region).getAllByText('۰٫۰۰')).toHaveLength(2);
  expect(within(region).getAllByText('۱۲۳۴٫۵۶')).toHaveLength(2);
  expect(within(region).getByText('نقد ادا شدہ').nextElementSibling).toHaveTextContent('۲۳۴۵٫۶۷');
  expect(container.textContent).not.toContain('1234.56');
  expect(region.textContent).not.toMatch(/\d\.\d\d/);
  // The settled banner's net and change follow the receipt locale too.
  expect(screen.getByText('PKR ۱٫۰۰')).toBeTruthy();
  expect(screen.getByText('PKR ۰٫۰۰')).toBeTruthy();
});

it('keeps English receipt amounts on ASCII digits', () => {
  render(<CounterReceiptView {...props()} />);
  const region = screen.getByRole('region', { name: 'Receipt 12' });
  expect(within(region).getAllByText('1.00').length).toBeGreaterThan(0);
  expect(region.textContent).not.toMatch(/[۰-۹]/);
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
    region.getByText('Batch: <img src=x> · Expiry: 2027-01-01 · Tablets/units: 3')
  ).toBeTruthy();
  expect(region.getByText('Batch: بیچ ب · Expiry: 2028-02-02 · Tablets/units: 7')).toBeTruthy();
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
      region.getByText('بیچ: دستیاب نہیں · میعاد: دستیاب نہیں · گولیاں/یونٹس: 7')
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
  expect(screen.queryByRole('heading', { name: 'Payment recorded' })).toBeNull();
});

it('keeps Rx printing disabled when receipt has no sourced directions or licence', () => {
  render(<CounterReceiptView {...props()} />);
  expect(screen.getByRole('button', { name: /Print Rx labels/ })).toBeDisabled();
  expect(screen.getByText(/sourced Rx directions/)).toBeTruthy();
});

it.each([false, true])('opens isolated Rx labels with reprint=%s and exposes popup failure with retry available', (reprint) => {
  const input = props({ reprint });
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

it.each([
  ['en', '2 × 1.00 + 1 × 1.01', '3.01'],
  ['ur', '2 × ۱٫۰۰ + 1 × ۱٫۰۱', '۳٫۰۱'],
] as const)('shows exact mixed-lot pricing in the live %s receipt', (locale, pricing, total) => {
  const input = props({ locale });
  const line = input.receipt!.lines[0]!;
  input.receipt!.lines = [
    {
      ...line,
      quantity: 3,
      canonicalUnits: 3,
      unitPriceMinor: 100,
      lineTotalMinor: 301,
      allocations: [
        {
          allocationId: 'a',
          inventoryLotId: 'a',
          batchNumber: null,
          expiresAt: null,
          canonicalUnits: 2,
          grossMinor: 200,
        },
        {
          allocationId: 'b',
          inventoryLotId: 'b',
          batchNumber: null,
          expiresAt: null,
          canonicalUnits: 1,
          grossMinor: 101,
        },
      ],
    },
  ];
  render(<CounterReceiptView {...input} />);
  const item = screen.getAllByRole('listitem')[0]!;
  expect(item).toHaveTextContent(pricing);
  expect(item).toHaveTextContent(total);
  expect(item).not.toHaveTextContent('3 unit × 1.00');
});

it('states quantity and gross when historical per-lot pricing is unavailable', () => {
  const input = props();
  input.receipt!.lines[0] = {
    ...input.receipt!.lines[0]!,
    quantity: 3,
    canonicalUnits: 3,
    unitPriceMinor: 100,
    lineTotalMinor: 301,
  };
  render(<CounterReceiptView {...input} />);
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Qty: 3 unit · Gross: 3.01');
  expect(screen.getAllByRole('listitem')[0]).not.toHaveTextContent('3 unit × 1.00');
});


it.each([true, false])(
  'routes automatic printing through the copy allocation handler and reports success=%s once',
  async (printed) => {
    const reservation = { cancel: vi.fn() };
    const onPrint = vi.fn(async () => printed);
    const onSettlementPresented = vi.fn();
    const input = props({
      onPrint,
      onSettlementPresented,
      settlement: {
        status: 'confirmed', saleId: 'sale-1', receiptNumber: 12,
        autoPrint: true, printReservation: reservation,
      },
    });
    const view = render(<CounterReceiptView {...input} />);
    await waitFor(() =>
      expect(onSettlementPresented).toHaveBeenCalledExactlyOnceWith({
        saleId: 'sale-1', receiptNumber: 12,
        printStatus: printed ? 'dialog-requested' : 'manual-required',
      })
    );
    expect(onPrint).toHaveBeenCalledExactlyOnceWith(reservation);
    expect(reservation.cancel).not.toHaveBeenCalled();
    view.rerender(<CounterReceiptView {...input} />);
    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onSettlementPresented).toHaveBeenCalledTimes(1);
    expect(screen.getByText(printed
      ? 'Browser print dialog requested. Physical printing is not confirmed.'
      : 'The browser print dialog could not open. Retry Print receipt.'
    )).toBeInTheDocument();
  }
);

it('#708 shows the Sindh cash memo facts on the receipt preview, reprint included', () => {
  const input = props({ reprint: true });
  const receipt = input.receipt!;
  receipt.buyerName = 'Ayesha Khan';
  receipt.lines[0]!.identityStatus = 'ISSUED';
  receipt.lines[0]!.manufacturer = 'GSK Pakistan';
  receipt.taxIdentity = {
    ntn: null,
    strn: null,
    licenceNumber: 'DSL-SD-77',
    provinceCode: 'PK-SD',
    licenceValidFrom: '2026-01-01T00:00:00.000Z',
    licenceValidTo: '2027-12-31T00:00:00.000Z',
    pharmacistRegistration: 'PCP-9001',
  };
  render(<CounterReceiptView {...input} />);
  const preview = within(screen.getByRole('region', { name: 'Receipt 12' }));
  expect(preview.getByText('Sindh cash memo')).toBeTruthy();
  expect(
    preview.getByText('Drug-sale licence: DSL-SD-77 (valid 2026-01-01 to 2027-12-31)')
  ).toBeTruthy();
  expect(preview.getByText('Pharmacist registration: PCP-9001')).toBeTruthy();
  expect(preview.getByText('Buyer: Ayesha Khan')).toBeTruthy();
  expect(preview.getByText('Manufacturer: GSK Pakistan')).toBeTruthy();
  expect(preview.getByText('Signature of qualified person: ________________')).toBeTruthy();
});

it('#708 keeps a Punjab receipt preview free of cash memo facts', () => {
  const input = props();
  const receipt = input.receipt!;
  receipt.buyerName = 'Ayesha Khan';
  receipt.lines[0]!.identityStatus = 'ISSUED';
  receipt.lines[0]!.manufacturer = 'GSK Pakistan';
  receipt.taxIdentity = {
    ntn: null,
    strn: null,
    licenceNumber: 'DSL-PB-42',
    provinceCode: 'PK-PB',
  };
  render(<CounterReceiptView {...input} />);
  const preview = within(screen.getByRole('region', { name: 'Receipt 12' }));
  expect(preview.queryByText(/Cash memo/)).toBeNull();
  expect(preview.queryByText(/Ayesha Khan/)).toBeNull();
  expect(preview.queryByText(/GSK Pakistan/)).toBeNull();
  expect(preview.queryByText(/Signature of qualified person/)).toBeNull();
});
it('DEV-16: sends a WhatsApp receipt only after the cashier confirms the customer asked', async () => {
  const onSendWhatsApp = vi.fn(async () => ({
    ok: true,
    message: 'WhatsApp receipt queued. Delivery is not confirmed at the counter.',
  }));
  render(<CounterReceiptView {...props({ onSendWhatsApp })} />);

  const send = screen.getByRole('button', { name: 'Send WhatsApp receipt' });
  expect(send).toHaveProperty('disabled', true);
  expect(
    screen.getByText(/only the branch, receipt number, total, payment method and a secure link/i)
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('checkbox', { name: /customer asked for a whatsapp receipt/i }));
  await waitFor(() => expect(send).toHaveProperty('disabled', false));
  fireEvent.click(send);

  expect(onSendWhatsApp).toHaveBeenCalledExactlyOnceWith('sale-1');
  expect(await screen.findByText('WhatsApp receipt queued. Delivery is not confirmed at the counter.')).toBeTruthy();
});

it('DEV-16: surfaces a refused WhatsApp receipt and hides the control on an unsettled bill', async () => {
  const onSendWhatsApp = vi.fn(async () => ({
    ok: false,
    message: 'This customer has not opted in to WhatsApp messages.',
  }));
  const { unmount } = render(<CounterReceiptView {...props({ onSendWhatsApp })} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /customer asked for a whatsapp receipt/i }));
  const send = screen.getByRole('button', { name: 'Send WhatsApp receipt' });
  await waitFor(() => expect(send).toHaveProperty('disabled', false));
  fireEvent.click(send);
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This customer has not opted in to WhatsApp messages.'
  );
  unmount();

  const unsettled = props({ onSendWhatsApp });
  unsettled.receipt!.receiptNumber = null;
  render(<CounterReceiptView {...unsettled} />);
  expect(screen.queryByRole('button', { name: 'Send WhatsApp receipt' })).toBeNull();
});

it('#727: shows the issued promotion name and saving under its line', () => {
  const input = props();
  Object.assign(input.receipt!.lines[0]!, {
    discountMinor: 10,
    lineTotalMinor: 90,
    promotionName: 'Winter week',
  });
  Object.assign(input.receipt!.totals, { discountMinor: 10, netMinor: 90 });
  render(<CounterReceiptView {...input} />);
  expect(screen.getByText('Promotion: Winter week (-0.10)')).toBeTruthy();
});

it('previews the issue time and cashier in the on-screen header (DEF-15)', () => {
  const input = props();
  input.receipt = { ...input.receipt!, cashierName: 'Ayesha Khan' };
  render(<CounterReceiptView {...input} />);
  const header = screen.getByRole('heading', { level: 4 }).closest('header')!;
  expect(within(header).getByText(/Date:.*15:00/)).toBeTruthy();
  expect(within(header).getByText('Cashier: Ayesha Khan')).toBeTruthy();
});
