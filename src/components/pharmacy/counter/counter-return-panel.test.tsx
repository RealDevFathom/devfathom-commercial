import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReturnForm } from './counter-return-panel';
const mocks = vi.hoisted(() => ({
  returnLine: vi.fn(),
  refund: vi.fn(),
  refetch: vi.fn(),
  history: {} as Record<string, unknown>,
  lookup: {} as Record<string, unknown>,
  pharmacists: {} as Record<string, unknown>,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      lookupReceiptByNumber: { useQuery: () => mocks.lookup },
      returnHistory: { useQuery: () => mocks.history },
      counterReceipt: { useQuery: () => ({}) },
      returnLine: { useMutation: () => ({ mutateAsync: mocks.returnLine }) },
      refundTender: { useMutation: () => ({ mutateAsync: mocks.refund }) },
    },
    pharmacySafety: {
      controlledPharmacists: { useQuery: () => mocks.pharmacists },
    },
  },
}));
const props = {
  branchId: 'b',
  organizationId: 'o',
  accountId: 'a',
  deviceId: () => 'd',
  businessDate: () => new Date('2026-09-29'),
};
function chooseReceipt() {
  fireEvent.click(screen.getByRole('button', { name: /Receipt 12/ }));
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.refetch.mockResolvedValue({});
  mocks.returnLine.mockResolvedValue({});
  mocks.refund.mockResolvedValue({});
  mocks.pharmacists = { data: [{ id: 'staff-w', name: 'Witness Pharmacist' }] };
  mocks.lookup = {
    isSuccess: true,
    data: [
      { id: 'sale', receiptNumber: 12, businessDate: new Date('2026-09-29'), receiptDeviceId: 'd' },
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
    expect(screen.getByText('No settled receipt found in this branch.')).toBeVisible();
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
      fireEvent.click(await screen.findByRole('button', { name: 'Retry saved refund' }));
      await waitFor(() => expect(mocks.refund).toHaveBeenCalledTimes(2));
      expect(mocks.refund.mock.calls[1][0]).toEqual(first);
    }
  );
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
        })
      )
    );
    await screen.findByText(/Return recorded/);
    for (const [, value] of setItem.mock.calls) {
      expect(value).not.toContain('4826');
      expect(value).not.toContain('controlledWitness');
    }
    expect(screen.getByLabelText('Witness PIN')).toHaveValue('');
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
    fireEvent.click(retry);
    await waitFor(() =>
      expect(mocks.returnLine).toHaveBeenCalledWith({
        ...saved.input,
        controlledWitness: { staffProfileId: 'staff-w', pin: '1111' },
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('retry the saved return')
    );
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
    expect(screen.getByRole('button', { name: 'Retry saved return' })).toBeDisabled();
  });
});
