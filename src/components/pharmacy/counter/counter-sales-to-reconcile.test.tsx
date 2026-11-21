/**
 * DEV-957 phase 2 (review B2): the read-only "Sales to reconcile" list. Offline sales a
 * revoked counter kept are shown with what they were, exported as a CSV, and leave this
 * computer only once a manager has recorded what was done with them on the server.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  record: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOffline: {
      recordUnsentOfflineSale: {
        useMutation: () => ({ mutateAsync: h.record, isPending: false }),
      },
    },
  },
}));

import type { ReconcileSale } from '@/lib/pharmacy/counter-reconcile';
import { CounterSalesToReconcileList } from './counter-sales-to-reconcile';
import type { CounterReconcileView } from './use-counter-reconcile';

function sale(overrides: Partial<ReconcileSale> = {}): ReconcileSale {
  return {
    recordKey: 'org::branch::counter_1::reconcile',
    counterName: 'Front till',
    deviceId: 'counter_1',
    commandId: 'sale-1',
    sequence: 1,
    receiptNumber: 501,
    soldAt: '2026-11-20T10:15:00.000Z',
    amountMinor: 330,
    cashReceivedMinor: 500,
    cashierName: 'Ayesha Khan',
    sealHash: 'a'.repeat(64),
    lines: [
      { medicineId: 'med_1', medicineName: 'Brufen 400', saleUnit: 'STRIP', quantity: 1, lineTotalMinor: 330 },
    ],
    ...overrides,
  };
}

function view(sales: ReconcileSale[], settle = vi.fn(async () => undefined)): CounterReconcileView {
  return { sales, loaded: true, settle, reload: vi.fn() };
}

beforeEach(() => {
  h.record.mockReset();
});

describe('DEV-957 phase 2: Sales to reconcile', () => {
  it('shows nothing when this computer keeps no unsent sale', () => {
    const { container } = render(
      <CounterSalesToReconcileList view={view([])} branchId="branch" online />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each kept sale read-only, with who sold it, and offers the export', () => {
    render(<CounterSalesToReconcileList view={view([sale()])} branchId="branch" online />);
    expect(screen.getByRole('heading', { name: 'Sales to reconcile (1)' })).toBeVisible();
    expect(screen.getByText(/Counter Front till · sold by Ayesha Khan \(offline\)/)).toBeVisible();
    expect(screen.getByText('1 × Brufen 400 (strip)')).toBeVisible();
    expect(screen.getByText('Not booked')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export (CSV)' })).toBeEnabled();
    // Nothing on this list sells, edits or sends a sale.
    expect(screen.queryByRole('button', { name: /take cash|send|edit|delete/i })).toBeNull();
  });

  it('DEV-977B: offers no quantity, unit or remove control on a kept sale line', () => {
    render(<CounterSalesToReconcileList view={view([sale()])} branchId="branch" online />);
    expect(screen.queryByRole('button', { name: /^[+−-] |Remove|^Quantity/ })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByLabelText(/^Quantity: /)).toBeNull();
    expect(screen.getByText('1 × Brufen 400 (strip)')).toBeVisible();
  });

  it('removes a sale from this computer only after a manager recorded it on the server', async () => {
    const settle = vi.fn(async () => undefined);
    h.record.mockResolvedValue({ recorded: true, serverStatus: null });
    render(<CounterSalesToReconcileList view={view([sale()], settle)} branchId="branch" online />);
    fireEvent.click(screen.getByRole('button', { name: 'Record what was done' }));
    // A note is required.
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write what was done with this sale.');
    expect(h.record).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Entered as bill 4512' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    });
    expect(h.record).toHaveBeenCalledWith({
      branchId: 'branch',
      deviceId: 'counter_1',
      commandId: 'sale-1',
      sequence: 1,
      receiptNumber: 501,
      amountMinor: 330,
      soldAt: '2026-11-20T10:15:00.000Z',
      sealHash: 'a'.repeat(64),
      outcome: 'ENTERED_ONLINE',
      note: 'Entered as bill 4512',
    });
    await waitFor(() => expect(settle).toHaveBeenCalledWith(sale()));
  });

  it('keeps the sale when the server refuses the record', async () => {
    const settle = vi.fn(async () => undefined);
    h.record.mockRejectedValue({ data: { code: 'FORBIDDEN' } });
    render(<CounterSalesToReconcileList view={view([sale()], settle)} branchId="branch" online />);
    fireEvent.click(screen.getByRole('button', { name: 'Record what was done' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Money returned' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a manager of this branch can record this.'
    );
    expect(settle).not.toHaveBeenCalled();
  });

  it('says who already recorded the sale, and how, when another manager did first (review round 3)', async () => {
    const settle = vi.fn(async () => undefined);
    const message =
      'Receipt 501 was already recorded by Bilal Ahmed on 20 Nov 2026, 15:20 as "Money given back to the customer", with the note "Refunded at the door". Nothing was changed.';
    h.record.mockRejectedValue({ data: { code: 'CONFLICT' }, message });
    render(<CounterSalesToReconcileList view={view([sale()], settle)} branchId="branch" online />);
    fireEvent.click(screen.getByRole('button', { name: 'Record what was done' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Entered as bill 4512' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    });
    // The first record stands on the server, so this computer's copy goes, and says why.
    await waitFor(() => expect(settle).toHaveBeenCalledWith(sale()));
    expect(screen.getByRole('status')).toHaveTextContent(
      `${message} It is no longer kept on this computer.`
    );
  });

  it('cannot record anything while offline, but still shows and exports the sales', () => {
    render(<CounterSalesToReconcileList view={view([sale()])} branchId="branch" online={false} />);
    expect(screen.getByRole('button', { name: 'Record what was done' })).toBeDisabled();
    expect(screen.getByText('Recording what was done needs the connection.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export (CSV)' })).toBeEnabled();
  });
});
