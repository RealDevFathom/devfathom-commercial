import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Outbound } from './outbound';
import { Arrivals } from './supervision';

const dispatch = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({
  required: true,
  dispatchEvidence: vi.fn(),
  receive: vi.fn(),
}));
vi.mock('@/lib/trpc', () => {
  const passive = { useMutation: () => ({ mutateAsync: vi.fn() }) };
  const order = () => ({
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
        productName: 'Monitored ambient medicine',
        medicineId: 'ambient',
        coldChain: false,
        requiresTemperatureEvidence: transport.required,
        sourceBinCode: 'C1',
        lotCode: 'LOT-1',
      },
    ],
  });
  const incoming = () => [
    {
      id: 'transfer-1',
      fromBranchName: 'Warehouse',
      status: 'DISPATCHED',
      lines: [
        {
          id: 'line-1',
          medicineId: 'ambient',
          medicineName: 'Monitored ambient medicine',
          coldChain: false,
          requiresTemperatureEvidence: transport.required,
          lotLabel: 'LOT-1',
          destinationBinCode: 'A1',
          quantityUnits: 12,
          receivedUnits: 0,
        },
      ],
    },
  ];
  return {
    trpc: {
      useUtils: () => ({
        pharmacyWarehouse: { invalidate: vi.fn() },
        pharmacyInventory: { transferBoard: { invalidate: vi.fn() } },
      }),
      pharmacyWarehouse: {
        outbound: { useQuery: () => ({ data: [order()] }) },
        overview: { useQuery: () => ({ data: { adoptable: [], incoming: incoming() } }) },
        cancel: passive,
        replenish: passive,
        pick: passive,
        pack: passive,
        adoptTransfer: passive,
        dispatchEvidence: { useMutation: () => ({ mutateAsync: transport.dispatchEvidence }) },
      },
      pharmacyInventory: {
        transferBoard: { useQuery: () => ({ data: [] }) },
        approveTransfer: passive,
        receiveTransferLine: { useMutation: () => ({ mutateAsync: transport.receive }) },
        dispatchTransfer: { useMutation: () => ({ mutateAsync: dispatch }) },
      },
    },
  };
});
afterEach(() => {
  cleanup();
  dispatch.mockReset();
  transport.dispatchEvidence.mockReset();
  transport.receive.mockReset();
  transport.required = true;
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

it('submits dispatch logger readings for an ambient medicine with approved temperature limits', async () => {
  render(<Outbound branchId="warehouse" />);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum measured °C' }), {
    target: { value: '16.5' },
  });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum measured °C' }), {
    target: { value: '23.5' },
  });
  fireEvent.change(screen.getByLabelText('Logger record or evidence reference'), {
    target: { value: 'LOGGER-DISPATCH' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record dispatch temperature evidence' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Dispatch evidence recorded.');
  expect(transport.dispatchEvidence).toHaveBeenCalledWith({
    branchId: 'warehouse',
    transferId: 'transfer-1',
    minimumC: 16.5,
    maximumC: 23.5,
    evidenceRef: 'LOGGER-DISPATCH',
    requestKey: expect.any(String),
  });
});

it('submits transport evidence with the receipt for an ambient medicine with approved limits', async () => {
  render(<Arrivals branchId="destination" />);
  for (const [name, value] of [
    ['Product barcode or catalog ID', 'ambient'],
    ['Source lot shelf label', 'LOT-1'],
    ['Destination bin code', 'A1'],
    ['Physical units received (including damage)', '12'],
    ['Transit minimum °C', '18.5'],
    ['Transit maximum °C', '22.25'],
    ['Transit evidence reference', 'LOGGER-RECEIPT'],
  ]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Receipt recorded.');
  expect(transport.receive).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 'destination',
      transferId: 'transfer-1',
      lineId: 'line-1',
      receivedUnits: 12,
      damagedUnits: 0,
      productScan: 'ambient',
      lotScan: 'LOT-1',
      binScan: 'A1',
      transportEvidence: { minimumC: 18.5, maximumC: 22.25, evidenceRef: 'LOGGER-RECEIPT' },
    })
  );
});

it('keeps unmonitored ambient shipments free of temperature evidence prompts', () => {
  transport.required = false;
  render(
    <>
      <Outbound branchId="warehouse" />
      <Arrivals branchId="destination" />
    </>
  );
  expect(
    screen.queryByRole('button', { name: 'Record dispatch temperature evidence' })
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Transit minimum °C')).not.toBeInTheDocument();
});
