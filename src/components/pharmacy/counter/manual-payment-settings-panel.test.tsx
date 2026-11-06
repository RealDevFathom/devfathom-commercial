import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualPaymentSettingsPanel } from './manual-payment-settings-panel';

const mocks = vi.hoisted(() => ({
  query: {
    data: { settings: {}, revision: 2 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      manualPaymentSettings: { useQuery: () => mocks.query },
      saveManualPaymentSettings: {
        useMutation: () => ({ mutateAsync: mocks.save, isPending: false }),
      },
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = { settings: {}, revision: 2 };
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  mocks.query.refetch.mockResolvedValue({ data: mocks.query.data });
  mocks.save.mockResolvedValue({ revision: 3 });
});
describe('#710 merchant settings form', () => {
  it('preserves the edited revision when background refresh discovers another owner’s change', async () => {
    const view = render(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByLabelText('Enable Raast'));
    fireEvent.change(screen.getByLabelText('IBAN or till number'), {
      target: { value: 'Till 123' },
    });
    mocks.query.data = { settings: {}, revision: 3 };
    view.rerender(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save merchant details' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        branchId: 'branch',
        revision: 2,
        settings: { RAAST: { destination: 'Till 123', allowReferenceSkip: false } },
      })
    );
  });
  it('enables a manual tender without requiring QR or destination', async () => {
    render(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByLabelText('Enable Raast'));
    fireEvent.click(screen.getByRole('button', { name: 'Save merchant details' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        branchId: 'branch',
        revision: 2,
        settings: { RAAST: { destination: '', allowReferenceSkip: false } },
      })
    );
  });
  it('disables merchant edits when access or loading fails', () => {
    mocks.query.isError = true;
    render(<ManualPaymentSettingsPanel branchId="branch" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Merchant details are unavailable');
    expect(screen.getByLabelText('Enable Raast')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save merchant details' })).toBeDisabled();
  });
});
