import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefundWorkspace } from './refund-workspace';
const api = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  mode: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyCardTerminal: { reviewHistory: { invalidate: api.invalidate } } }),
    pharmacyCardTerminal: {
      providerRefunds: { useQuery: api.list },
      reviewHistory: { useQuery: api.history },
      recordRefundAction: { useMutation: () => ({ mutateAsync: api.mutate, isPending: false }) },
    },
  },
}));
vi.mock('@/components/pharmacy/own-approval-copy', () => ({ useApprovalSecretKind: api.mode }));
const row = {
  id: 'refund-1',
  attemptKey: 'synthetic-terminal',
  kind: 'OWED',
  amountMinor: 755,
  remainingMinor: 755,
  actorId: 'owner',
  originalActorId: 'owner',
  createdAt: new Date('2026-11-15'),
  refundId: null,
  terminalConfirmed: false,
};
const data = {
  records: [row],
  historical: [],
  peers: [],
  owner: true,
  actorId: 'owner',
  canWrite: true,
};
const show = () => render(<RefundWorkspace branches={[{ id: 'b', name: 'Branch' }]} />);
beforeEach(() => {
  vi.resetAllMocks();
  api.mode.mockReturnValue('CODE');
  api.list.mockReturnValue({ data, refetch: api.refetch });
  api.history.mockReturnValue({ data: { attempt: { status: 'REVERSED' }, events: [] } });
  api.mutate.mockResolvedValue({ id: 'result' });
});
describe('provider refund accounts workspace', () => {
  it('shows loading, an empty branch and an access refusal', () => {
    api.list.mockReturnValue({ isPending: true });
    const view = show();
    expect(screen.getByRole('status')).toHaveTextContent('Loading branch refunds');
    api.list.mockReturnValue({ data: { ...data, records: [] } });
    view.rerender(<RefundWorkspace branches={[{ id: 'b', name: 'Branch' }]} />);
    expect(screen.getByText(/No card provider refunds/)).toBeVisible();
    api.list.mockReturnValue({ error: { data: { code: 'FORBIDDEN' } } });
    view.rerender(<RefundWorkspace branches={[{ id: 'b', name: 'Branch' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Finance read access');
  });
  it('shows the balance and access required when actions are unavailable', () => {
    api.list.mockReturnValue({ data: { ...data, canWrite: false } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'View synthetic-terminal' }));
    expect(screen.getByText(/755 paisa outstanding ·/)).toBeVisible();
    expect(screen.getByText(/Finance management access is required/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record provider settlement' })).toBeNull();
  });
  it('submits the provider amount, date and reference and refreshes linked history', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'View synthetic-terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record provider settlement' }));
    const fill = (name: string, value: string) =>
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    fill('Amount (PKR paisa)', '756');
    expect(screen.getByLabelText('Amount (PKR paisa)')).toBeInvalid();
    fill('Amount (PKR paisa)', '125');
    fill('Settlement date', '2026-11-20');
    fill('Provider reference', 'SYNTH-125');
    fill('Reason', 'Provider statement checked');
    fill('Your authenticator code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() =>
      expect(api.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementAmountMinor: 125,
          settledOn: '2026-11-20',
          slipRef: 'SYNTH-125',
          previousId: row.id,
          commandKey: expect.any(String),
        })
      )
    );
    expect(api.invalidate).toHaveBeenCalledWith({ branchId: 'b', attemptKey: row.attemptKey });
  });
  it('requires a declared sole-owner sign-off with the active credential mode', () => {
    api.mode.mockReturnValue('PIN');
    show();
    fireEvent.click(screen.getByRole('button', { name: 'View synthetic-terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct a review decision' }));
    expect(screen.getByLabelText('Your PIN')).toBeRequired();
    expect(screen.getByRole('checkbox')).toBeRequired();
    expect(screen.getByLabelText('Reason')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Confirm correction' })).toBeVisible();
  });
});
