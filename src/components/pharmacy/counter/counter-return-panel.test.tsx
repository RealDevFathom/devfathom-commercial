import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CounterReturnPanel, parseReceiptNumber, ReturnForm } from './counter-return-panel';
const mocks = vi.hoisted(() => ({
  returnLine: vi.fn(),
  refund: vi.fn(),
  refetch: vi.fn(),
  history: {} as Record<string, unknown>,
  lookup: {} as Record<string, unknown>,
  pharmacists: {} as Record<string, unknown>,
  refundAccess: {} as Record<string, unknown>,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      lookupReceiptByNumber: { useQuery: () => mocks.lookup },
      returnHistory: { useQuery: () => mocks.history },
      counterReceipt: { useQuery: () => ({}) },
      returnLine: { useMutation: () => ({ mutateAsync: mocks.returnLine }) },
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
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.refetch.mockResolvedValue({});
  mocks.returnLine.mockResolvedValue({});
  mocks.refund.mockResolvedValue({});
  mocks.pharmacists = { data: [{ id: 'staff-w', name: 'Witness Pharmacist' }] };
  mocks.refundAccess = { data: { authorized: true } };
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
    expect(screen.queryByRole('button', { name: 'Record return' })).not.toBeInTheDocument();
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
  it('books the return and the refund to the active branch', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    fireEvent.change(screen.getByLabelText('Quarantine location'), { target: { value: 'q' } });
    fireEvent.change(screen.getByLabelText('Inspection and integrity decision'), {
      target: { value: 'seal unknown' },
    });
    fireEvent.click(screen.getByLabelText(/I confirm the quantity/));
    enterManagerPin();
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'b', managerPin: '2468' })
      )
    );
  });
  it('sends the cash refund to the active branch drawer', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
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
  it('requires inspected stock and confirmation before posting a return', async () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
    const submit = screen.getByRole('button', { name: 'Record return' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    fireEvent.change(screen.getByLabelText('Quarantine location'), { target: { value: 'q' } });
    fireEvent.change(screen.getByLabelText('Inspection and integrity decision'), {
      target: { value: 'seal unknown' },
    });
    fireEvent.click(screen.getByLabelText(/I confirm the quantity/));
    expect(submit).toBeDisabled();
    enterManagerPin();
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith(
        expect.objectContaining({
          saleLineId: 'line',
          disposition: 'QUARANTINE',
          canonicalUnits: 1,
          quarantineLocationId: 'q',
        })
      )
    );
    await screen.findByText(/Return recorded/);
  });
  it('caps refunds at returned value and requires explicit cash fallback for card', () => {
    render(<ReturnForm {...props} />);
    chooseReceipt();
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
  const restock = screen.getByRole('option', { name: /Restock to verified/ });
  expect(restock).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-b' } });
  expect(restock).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Returned lot / batch'), { target: { value: 'lot-a' } });
  expect(restock).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText('Stock disposition'), { target: { value: 'RESTOCK' } });
  fireEvent.change(screen.getByLabelText('Inspection and integrity decision'), {
    target: { value: 'Physical batch A verified, intact' },
  });
  fireEvent.change(screen.getByLabelText('Return quantity (base units)'), {
    target: { value: '4' },
  });
  fireEvent.click(screen.getByLabelText(/I confirm the quantity/));
  expect(screen.getByRole('button', { name: 'Record return' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Return quantity (base units)'), {
    target: { value: '3' },
  });
  fireEvent.click(screen.getByLabelText(/I confirm the quantity/));
  enterManagerPin();
  fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
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
  function fillControlledReturn() {
    chooseReceipt();
    fireEvent.change(screen.getByLabelText('Sold line'), { target: { value: 'line' } });
    fireEvent.change(screen.getByLabelText('Quarantine location'), { target: { value: 'q' } });
    fireEvent.change(screen.getByLabelText('Inspection and integrity decision'), {
      target: { value: 'sealed' },
    });
    fireEvent.click(screen.getByLabelText(/I confirm the quantity/));
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
    const submit = screen.getByRole('button', { name: 'Record return' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Record return' }));
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
    expect(screen.queryByRole('button', { name: 'Record return' })).not.toBeInTheDocument();
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
