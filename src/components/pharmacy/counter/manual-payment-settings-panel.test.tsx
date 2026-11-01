import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualPaymentSettingsPanel } from './manual-payment-settings-panel';

const mocks = vi.hoisted(() => ({
  query: { data: { settings: {}, revision: 2 }, isLoading: false, isError: false, refetch: vi.fn() },
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({ trpc: { pharmacySales: {
  manualPaymentSettings: { useQuery: () => mocks.query },
  saveManualPaymentSettings: { useMutation: () => ({ mutateAsync: mocks.save, isPending: false }) },
} } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = { settings: {}, revision: 2 };
  mocks.query.isLoading = false; mocks.query.isError = false;
  mocks.query.refetch.mockResolvedValue({ data: mocks.query.data });
  mocks.save.mockResolvedValue({ revision: 3 });
});
describe('#710 merchant settings form', () => {
  it('preserves the edited revision when background refresh discovers another owner’s change', async () => {
    const view = render(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByLabelText('Enable RAAST'));
    fireEvent.change(screen.getByLabelText('IBAN or till number'), { target: { value: 'Till 123' } });
    mocks.query.data = { settings: {}, revision: 3 };
    view.rerender(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save merchant details' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ branchId: 'branch', revision: 2, settings: { RAAST: { destination: 'Till 123', allowReferenceSkip: false } } }));
  });
  it('requires a QR or destination and preserves invalid input for correction', async () => {
    render(<ManualPaymentSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByLabelText('Enable RAAST'));
    fireEvent.click(screen.getByRole('button', { name: 'Save merchant details' }));
    expect(await screen.findByText('Upload a merchant QR or enter an IBAN or till number.')).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Enable RAAST')).toBeChecked();
  });
  it('disables merchant edits when access or loading fails', () => {
    mocks.query.isError = true;
    render(<ManualPaymentSettingsPanel branchId="branch" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Merchant details are unavailable');
    expect(screen.getByLabelText('Enable RAAST')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save merchant details' })).toBeDisabled();
  });
});
