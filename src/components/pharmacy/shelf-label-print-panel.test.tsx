import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyInventory: {
      printShelfLabels: {
        useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
      },
    },
  },
}));

import { ShelfLabelPrintPanel } from './shelf-label-print-panel';

const rows = [
  {
    inventoryLotId: 'lot_1',
    code: '7100000000000001',
    name: 'Loose Strip',
    strength: '500 mg',
    packMrpMinor: 30_000,
    stripMrpMinor: 10_000,
    priceRecordMrpMinor: null,
    expiry: '2027-06',
    batchNumber: 'B-1',
    count: 12,
  },
  {
    inventoryLotId: 'lot_2',
    code: '7100000000000002',
    name: 'Legacy Syrup',
    strength: null,
    packMrpMinor: 25_000,
    stripMrpMinor: null,
    priceRecordMrpMinor: 26_000,
    expiry: '2027-01-15',
    batchNumber: 'B-2',
    count: 4,
  },
];

describe('#719 shelf-label print panel', () => {
  beforeEach(() => {
    mocks.mutateAsync.mockReset().mockResolvedValue({ html: '<p>labels</p>', total: 12 });
  });

  it('defaults to one label per received pack and lets the operator change each count', async () => {
    const popup = {
      opener: {},
      closed: false,
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        querySelectorAll: vi.fn(() => []),
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<ShelfLabelPrintPanel branchId="branch_a" goodsReceiptId="grn_1" rows={rows} />);

    expect(screen.getByRole('button', { name: 'Print 16 labels' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Label count for Legacy Syrup/), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText(/^Paper size/), { target: { value: 'A4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print 12 labels' }));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        branchId: 'branch_a',
        goodsReceiptId: 'grn_1',
        format: 'A4',
        items: [{ inventoryLotId: 'lot_1', count: 12 }],
      })
    );
    await waitFor(() => expect(popup.print).toHaveBeenCalled());
    expect(popup.document.write).toHaveBeenCalledWith('<p>labels</p>');
    expect(popup.opener).toBeNull();
    open.mockRestore();
  });

  it('shows both MRPs, N/A for a pack without strips, and a disagreeing price record', () => {
    render(<ShelfLabelPrintPanel branchId="branch_a" rows={rows} />);
    expect(screen.getByText('300.00')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.getByText(/Price record says 260.00/)).toBeInTheDocument();
  });

  it('blocks printing for fractional, negative or oversized counts', () => {
    render(<ShelfLabelPrintPanel branchId="branch_a" rows={rows} />);
    const count = screen.getByLabelText(/Label count for Loose Strip/);
    for (const value of ['1.5', '-1', '5001']) {
      fireEvent.change(count, { target: { value } });
      expect(screen.getByRole('alert')).toHaveTextContent('Use whole counts from 0 to 5,000');
      expect(screen.getByRole('button', { name: /^Print/ })).toBeDisabled();
    }
  });

  it('disables only the conflicting lot and prints the remaining selection', async () => {
    const popup = {
      opener: {}, closed: false,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn(), querySelectorAll: vi.fn(() => []) },
      focus: vi.fn(), print: vi.fn(), close: vi.fn(),
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const reason = 'Resolve the registered barcode before printing this lot.';
    render(<ShelfLabelPrintPanel branchId="branch_a" goodsReceiptId="grn_1" rows={[
      { ...rows[0]!, unavailableReason: reason }, rows[1]!,
    ]} />);

    const blocked = screen.getByLabelText(/Label count for Loose Strip/);
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveValue(0);
    expect(blocked).toHaveAccessibleDescription(`Unavailable: ${reason}`);
    expect(screen.getByLabelText(/Label count for Legacy Syrup/)).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Print 4 labels' }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({
      branchId: 'branch_a', goodsReceiptId: 'grn_1', format: '38x25',
      items: [{ inventoryLotId: 'lot_2', count: 4 }],
    }));
    await waitFor(() => expect(popup.print).toHaveBeenCalled());
    open.mockRestore();
  });

  it('keeps unavailable rows visible and disables printing when none can be selected', () => {
    render(<ShelfLabelPrintPanel branchId="branch_a" rows={rows.map((row) => ({
      ...row, unavailableReason: 'Resolve the registered barcode.',
    }))} />);
    expect(screen.getByText('Loose Strip')).toBeInTheDocument();
    expect(screen.getByText('Legacy Syrup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print 0 labels' })).toBeDisabled();
  });
});
