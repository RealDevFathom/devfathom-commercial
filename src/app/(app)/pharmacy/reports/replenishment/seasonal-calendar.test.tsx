import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SeasonalCalendar } from './seasonal-calendar';

const mocks = vi.hoisted(() => ({ query: vi.fn(), refetch: vi.fn(), mutate: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyReports: { seasonalCalendar: { invalidate: vi.fn() } } }),
    pharmacyReports: {
      seasonalCalendar: { useQuery: mocks.query },
      saveSeasonalWindow: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      deleteSeasonalWindow: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    refetch: mocks.refetch,
  });
});
describe('seasonal calendar read states', () => {
  it('shows an empty calendar only after a successful read', () => {
    render(<SeasonalCalendar branchId="branch" />);
    expect(screen.getByText(/No seasonal windows recorded/)).toBeVisible();
    expect(screen.getByLabelText('Window name')).toBeEnabled();
  });
  it('announces loading and disables edits', () => {
    mocks.query.mockReturnValue({ isPending: true });
    render(<SeasonalCalendar branchId="branch" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading seasonal calendar');
    expect(screen.queryByText(/No seasonal windows/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Window name')).toBeDisabled();
  });
  it('explains failed reads and lets the owner retry', () => {
    mocks.query.mockReturnValue({ error: { message: 'network failure' }, refetch: mocks.refetch });
    render(<SeasonalCalendar branchId="branch" />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText(/No seasonal windows/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Window name')).toBeDisabled();
  });
  it.each(['FORBIDDEN', 'UNAUTHORIZED'])(
    'explains %s without suggesting an empty calendar',
    (code) => {
      mocks.query.mockReturnValue({ error: { data: { code } } });
      render(<SeasonalCalendar branchId="branch" />);
      expect(screen.getByRole('alert')).toHaveTextContent('do not have permission');
      expect(screen.queryByRole('button', { name: 'Retry calendar' })).not.toBeInTheDocument();
      expect(screen.queryByText(/No seasonal windows/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Owner PIN')).toBeDisabled();
    }
  );
});
