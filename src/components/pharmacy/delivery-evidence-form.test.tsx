import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DeliveryEvidenceForm } from './delivery-evidence-form';

const mocks = vi.hoisted(() => ({ command: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOrdering: {
      deliveryCommand: { useMutation: () => ({ mutateAsync: mocks.command, isPending: false }) },
    },
    useUtils: () => ({
      pharmacyOrdering: {
        mine: { invalidate: mocks.invalidate },
        staffQueue: { invalidate: mocks.invalidate },
      },
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.command.mockResolvedValue({
    replayed: false,
    totals: { collectedMinor: 0, remittedMinor: 0, custodyMinor: 0 },
  });
});

function fill(action: string) {
  render(<DeliveryEvidenceForm branchId="branch-a" orderId="order-a" />);
  fireEvent.change(screen.getByLabelText('Evidence action'), { target: { value: action } });
  fireEvent.change(screen.getByLabelText('Evidence reference'), { target: { value: 'ref' } });
  fireEvent.change(screen.getByLabelText('Operation key (reuse for retry)'), {
    target: { value: 'key-1' },
  });
}

it('DEV-647: sends the manager PIN with a physical return and clears it', async () => {
  fill('PHYSICAL_RETURN');
  fireEvent.change(screen.getByLabelText(/Open drawer device ID/), { target: { value: 'dev-1' } });
  const pin = screen.getByLabelText(/Manager or owner PIN/);
  expect(pin).toHaveAttribute('type', 'password');
  fireEvent.change(pin, { target: { value: '7391' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() =>
    expect(mocks.command).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PHYSICAL_RETURN', managerPin: '7391' })
    )
  );
  expect(screen.getByLabelText(/Manager or owner PIN/)).toHaveValue('');
});

it('DEV-647: asks for no PIN on evidence that cannot refund', async () => {
  fill('REFUSED');
  expect(screen.queryByLabelText(/Manager or owner PIN/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Record custody evidence' }));
  await waitFor(() => expect(mocks.command).toHaveBeenCalledOnce());
  expect(mocks.command.mock.calls[0]![0]).not.toHaveProperty('managerPin');
});
