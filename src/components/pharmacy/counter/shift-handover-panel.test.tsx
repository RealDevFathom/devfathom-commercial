import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  loading: false,
  note: null as string | null,
  error: null as { data: { code: string } } | null,
  refetch: vi.fn(),
  input: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      shiftHandoverNote: {
        useQuery: (input: { drawerSessionId: string }) => {
          mock.input(input);
          return {
            isLoading: mock.loading,
            error: mock.error,
            data: { note: mock.note ?? `Draft for ${input.drawerSessionId}` },
            refetch: mock.refetch,
          };
        },
      },
    },
  },
}));
import { ShiftHandoverPanel } from './shift-handover-panel';
const drawers = [
  { id: 'first', label: 'Morning shift' },
  { id: 'second', label: 'Evening shift' },
];
beforeEach(() => {
  mock.loading = false;
  mock.note = null;
  mock.error = null;
  vi.clearAllMocks();
});
afterEach(cleanup);
describe('reviewed handover draft', () => {
  it('requires confirmation before copying and invalidates review when edited', async () => {
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    const button = screen.getByRole('button', { name: 'Copy reviewed note' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Draft for first'));
    fireEvent.change(screen.getByLabelText('Handover note'), {
      target: { value: 'Reviewed handover' },
    });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(button).toBeDisabled();
  });
  it('clears edits and review when switching drawers or branches', () => {
    const view = render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    fireEvent.change(screen.getByLabelText('Handover note'), { target: { value: 'private edit' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Closed drawer'), { target: { value: 'second' } });
    expect(screen.getByLabelText('Handover note')).toHaveValue('Draft for second');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    view.rerender(<ShiftHandoverPanel branchId="other" drawers={drawers} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(mock.input).toHaveBeenLastCalledWith({ branchId: 'other', drawerSessionId: 'second' });
  });
  it('requires a fresh review when the server returns a changed snapshot', () => {
    const view = render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    fireEvent.click(screen.getByRole('checkbox'));
    mock.note = 'Updated outstanding work';
    view.rerender(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    expect(screen.getByLabelText('Handover note')).toHaveValue('Updated outstanding work');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Copy reviewed note' })).toBeDisabled();
  });
  it('resets the editable draft without persisting it', () => {
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    fireEvent.change(screen.getByLabelText('Handover note'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft' }));
    expect(screen.getByLabelText('Handover note')).toHaveValue('Draft for first');
  });
  it('does not expose cached notes after permission refusal', () => {
    mock.error = { data: { code: 'FORBIDDEN' } };
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Handover note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('offers retry for a transient error', () => {
    mock.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry handover' }));
    expect(mock.refetch).toHaveBeenCalledOnce();
  });
  it('announces loading without showing stale notes', () => {
    mock.loading = true;
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing outstanding work');
    expect(screen.queryByLabelText('Handover note')).not.toBeInTheDocument();
  });
  it('shows a manual-copy fallback when clipboard access fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    render(<ShiftHandoverPanel branchId="branch" drawers={drawers} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy reviewed note' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('copy it manually'));
  });
});
