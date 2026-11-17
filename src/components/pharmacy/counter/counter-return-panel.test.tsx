import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CounterReturnPanel, parseReceiptNumber, ReturnForm } from './counter-return-panel';
const mocks = vi.hoisted(() => ({
  returnLine: vi.fn(),
  returnAndRefund: vi.fn(),
  refund: vi.fn(),
  refetch: vi.fn(),
  history: {} as Record<string, unknown>,
  lookup: {} as Record<string, unknown>,
  pharmacists: {} as Record<string, unknown>,
  refundAccess: {} as Record<string, unknown>,
  /** DEV-501: the server's price per returned base unit, by lot ('' = unidentified). */
  pricePerUnit: {} as Record<string, number>,
  quote: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      lookupReceiptByNumber: { useQuery: () => mocks.lookup },
      returnHistory: { useQuery: () => mocks.history },
      returnQuote: {
        useQuery: (input: unknown, options: { enabled?: boolean }) => mocks.quote(input, options),
      },
      counterReceipt: { useQuery: () => ({}) },
      returnLine: { useMutation: () => ({ mutateAsync: mocks.returnLine }) },
      returnAndRefund: { useMutation: () => ({ mutateAsync: mocks.returnAndRefund }) },
      refundTender: { useMutation: () => ({ mutateAsync: mocks.refund }) },
      refundAccess: { useQuery: () => mocks.refundAccess },
    },
    pharmacySafety: {
      controlledPharmacists: { useQuery: () => mocks.pharmacists },
    },
  },
}));
const base = {
  branchId: 'b',
  organizationId: 'o',
  accountId: 'a',
  deviceId: () => 'd',
  businessDate: () => new Date('2026-09-29'),
};
const props = { ...base, refundAuthorized: true };
function chooseReceipt() {
  fireEvent.click(screen.getByRole('button', { name: /Receipt 12/ }));
}
function enterManagerPin(pin = '2468') {
  fireEvent.change(screen.getByLabelText('Your manager or owner PIN'), { target: { value: pin } });
}
/** DEV-501: record the return without refunding it now. */
function recordOnly() {
  fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: 'none' } });
}
function chooseReturnReason(reason = 'Wrong item / strip') {
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Reason' })).getByRole('button', { name: reason })
  );
}
function chooseRefundReason(reason = 'Wrong item / strip') {
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Refund reason' })).getByRole('button', {
      name: reason,
    })
  );
}
function setLooseUnits(units: string) {
  fireEvent.change(screen.getByLabelText('Return quantity (strips)'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Plus loose units'), { target: { value: units } });
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.refetch.mockResolvedValue({});
  mocks.returnLine.mockResolvedValue({});
  mocks.returnAndRefund.mockResolvedValue({ refund: { amountMinor: 100 } });
  mocks.refund.mockResolvedValue({});
  mocks.pharmacists = { data: [{ id: 'staff-w', name: 'Witness Pharmacist' }] };
  mocks.refundAccess = { data: { authorized: true } };
  mocks.pricePerUnit = { '': 100 };
  mocks.quote.mockImplementation(
    (input: { lotId?: string; canonicalUnits: number }, options: { enabled?: boolean }) =>
      options.enabled
        ? {
            isSuccess: true,
            isFetching: false,
            data: {
              valueMinor:
                input.canonicalUnits *
                (mocks.pricePerUnit[input.lotId ?? ''] ?? mocks.pricePerUnit['']!),
            },
          }
        : { isSuccess: false, isFetching: false }
  );
  mocks.lookup = {
    isSuccess: true,
    data: [
      {
        id: 'sale',
        branchId: 'b',
        visibilityAnchor: { name: 'Main branch' },
        receiptNumber: 12,
        businessDate: new Date('2026-09-29'),
        receiptDeviceId: 'counter-bbd93263-ccd1',
        counterLabel: 'Counter CCD1',
      },
    ],
  };
  mocks.history = {
    refetch: mocks.refetch,
    data: {
      saleId: 'sale',
      lines: [
        {
          id: 'line',
          name: 'Medicine',
          quantity: 1,
          saleUnit: 'STRIP',
          canonicalUnits: 10,
          canonicalUnitsPerSaleUnit: 10,
          returnedUnits: 2,
          netMinor: 1000,
          returnedMinor: 200,
          lots: [
            { lotId: 'lot-a', batchNumber: 'A', returnableUnits: 3, restockAllowed: true },
            { lotId: 'lot-b', batchNumber: 'B', returnableUnits: 5, restockAllowed: false },
          ],
        },
      ],
      tenders: [
        { id: 'cash', type: 'CASH', amountMinor: 1000, refundedMinor: 100, refunds: [] },
        { id: 'card', type: 'CARD', amountMinor: 1000, refundedMinor: 0, refunds: [] },
      ],
      returns: [],
      locations: [{ id: 'q', name: 'Quarantine' }],
      refundableMinor: 500,
    },
  };
});
afterEach(() => vi.restoreAllMocks());
describe('DEV-732 explicit return choices', () => {
  function chooseReason() {
    chooseReturnReason('Damaged');
  }
  function keepAside() {
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside — don't resell/ }));
  }
  function expectCleared() {
    for (const group of ['Reason', 'What happens to the stock?']) {
      const buttons = screen.getByRole('group', { name: group }).querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  }

  it.each(['none', 'cash'])(
    'requires both explicit choices before confirming to %s',
    async (tender) => {
      render(<ReturnForm {...props} />);
      chooseReceipt();
      fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: tender } });
      const submit = screen.getByRole('button', {
        name:
          tender === 'none'
            ? /^Keep aside.*Record return$/
            : /^Keep aside.*Confirm return & refund$/,
      });
      expectCleared();
      expect(submit).toBeDisabled();
      // Submitting the form directly must not bypass the missing choices.
      fireEvent.submit(submit.closest('form')!);
      expect(mocks.returnLine).not.toHaveBeenCalled();
      expect(mocks.returnAndRefund).not.toHaveBeenCalled();
      chooseReason();
      expect(submit).toBeDisabled();
      fireEvent.submit(submit.closest('form')!);
      expect(mocks.returnLine).not.toHaveBeenCalled();
      expect(mocks.returnAndRefund).not.toHaveBeenCalled();
      // A stock action cannot bypass the missing PIN.
      keepAside();
      enterManagerPin();
      expect(submit).toBeEnabled();
      fireEvent.click(submit);
      await waitFor(() =>
        expect(tender === 'none' ? mocks.returnLine : mocks.returnAndRefund).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'DAMAGED',
            disposition: 'QUARANTINE',
            quarantineLocationId: 'q',
          })
        )
      );
      await screen.findByText(/Return recorded/);
      expectCleared();
      enterManagerPin();
      expect(submit).toBeDisabled();
    }
  );

  it('does not treat a stock choice alone as a reason', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    recordOnly();
    enterManagerPin();
    keepAside();
    const submit = screen.getByRole('button', { name: /^Keep aside.*Record return$/ });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(mocks.returnLine).not.toHaveBeenCalled();
    chooseReason();
    expect(submit).toBeEnabled();
  });

  it.each(['receipt', 'search', 'line', 'batch'])('clears both choices on a new %s', (change) => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReason();
    keepAside();
    if (change === 'receipt') chooseReceipt();
    if (change === 'search') {
      fireEvent.change(screen.getByLabelText('Receipt number'), { target: { value: '13' } });
      fireEvent.submit(screen.getByLabelText('Receipt number').closest('form')!);
    }
    if (change === 'line')
      fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    if (change === 'batch')
      fireEvent.change(screen.getByLabelText('Returned lot / batch'), {
        target: { value: 'lot-a' },
      });
    expectCleared();
    recordOnly();
    enterManagerPin();
    expect(screen.getByRole('button', { name: /^Keep aside.*Record return$/ })).toBeDisabled();
  });

  it('uses plain wording without silently choosing keep aside for an unknown or unsafe batch', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    expect(
      screen.getByRole('option', { name: "Can't tell which batch → keep aside (don't resell)" })
    ).toBeVisible();
    const restock = screen.getByRole('button', { name: /^Restock — back on the shelf for sale/ });
    expect(restock).toBeDisabled();
    expectCleared();
    fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-b' } });
    expect(restock).toBeDisabled();
    expect(
      screen.getByText('This batch cannot be restocked. Keep it aside for review.')
    ).toBeVisible();
    expectCleared();
    fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-a' } });
    expectCleared();
    chooseReason();
    recordOnly();
    enterManagerPin();
    expect(restock).toBeEnabled();
  });

  it('requires a stock-button confirmation even when every other prerequisite is ready', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    recordOnly();
    chooseReason();
    enterManagerPin();
    const keep = screen.getByRole('button', { name: /^Keep aside.*Record return$/ });
    expect(keep).toBeEnabled();
    expect(keep).toHaveAttribute('type', 'button');
    expect(screen.queryByRole('button', { name: 'Record return' })).not.toBeInTheDocument();
    expectClearedStock();
    fireEvent.submit(keep.closest('form')!);
    expect(mocks.returnLine).not.toHaveBeenCalled();
    expect(mocks.returnAndRefund).not.toHaveBeenCalled();
    fireEvent.click(keep);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          reason: 'DAMAGED',
          disposition: 'QUARANTINE',
          quarantineLocationId: 'q',
          managerPin: '2468',
        })
      )
    );
    await screen.findByText(/Return recorded/);
  });

  function expectClearedStock() {
    expect(
      screen.getByRole('group', { name: 'What happens to the stock?' }).querySelectorAll('button')
    ).toHaveLength(2);
    for (const button of screen
      .getByRole('group', { name: 'What happens to the stock?' })
      .querySelectorAll('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  }

  it.each(['', 'lot-b'])(
    'refuses unsafe restock of batch %s with all other prerequisites met',
    async (lot) => {
      render(<ReturnForm {...props} />);
      chooseReceipt();
      fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: lot } });
      recordOnly();
      chooseReason();
      enterManagerPin();
      const restock = screen.getByRole('button', { name: /^Restock.*Record return$/ });
      const keep = screen.getByRole('button', { name: /^Keep aside.*Record return$/ });
      expect(restock).toBeDisabled();
      expect(keep).toBeEnabled();
      fireEvent.click(restock);
      expect(mocks.returnLine).not.toHaveBeenCalled();
      expectClearedStock();
      fireEvent.click(keep);
      await waitFor(() =>
        expect(mocks.returnLine).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            lotId: lot || undefined,
            reason: 'DAMAGED',
            disposition: 'QUARANTINE',
          })
        )
      );
      await screen.findByText(/Return recorded/);
    }
  );

  it('requires a custody location for Keep aside while allowing a verified restock', async () => {
    const history = mocks.history as { data: { locations: unknown[] } };
    history.data.locations = [];
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-a' } });
    recordOnly();
    chooseReason();
    enterManagerPin();
    const restock = screen.getByRole('button', { name: /^Restock.*Record return$/ });
    expect(screen.getByRole('button', { name: /^Keep aside.*Record return$/ })).toBeDisabled();
    expect(restock).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('No keep-aside (quarantine) location');
    fireEvent.click(restock);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          lotId: 'lot-a',
          reason: 'DAMAGED',
          disposition: 'RESTOCK',
          quarantineLocationId: undefined,
        })
      )
    );
    await screen.findByText(/Return recorded/);
  });

  it('requires a fresh refund reason after a return clears its choices', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    recordOnly();
    chooseReason();
    keepAside();
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Record return$/ }));
    await screen.findByText(/Return recorded/);
    expectCleared();
    // The refund form never inherits the return's reason; it must be chosen.
    expect(screen.getByRole('button', { name: 'Confirm refund' })).toBeDisabled();
    for (const button of screen
      .getByRole('group', { name: 'Refund reason' })
      .querySelectorAll('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    chooseRefundReason('Damaged');
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await waitFor(() =>
      expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ reason: 'DAMAGED' }))
    );
  });
});

describe('DEV-732 refund reason does not leak across receipts', () => {
  it('clears the refund reason when another receipt is chosen', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason('Damaged');
    expect(
      within(screen.getByRole('group', { name: 'Refund reason' })).getByRole('button', {
        name: 'Damaged',
      })
    ).toHaveAttribute('aria-pressed', 'true');
    chooseReceipt();
    for (const button of screen
      .getByRole('group', { name: 'Refund reason' })
      .querySelectorAll('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });
});

describe('counter returns', () => {
  it('shows lookup loading and no-match states', () => {
    mocks.lookup = { isFetching: true };
    mocks.history = {};
    const view = render(<ReturnForm {...props} />);
    fireEvent.change(screen.getByLabelText('Receipt number'), { target: { value: '999' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Find receipt' }).closest('form')!);
    expect(screen.getByRole('status')).toHaveTextContent('Looking up receipt');
    mocks.lookup = { isSuccess: true, data: [] };
    view.rerender(<ReturnForm {...props} />);
    expect(screen.getByText('Receipt not found')).toBeVisible();
    expect(screen.queryByText(/outside your scope/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry lookup' })).not.toBeInTheDocument();
  });
  it('accepts the printed receipt format and shows a format hint', () => {
    mocks.lookup = {};
    mocks.history = {};
    render(<ReturnForm {...props} />);
    const field = screen.getByLabelText('Receipt number');
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAccessibleDescription(/for example 1042 or QA-1042/);
    fireEvent.change(field, { target: { value: 'QA-0000' } });
    expect(field).toHaveValue('QA-0000');
    expect(screen.getByRole('button', { name: 'Find receipt' })).toBeEnabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Find receipt' }).closest('form')!);
    expect(screen.getByText('Receipt not found')).toBeVisible();
  });
  it('explains a negative receipt number inline and marks the field invalid', () => {
    mocks.lookup = {};
    mocks.history = {};
    render(<ReturnForm {...props} />);
    const field = screen.getByLabelText('Receipt number');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    fireEvent.change(field, { target: { value: '-5' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Find receipt' }).closest('form')!);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/Negative numbers and zero are not receipt numbers/);
    expect(screen.getByText(/made of digits/)).toBeVisible();
    fireEvent.change(field, { target: { value: '5' } });
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });
  it('does not redisplay cached receipts after an invalid search is edited', () => {
    render(<ReturnForm {...props} />);
    const field = screen.getByLabelText('Receipt number');
    const form = screen.getByRole('button', { name: 'Find receipt' }).closest('form')!;
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.submit(form);
    expect(screen.getByRole('button', { name: /Receipt 12/ })).toBeVisible();
    fireEvent.change(field, { target: { value: '-5' } });
    fireEvent.submit(form);
    expect(screen.queryByRole('button', { name: /Receipt 12/ })).toBeNull();
    fireEvent.change(field, { target: { value: '-6' } });
    expect(screen.queryByRole('button', { name: /Receipt 12/ })).toBeNull();
    expect(screen.queryByText('Receipt not found')).toBeNull();
  });
  it('reads the receipt sequence from printed references', () => {
    expect(parseReceiptNumber('1042')).toBe(1042);
    expect(parseReceiptNumber(' QA-1042 ')).toBe(1042);
    expect(parseReceiptNumber('Receipt 99999')).toBe(99999);
    expect(parseReceiptNumber('receipt:7')).toBe(7);
    expect(parseReceiptNumber('QA-0000')).toBeNull();
    expect(parseReceiptNumber('QA-')).toBeNull();
    expect(parseReceiptNumber('12;DROP')).toBeNull();
  });
  it('identifies another assigned branch without booking its return at this counter', () => {
    mocks.lookup = {
      isSuccess: true,
      data: [
        {
          id: 'sale-b2',
          branchId: 'b2',
          visibilityAnchor: { name: 'Second branch' },
          receiptNumber: 12,
          businessDate: new Date('2026-09-29'),
          receiptDeviceId: 'd2',
        },
      ],
    };
    mocks.history = {};
    render(<ReturnForm {...props} />);
    const match = screen.getByRole('button', { name: /Receipt 12.*Second branch/ });
    expect(match).not.toHaveTextContent('d2');
    expect(match).toBeVisible();
    expect(match).toBeDisabled();
    expect(match).toHaveTextContent('Switch to this branch to record a return.');
    expect(
      screen.queryByRole('button', { name: /^Keep aside.*Record return$/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm refund' })).not.toBeInTheDocument();
    expect(mocks.returnLine).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
  it('labels the line with the pack level sold and hides internal lot ids (DEV-638)', () => {
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines[0] = {
      ...history.data.lines[0],
      saleUnit: 'PACK',
      levelLabel: 'STRIP',
      lots: [
        {
          lotId: 'cmvzl8u3u01pq4oqrosqy5nsi',
          batchNumber: 'QA-B2',
          expiresAt: new Date('2027-05-31T00:00:00Z'),
          returnableUnits: 8,
          restockAllowed: true,
        },
      ],
    };
    render(<ReturnForm {...props} />);
    chooseReceipt();
    const line = screen.getByRole('option', { name: /Medicine/ });
    expect(line).toHaveTextContent('Medicine · 1 strip of 10 · 8 units returnable');
    expect(line).not.toHaveTextContent(/box/i);
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    expect(screen.getByText(/One sold strip contains 10 base units/)).toBeVisible();
    expect(screen.queryByText(/box/i)).not.toBeInTheDocument();
    const lot = screen.getByRole('option', { name: /QA-B2/ });
    expect(lot).toHaveTextContent('Batch QA-B2 · expires 2027-05-31 · 8 units remaining');
    expect(lot).not.toHaveTextContent('cmvzl8u3u01pq4oqrosqy5nsi');
    expect(lot).toHaveValue('cmvzl8u3u01pq4oqrosqy5nsi');
  });
  it('lists a no-expiry lot as "No expiry", never 9998-12-31 (QA-3)', () => {
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines[0] = {
      ...history.data.lines[0],
      lots: [
        {
          lotId: 'lot-retail',
          batchNumber: 'RETAIL-NOEXP',
          // The storage marker for a non-drug item stocked without an expiry.
          expiresAt: new Date('9998-12-31T19:00:00.000Z'),
          returnableUnits: 3,
          restockAllowed: true,
        },
      ],
    };
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    const lot = screen.getByRole('option', { name: /RETAIL-NOEXP/ });
    expect(lot).toHaveTextContent('Batch RETAIL-NOEXP · No expiry · 3 units remaining');
    expect(lot.textContent).not.toContain('9998');
  });
  it('books the return and the refund to the active branch', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    chooseReturnReason();
    fireEvent.change(screen.getByLabelText('Keep-aside (quarantine) location'), {
      target: { value: 'q' },
    });
    fireEvent.change(screen.getByLabelText('Inspection and integrity decision (optional)'), {
      target: { value: 'seal unknown' },
    });
    fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: 'cash' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
    await waitFor(() =>
      expect(mocks.returnAndRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'b',
          integrityDecision: 'seal unknown',
          managerPin: '2468',
          refund: expect.objectContaining({ originalTenderId: 'cash', deviceId: 'd' }),
        })
      )
    );
  });
  it('books a record-only return to the active branch', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    chooseReturnReason();
    fireEvent.change(screen.getByLabelText('Keep-aside (quarantine) location'), {
      target: { value: 'q' },
    });
    recordOnly();
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Record return$/ }));
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'b', managerPin: '2468' })
      )
    );
  });
  it('sends the cash refund to the active branch drawer', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await waitFor(() =>
      expect(mocks.refund).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'b', managerPin: '2468' })
      )
    );
  });
  it('explains lookup permission errors and offers retry', () => {
    mocks.lookup = {
      isError: true,
      error: new Error('You do not have access to this branch.'),
      refetch: mocks.refetch,
    };
    mocks.history = {};
    render(<ReturnForm {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have access');
    fireEvent.click(screen.getByRole('button', { name: 'Retry lookup' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
  it('does not retain a previous lookup error for an unparseable receipt', () => {
    mocks.lookup = {
      isError: true,
      error: new Error('Connection failed'),
      refetch: mocks.refetch,
    };
    mocks.history = {};
    render(<ReturnForm {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Connection failed');
    fireEvent.change(screen.getByLabelText('Receipt number'), { target: { value: 'QA-0000' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Find receipt' }).closest('form')!);
    expect(screen.getByText('Receipt not found')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry lookup' })).not.toBeInTheDocument();
  });
  it('disables mutations offline and for stale history', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<ReturnForm {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Offline');
    expect(screen.getByRole('button', { name: 'Find receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm refund' })).toBeDisabled();
  });
  it('requires a line, a valid quantity and the PIN before posting a return', async () => {
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines.push({ ...history.data.lines[0], id: 'line-2', name: 'Other medicine' });
    render(<ReturnForm {...props} />);
    chooseReceipt();
    recordOnly();
    const submit = screen.getByRole('button', { name: /^Keep aside.*Record return$/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    chooseReturnReason();
    enterManagerPin();
    // 1 strip (10 base units) exceeds the 8 still returnable.
    fireEvent.change(screen.getByLabelText('Return quantity (strips)'), {
      target: { value: '1' },
    });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Enter between 1 and 8 base units/)).toBeVisible();
    setLooseUnits('0');
    expect(submit).toBeDisabled();
    setLooseUnits('1');
    expect(submit).toBeEnabled();
    enterManagerPin('');
    expect(submit).toBeDisabled();
    enterManagerPin();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith(
        expect.objectContaining({
          saleLineId: 'line',
          disposition: 'QUARANTINE',
          canonicalUnits: 1,
          quarantineLocationId: 'q',
          // An empty inspection note records the counter inspection with the reason.
          integrityDecision: 'Inspected at the counter: Wrong item / strip',
        })
      )
    );
    expect(mocks.returnAndRefund).not.toHaveBeenCalled();
    await screen.findByText(/Return recorded/);
  });
  it('caps refunds at returned value and requires explicit cash fallback for card', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'card' } });
    enterManagerPin();
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '6.00' } });
    const submit = screen.getByRole('button', { name: 'Confirm refund' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '5.00' } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/No provider refund adapter/));
    expect(submit).toBeEnabled();
  });
  it.each([false, true])(
    'restores an ambiguous refund (legacy=%s) with the same payload',
    async (legacy) => {
      mocks.refund.mockRejectedValueOnce(new Error('Disconnected'));
      const view = render(<ReturnForm {...props} />);
      chooseReceipt();
      chooseRefundReason();
      fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
      fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
      enterManagerPin();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
      await screen.findByRole('button', { name: 'Retry saved refund' });
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Disconnected'));
      const first = mocks.refund.mock.calls[0][0];
      expect(first).not.toHaveProperty('requireReturnedValue');
      if (legacy) {
        const key = 'pharmacy-return:o:a:b';
        const saved = JSON.parse(localStorage.getItem(key)!);
        saved.input.requireReturnedValue = true;
        localStorage.setItem(key, JSON.stringify(saved));
        first.requireReturnedValue = true;
      }
      view.unmount();
      render(<ReturnForm {...props} />);
      const retry = await screen.findByRole('button', { name: 'Retry saved refund' });
      expect(retry).toBeDisabled();
      enterManagerPin();
      fireEvent.click(retry);
      await waitFor(() => expect(mocks.refund).toHaveBeenCalledTimes(2));
      expect(mocks.refund.mock.calls[1][0]).toEqual(first);
    }
  );
  it('fails closed when saved recovery belongs to another branch', async () => {
    mocks.refund.mockRejectedValueOnce(new Error('Disconnected'));
    const view = render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await screen.findByRole('button', { name: 'Retry saved refund' });
    const key = 'pharmacy-return:o:a:b';
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.input.branchId = 'b2';
    localStorage.setItem(key, JSON.stringify(saved));
    view.unmount();
    render(<ReturnForm {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('recovery is unavailable');
    expect(screen.queryByRole('button', { name: 'Retry saved refund' })).not.toBeInTheDocument();
  });
  it('fails closed when saved recovery is corrupt', () => {
    localStorage.setItem('pharmacy-return:o:a:b', 'broken');
    render(<ReturnForm {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('recovery is unavailable');
    expect(screen.getByRole('button', { name: 'Find receipt' })).toBeDisabled();
  });
});

it('offers sold lots, prevents unsafe restock and caps the selected lot', async () => {
  render(<ReturnForm {...props} />);
  chooseReceipt();
  fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
  const restock = screen.getByRole('button', { name: /^Restock — back on the shelf for sale/ });
  expect(restock).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-b' } });
  expect(restock).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-a' } });
  chooseReturnReason('Wrong item / strip');
  enterManagerPin();
  fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: 'cash' } });
  expect(restock).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('Inspection and integrity decision (optional)'), {
    target: { value: 'Physical batch A verified, intact' },
  });
  recordOnly();
  enterManagerPin();
  setLooseUnits('4');
  expect(screen.getByRole('button', { name: /^Restock.*Record return$/ })).toBeDisabled();
  setLooseUnits('3');
  fireEvent.click(screen.getByRole('button', { name: /^Restock.*Record return$/ }));
  await waitFor(() =>
    expect(mocks.returnLine).toHaveBeenCalledWith(
      expect.objectContaining({ lotId: 'lot-a', canonicalUnits: 3, disposition: 'RESTOCK' })
    )
  );
});

describe('controlled medicine returns', () => {
  const key = 'pharmacy-return:o:a:b';
  function controlledHistory() {
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines[0].controlled = true;
  }
  function fillControlledReturn(refundTo = 'none') {
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    chooseReturnReason();
    fireEvent.change(screen.getByLabelText('Keep-aside (quarantine) location'), {
      target: { value: 'q' },
    });
    fireEvent.change(screen.getByLabelText('Inspection and integrity decision (optional)'), {
      target: { value: 'sealed' },
    });
    fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: refundTo } });
    enterManagerPin();
  }

  it('does not ask for a witness on a non-controlled line', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    expect(screen.queryByLabelText('Witness PIN')).toBeNull();
  });

  it('requires a fresh witness PIN and sends it without persisting it', async () => {
    controlledHistory();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<ReturnForm {...props} />);
    fillControlledReturn();
    const submit = screen.getByRole('button', { name: /^Keep aside.*Record return$/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Witnessing pharmacist'), {
      target: { value: 'staff-w' },
    });
    fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '12' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '4826' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith(
        expect.objectContaining({
          saleLineId: 'line',
          controlledWitness: { staffProfileId: 'staff-w', pin: '4826' },
          managerPin: '2468',
        })
      )
    );
    await screen.findByText(/Return recorded/);
    for (const [, value] of setItem.mock.calls) {
      expect(value).not.toContain('4826');
      expect(value).not.toContain('controlledWitness');
      expect(value).not.toContain('2468');
      expect(value).not.toContain('managerPin');
    }
    expect(screen.getByLabelText('Witness PIN')).toHaveValue('');
    expect(screen.getByLabelText('Your manager or owner PIN')).toHaveValue('');
  });

  it('reports a blocked controlled return as a failure, not success', async () => {
    controlledHistory();
    mocks.returnLine.mockResolvedValueOnce({
      blocked: 'A different pharmacist must enter a fresh witness PIN.',
    });
    render(<ReturnForm {...props} />);
    fillControlledReturn();
    fireEvent.change(screen.getByLabelText('Witnessing pharmacist'), {
      target: { value: 'staff-w' },
    });
    fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Record return$/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Return not recorded. A different pharmacist must enter a fresh witness PIN.'
      )
    );
    expect(screen.queryByText(/Return recorded/)).toBeNull();
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry saved/ })).toBeNull();
    expect(screen.getByLabelText('Witness PIN')).toHaveValue('');
  });

  it('keeps a saved controlled return for reconciliation when its retry is blocked', async () => {
    controlledHistory();
    const saved = {
      kind: 'return',
      saleId: 'sale',
      input: {
        branchId: 'b',
        saleLineId: 'line',
        canonicalUnits: 1,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'q',
        reason: 'WRONG_ITEM',
        integrityDecision: 'sealed',
        idempotencyKey: 'saved-key',
      },
    };
    localStorage.setItem(key, JSON.stringify(saved));
    mocks.returnLine.mockResolvedValueOnce({
      blocked: 'A different pharmacist must enter a fresh witness PIN.',
    });
    render(<ReturnForm {...props} />);
    const retry = screen.getByRole('button', { name: 'Retry saved return' });
    expect(retry).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Witnessing pharmacist'), {
      target: { value: 'staff-w' },
    });
    fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '1111' } });
    expect(retry).toBeDisabled();
    enterManagerPin();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith({
        ...saved.input,
        controlledWitness: { staffProfileId: 'staff-w', pin: '1111' },
        managerPin: '2468',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('retry the saved return')
    );
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
    expect(screen.getByRole('button', { name: 'Retry saved return' })).toBeDisabled();
  });
});
describe('DEV-647 refund access', () => {
  it('hides the return and refund steps from a cashier (DEV-621)', () => {
    render(<ReturnForm {...props} refundAuthorized={false} />);
    chooseReceipt();
    expect(
      screen.queryByRole('button', { name: /^Keep aside.*Record return$/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sold line')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm refund' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Original tender')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your manager or owner PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/Returns and refunds need a manager or owner/)).toBeVisible();
    expect(mocks.returnLine).not.toHaveBeenCalled();
  });
  it('keeps a saved return for a manager when the user has no refund access (DEV-621)', () => {
    const saved = {
      kind: 'return',
      saleId: 'sale',
      input: {
        branchId: 'b',
        saleLineId: 'line',
        canonicalUnits: 1,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'q',
        reason: 'WRONG_ITEM',
        integrityDecision: 'sealed',
        idempotencyKey: 'saved-key',
      },
    };
    localStorage.setItem('pharmacy-return:o:a:b', JSON.stringify(saved));
    render(<ReturnForm {...base} />);
    expect(screen.getByRole('button', { name: 'Retry saved return' })).toBeDisabled();
    expect(screen.queryByLabelText('Your manager or owner PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/This saved return is kept for reconciliation/)).toBeVisible();
    expect(mocks.returnLine).not.toHaveBeenCalled();
  });
  it('fails closed to the cashier view when refund access is not granted', () => {
    render(<ReturnForm {...base} />);
    chooseReceipt();
    expect(screen.queryByRole('button', { name: 'Confirm refund' })).not.toBeInTheDocument();
  });
  it.each([
    [{ data: { authorized: false } }, 'Returns'],
    [{ isLoading: true }, 'Returns'],
    [{ isError: true }, 'Returns'],
    [{ data: { authorized: true } }, 'Returns & refunds'],
  ])('labels the counter entry from refund access %#', (access, label) => {
    mocks.refundAccess = access;
    render(<CounterReturnPanel {...base} />);
    expect(screen.getByRole('button', { name: label })).toBeVisible();
    if (label === 'Returns')
      expect(screen.queryByRole('button', { name: /refunds/ })).not.toBeInTheDocument();
  });
  it('needs the manager PIN and never saves it with the attempt', async () => {
    let saved = '';
    mocks.refund.mockImplementationOnce(async () => {
      saved = localStorage.getItem('pharmacy-return:o:a:b') ?? '';
      return {};
    });
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    const submit = screen.getByRole('button', { name: 'Confirm refund' });
    expect(submit).toBeDisabled();
    enterManagerPin('12');
    expect(submit).toBeDisabled();
    enterManagerPin('9753');
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.refund).toHaveBeenCalledOnce());
    expect(saved).toContain('"kind":"refund"');
    expect(saved).not.toContain('9753');
    expect(screen.getByLabelText('Your manager or owner PIN')).toHaveValue('');
  });
  it('keeps a saved refund for a manager when the user has no refund access', async () => {
    mocks.refund.mockRejectedValueOnce(new Error('Disconnected'));
    const view = render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await screen.findByRole('button', { name: 'Retry saved refund' });
    const saved = localStorage.getItem('pharmacy-return:o:a:b');
    view.unmount();
    render(<ReturnForm {...base} />);
    expect(screen.getByRole('button', { name: 'Retry saved refund' })).toBeDisabled();
    expect(screen.queryByLabelText('Your manager or owner PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/A manager or owner must retry it/)).toBeVisible();
    expect(localStorage.getItem('pharmacy-return:o:a:b')).toBe(saved);
    expect(mocks.refund).toHaveBeenCalledOnce();
  });
  it('reports a refused PIN without keeping a fresh attempt', async () => {
    mocks.refund.mockResolvedValueOnce({
      blocked: 'Refund not recorded. Enter your manager or owner PIN.',
    });
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseRefundReason();
    fireEvent.change(screen.getByLabelText('Original tender'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Refund amount (PKR)'), { target: { value: '2.00' } });
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Enter your manager or owner PIN')
    );
    expect(localStorage.getItem('pharmacy-return:o:a:b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry saved refund' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Refund recorded/)).not.toBeInTheDocument();
  });
});

describe('DEV-501 returns in six steps or fewer', () => {
  const key = 'pharmacy-return:o:a:b';
  /** A one-line receipt paid with one cash tender: 2 strips of 10 at PKR 12.00 each. */
  function singleLineReceipt() {
    mocks.history = {
      refetch: mocks.refetch,
      data: {
        saleId: 'sale',
        lines: [
          {
            id: 'line',
            name: 'Medicine',
            quantity: 2,
            saleUnit: 'STRIP',
            levelLabel: 'STRIP',
            canonicalUnits: 20,
            canonicalUnitsPerSaleUnit: 10,
            returnedUnits: 0,
            netMinor: 2400,
            returnedMinor: 0,
            lots: [{ lotId: 'lot-a', batchNumber: 'A', returnableUnits: 20, restockAllowed: true }],
          },
        ],
        tenders: [{ id: 'cash', type: 'CASH', amountMinor: 2400, refundedMinor: 0, refunds: [] }],
        returns: [],
        locations: [{ id: 'q', name: 'Quarantine' }],
        refundableMinor: 0,
      },
    };
    mocks.pricePerUnit = { '': 120 };
  }

  it('prefills the refund from the selected lot as the server prices it', () => {
    singleLineReceipt();
    const history = mocks.history as { data: { lines: Array<{ lots: unknown[] }> } };
    history.data.lines[0].lots.push({
      lotId: 'lot-b',
      batchNumber: 'B',
      returnableUnits: 20,
      restockAllowed: true,
    });
    // The two batches were sold at different prices.
    mocks.pricePerUnit = { '': 120, 'lot-a': 90, 'lot-b': 150 };
    render(<ReturnForm {...props} />);
    chooseReceipt();
    const amount = screen.getByLabelText('Refund for this return (PKR)');
    expect(amount).toHaveValue('12.00');
    fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-b' } });
    expect(mocks.quote).toHaveBeenLastCalledWith(
      { branchId: 'b', saleLineId: 'line', lotId: 'lot-b', canonicalUnits: 10 },
      expect.objectContaining({ enabled: true })
    );
    expect(amount).toHaveValue('15.00');
    fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-a' } });
    expect(amount).toHaveValue('9.00');
  });

  it('waits for the server price before the refund can be confirmed', () => {
    singleLineReceipt();
    mocks.quote.mockImplementation(() => ({ isSuccess: false, isFetching: true }));
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    expect(screen.getByLabelText('Refund for this return (PKR)')).toHaveValue('');
    expect(screen.getByText('Pricing the returned quantity…')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ })
    ).toBeDisabled();
    // Recording the return only needs no price.
    recordOnly();
    expect(screen.getByRole('button', { name: /^Keep aside.*Record return$/ })).toBeEnabled();
  });

  it('explains a pricing failure and offers to reprice', () => {
    singleLineReceipt();
    const refetch = vi.fn();
    mocks.quote.mockImplementation(() => ({
      isError: true,
      error: new Error('Connection failed'),
      refetch,
    }));
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    expect(screen.getByText(/Connection failed The refund cannot be priced yet/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reprice refund' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(mocks.returnAndRefund).not.toHaveBeenCalled();
  });

  it('completes a one-line return and refund in six steps with one confirm', async () => {
    singleLineReceipt();
    let steps = 0;
    const step = (action: () => void) => {
      steps += 1;
      action();
    };
    render(<CounterReturnPanel {...base} />);
    // 1. Open returns.
    step(() => fireEvent.click(screen.getByRole('button', { name: 'Returns & refunds' })));
    // 2. Scan or type the receipt; a single match in this branch opens it, and its only
    //    returnable line and only tender are selected.
    step(() => {
      fireEvent.change(screen.getByLabelText('Receipt number'), { target: { value: 'QA-12' } });
      fireEvent.submit(screen.getByLabelText('Receipt number').closest('form')!);
    });
    expect(screen.getByRole('button', { name: /Receipt 12/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByLabelText('Sold line')).toHaveValue('line');
    expect(screen.getByLabelText('Refund to')).toHaveValue('cash');
    // 3. Quantity in the unit it was sold in.
    step(() =>
      fireEvent.change(screen.getByLabelText('Return quantity (strips)'), {
        target: { value: '2' },
      })
    );
    // The refund is prefilled from the line: 2 strips = PKR 24.00.
    expect(screen.getByLabelText('Refund for this return (PKR)')).toHaveValue('24.00');
    // 4. Reason.
    step(() => chooseReturnReason('Damaged'));
    // 5. Manager or owner PIN.
    step(() => enterManagerPin());
    // 6. Explicitly choose Keep aside and confirm the return and refund in one action.
    step(() =>
      fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }))
    );
    expect(steps).toBeLessThanOrEqual(6);
    await waitFor(() => expect(mocks.returnAndRefund).toHaveBeenCalledOnce());
    const sent = mocks.returnAndRefund.mock.calls[0][0];
    expect(sent).toMatchObject({
      branchId: 'b',
      saleLineId: 'line',
      canonicalUnits: 20,
      disposition: 'QUARANTINE',
      quarantineLocationId: 'q',
      reason: 'DAMAGED',
      integrityDecision: 'Inspected at the counter: Damaged',
      managerPin: '2468',
      refund: {
        originalTenderId: 'cash',
        deviceId: 'd',
        businessDate: new Date('2026-09-29'),
        manualCashFallback: false,
      },
    });
    // The untouched prefill refunds the return's exact value, priced by the server.
    expect(sent.refund.amountMinor).toBeUndefined();
    expect(mocks.returnLine).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
    await screen.findByText(/Return recorded and refunded: PKR 1.00/);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('enters quantity in the sold unit plus loose units', async () => {
    singleLineReceipt();
    render(<ReturnForm {...props} />);
    chooseReceipt();
    expect(screen.getByLabelText('Return quantity (strips)')).toHaveValue(1);
    expect(screen.getByLabelText('Plus loose units')).toHaveValue(0);
    expect(screen.getByText(/Returning 10 base units \(1 strip\)/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Plus loose units'), { target: { value: '5' } });
    expect(screen.getByText(/Returning 15 base units \(1 strip \+ 5 loose\)/)).toBeVisible();
    expect(screen.getByLabelText('Refund for this return (PKR)')).toHaveValue('18.00');
    fireEvent.change(screen.getByLabelText('Return quantity (strips)'), {
      target: { value: '3' },
    });
    chooseReturnReason();
    enterManagerPin();
    expect(
      screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ })
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Return quantity (strips)'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
    await waitFor(() =>
      expect(mocks.returnAndRefund).toHaveBeenCalledWith(
        expect.objectContaining({ canonicalUnits: 15 })
      )
    );
  });

  it('labels a unit sale in units without a loose field', () => {
    singleLineReceipt();
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines[0] = {
      ...history.data.lines[0],
      saleUnit: 'UNIT',
      levelLabel: null,
      canonicalUnitsPerSaleUnit: 1,
    };
    render(<ReturnForm {...props} />);
    chooseReceipt();
    expect(screen.getByLabelText('Return quantity (units)')).toHaveValue(1);
    expect(screen.queryByLabelText('Plus loose units')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Refund for this return (PKR)')).toHaveValue('1.20');
  });

  it('lets the refund be lowered but never raised above the returned value', async () => {
    singleLineReceipt();
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    const amount = screen.getByLabelText('Refund for this return (PKR)');
    const submit = screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ });
    expect(amount).toHaveValue('12.00');
    expect(screen.getByText(/You can lower it, up to PKR 12.00/)).toBeVisible();
    fireEvent.change(amount, { target: { value: '12.01' } });
    expect(submit).toBeDisabled();
    fireEvent.change(amount, { target: { value: '0' } });
    expect(submit).toBeDisabled();
    fireEvent.change(amount, { target: { value: 'abc' } });
    expect(submit).toBeDisabled();
    fireEvent.change(amount, { target: { value: '10.50' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnAndRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          refund: expect.objectContaining({ originalTenderId: 'cash', amountMinor: 1050 }),
        })
      )
    );
  });

  it('bounds the prefill by what the tender has left and sends it explicitly', async () => {
    singleLineReceipt();
    const history = mocks.history as { data: { tenders: Array<Record<string, unknown>> } };
    history.data.tenders = [
      { id: 'cash', type: 'CASH', amountMinor: 800, refundedMinor: 0, refunds: [] },
      { id: 'card', type: 'CARD', amountMinor: 1600, refundedMinor: 0, refunds: [] },
    ];
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    // A mixed payment needs its tender chosen.
    const submit = screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ });
    expect(screen.getByLabelText('Refund to')).toHaveValue('');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Refund to'), { target: { value: 'cash' } });
    expect(screen.getByLabelText('Refund for this return (PKR)')).toHaveValue('8.00');
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnAndRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          refund: expect.objectContaining({ originalTenderId: 'cash', amountMinor: 800 }),
        })
      )
    );
  });

  it('requires the explicit cash fallback for a card refund', () => {
    singleLineReceipt();
    const history = mocks.history as { data: { tenders: Array<Record<string, unknown>> } };
    history.data.tenders = [
      { id: 'card', type: 'CARD', amountMinor: 2400, refundedMinor: 0, refunds: [] },
    ];
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    const submit = screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/No provider refund adapter/));
    expect(submit).toBeEnabled();
  });

  it('keeps cashiers out of the combined return and refund', () => {
    singleLineReceipt();
    render(<ReturnForm {...props} refundAuthorized={false} />);
    chooseReceipt();
    expect(
      screen.queryByRole('button', { name: /^Keep aside.*Confirm return & refund$/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Refund to')).not.toBeInTheDocument();
    expect(mocks.returnAndRefund).not.toHaveBeenCalled();
  });

  it('reports a refused PIN without recording or keeping a fresh attempt', async () => {
    singleLineReceipt();
    mocks.returnAndRefund.mockResolvedValueOnce({ blocked: 'Enter your manager or owner PIN.' });
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Return not recorded. Enter your manager or owner PIN.'
      )
    );
    expect(localStorage.getItem(key)).toBeNull();
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/Return recorded/)).not.toBeInTheDocument();
  });

  it('restores an ambiguous return and refund with the same payload and no PIN', async () => {
    singleLineReceipt();
    mocks.returnAndRefund.mockRejectedValueOnce(new Error('Disconnected'));
    const view = render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin('9753');
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
    await screen.findByRole('button', { name: 'Retry saved return and refund' });
    const first = mocks.returnAndRefund.mock.calls[0][0];
    const saved = localStorage.getItem(key)!;
    expect(saved).toContain('"kind":"returnRefund"');
    expect(saved).not.toContain('9753');
    expect(saved).not.toContain('managerPin');
    view.unmount();
    render(<ReturnForm {...props} />);
    const retry = await screen.findByRole('button', { name: 'Retry saved return and refund' });
    expect(retry).toBeDisabled();
    enterManagerPin('9753');
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.returnAndRefund).toHaveBeenCalledTimes(2));
    expect(mocks.returnAndRefund.mock.calls[1][0]).toEqual(first);
    expect(mocks.returnAndRefund.mock.calls[1][0].idempotencyKey).toBe(first.idempotencyKey);
  });

  it('keeps a saved return and refund for a manager when the user has no refund access', async () => {
    singleLineReceipt();
    mocks.returnAndRefund.mockRejectedValueOnce(new Error('Disconnected'));
    const view = render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
    await screen.findByRole('button', { name: 'Retry saved return and refund' });
    view.unmount();
    render(<ReturnForm {...base} />);
    expect(screen.getByRole('button', { name: 'Retry saved return and refund' })).toBeDisabled();
    expect(
      screen.getByText(/This saved return and refund is kept for reconciliation/)
    ).toBeVisible();
    expect(mocks.returnAndRefund).toHaveBeenCalledOnce();
  });

  it('sends a controlled witness with the combined confirm without persisting it', async () => {
    singleLineReceipt();
    const history = mocks.history as { data: { lines: Array<Record<string, unknown>> } };
    history.data.lines[0].controlled = true;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<ReturnForm {...props} />);
    chooseReceipt();
    chooseReturnReason();
    enterManagerPin();
    const submit = screen.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Witnessing pharmacist'), {
      target: { value: 'staff-w' },
    });
    fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '4826' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnAndRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          controlledWitness: { staffProfileId: 'staff-w', pin: '4826' },
          managerPin: '2468',
        })
      )
    );
    for (const [, value] of setItem.mock.calls) {
      expect(value).not.toContain('4826');
      expect(value).not.toContain('2468');
    }
    await screen.findByText(/Return recorded and refunded/);
    expect(screen.getByLabelText('Witness PIN')).toHaveValue('');
  });

  it('asks which receipt when a number matches more than one sale', () => {
    singleLineReceipt();
    const first = (mocks.lookup as { data: Array<Record<string, unknown>> }).data[0];
    mocks.lookup = { isSuccess: true, data: [first, { ...first, id: 'sale-2' }] };
    render(<ReturnForm {...props} />);
    fireEvent.change(screen.getByLabelText('Receipt number'), { target: { value: '12' } });
    fireEvent.submit(screen.getByLabelText('Receipt number').closest('form')!);
    expect(screen.getByText(/Receipt numbers can repeat/)).toBeVisible();
    // Nothing is opened until the right date and counter is chosen.
    for (const match of screen.getAllByRole('button', { name: /Receipt 12/ }))
      expect(match).toHaveAttribute('aria-pressed', 'false');
  });
});
