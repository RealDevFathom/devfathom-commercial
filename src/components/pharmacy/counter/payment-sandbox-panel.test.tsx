import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PaymentSandboxPanel } from './payment-sandbox-panel';
const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: { sandboxPayment: { useMutation: () => ({ mutateAsync, isPending: false }) } },
  },
}));
beforeEach(() => mutateAsync.mockReset());
function setup() {
  render(
    <PaymentSandboxPanel
      branchId="branch"
      saleId="sale"
      deviceId="device"
      businessDate={new Date('2026-10-08')}
      disabled={false}
      onRecorded={async () => {}}
    />
  );
  fireEvent.change(screen.getByLabelText('Amount (in paisa, 100 paisa = 1 rupee)'), { target: { value: '200' } });
  fireEvent.change(screen.getByLabelText('Evidence reason'), {
    target: { value: 'Synthetic evidence' },
  });
}
async function submit(count: number) {
  fireEvent.click(screen.getByRole('button', { name: 'Record sandbox operation' }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(count));
}
it.each(['Sale', 'Refund returned value'])(
  'requires explicit new identity for two equal resolved %s operations',
  async (action) => {
    mutateAsync.mockResolvedValue({ status: 'APPROVED', token: 'sandbox:test', replayed: false });
    setup();
    if (action !== 'Sale') {
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'REFUND' } });
      fireEvent.change(screen.getByLabelText('Original sandbox tender ID'), {
        target: { value: 'tender' },
      });
    }
    await submit(1);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New sandbox operation' })).toBeEnabled()
    );
    await submit(2);
    expect(mutateAsync.mock.calls[1][0].operationKey).toBe(
      mutateAsync.mock.calls[0][0].operationKey
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New sandbox operation' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'New sandbox operation' }));
    await submit(3);
    expect(mutateAsync.mock.calls[2][0].operationKey).not.toBe(
      mutateAsync.mock.calls[0][0].operationKey
    );
    expect(mutateAsync.mock.calls[2][0].amountMinor).toBe(200);
  }
);
it('retains uncertain transport identity and unknown identity until explicit reconciliation', async () => {
  mutateAsync
    .mockRejectedValueOnce(new Error('Transport unavailable'))
    .mockResolvedValueOnce({ status: 'UNKNOWN', token: 'sandbox:test', replayed: false })
    .mockResolvedValueOnce({ status: 'APPROVED', token: 'sandbox:test', replayed: false });
  setup();
  await submit(1);
  await screen.findByText('Transport unavailable');
  expect(screen.getByRole('button', { name: 'New sandbox operation' })).toBeDisabled();
  expect(screen.getByLabelText('Amount (in paisa, 100 paisa = 1 rupee)')).toBeDisabled();
  await submit(2);
  await screen.findByText(/UNKNOWN ·/);
  expect(screen.getByRole('button', { name: 'New sandbox operation' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'RECONCILE' } });
  await submit(3);
  expect(new Set(mutateAsync.mock.calls.map(([input]) => input.operationKey)).size).toBe(1);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'New sandbox operation' })).toBeEnabled()
  );
});
