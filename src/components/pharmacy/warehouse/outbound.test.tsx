import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Outbound } from './outbound';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trpc', () => {
  const passive = { useMutation: () => ({ mutateAsync: vi.fn() }) };
  const order = {
    id: 'order-1',
    status: 'OPEN',
    toBranchName: 'Lahore',
    transferStatus: 'APPROVED',
    transferId: 'transfer-1',
    demands: [{ shortfallUnits: 0 }],
    reservations: [
      {
        id: 'line-1',
        state: 'PACKED',
        transferId: 'transfer-1',
        quantityUnits: 12,
        productName: 'Insulin',
        medicineId: 'insulin',
        coldChain: true,
        sourceBinCode: 'C1',
        lotCode: 'LOT-1',
      },
    ],
  };
  return {
    trpc: {
      useUtils: () => ({
        pharmacyWarehouse: { invalidate: vi.fn() },
        pharmacyInventory: { transferBoard: { invalidate: vi.fn() } },
      }),
      pharmacyWarehouse: {
        outbound: { useQuery: () => ({ data: [order] }) },
        overview: { useQuery: () => ({ data: { adoptable: [] } }) },
        cancel: passive,
        replenish: passive,
        pick: passive,
        pack: passive,
        adoptTransfer: passive,
        dispatchEvidence: passive,
      },
      pharmacyInventory: {
        transferBoard: { useQuery: () => ({ data: [] }) },
        approveTransfer: passive,
        dispatchTransfer: { useMutation: () => ({ mutateAsync: dispatch }) },
      },
    },
  };
});
afterEach(() => {
  cleanup();
  dispatch.mockReset();
});

it.each([
  ['ALLOCATED', 'Dispatch held. Review temperature evidence in Quality before retrying.'],
  ['APPROVED', 'Dispatch held. Review temperature evidence in Quality before retrying.'],
  ['DISPATCHED', 'Dispatch confirmed.'],
])('reports the actual server state after dispatch (%s)', async (status, message) => {
  dispatch.mockResolvedValueOnce({ status });
  render(<Outbound branchId="warehouse" />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm dispatch' }));
  expect(await screen.findByRole('status')).toHaveTextContent(message);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ branchId: 'warehouse', transferId: 'transfer-1' })
  );
});
