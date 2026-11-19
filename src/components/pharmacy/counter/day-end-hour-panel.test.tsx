import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Setting = {
  branchId: string;
  dayEndsAtHour: number;
  scheduledHour: number;
  pendingChange: { from: string; hour: number } | null;
  revision: number;
  timeZone: string;
  currentBusinessDay: string;
  nextChangeDay: string;
};

const mocks = vi.hoisted(() => ({
  data: undefined as Setting | undefined,
  isLoading: false,
  error: null as null | { data?: { code?: string } },
  refetch: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      dayEndHour: {
        useQuery: () => ({
          data: mocks.data,
          isLoading: mocks.isLoading,
          isError: Boolean(mocks.error),
          error: mocks.error,
          refetch: mocks.refetch,
        }),
      },
      saveDayEndHour: {
        useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
      },
    },
  },
}));

import { DayEndHourPanel } from './day-end-hour-panel';

const midnight: Setting = {
  branchId: 'branch-1',
  dayEndsAtHour: 0,
  scheduledHour: 0,
  pendingChange: null,
  revision: 2,
  timeZone: 'Asia/Karachi',
  currentBusinessDay: '2026-11-18',
  nextChangeDay: '2026-11-20',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = midnight;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.refetch.mockResolvedValue({ error: null });
  mocks.mutateAsync.mockResolvedValue({ from: '2026-11-20' });
});
afterEach(cleanup);

describe('DayEndHourPanel (DEV-958A)', () => {
  it('shows midnight, today, and that receipts and past days stay as they are', () => {
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByText('Ends at Midnight')).toBeInTheDocument();
    expect(screen.getByLabelText('The business day ends at')).toHaveValue('0');
    expect(screen.getByText(/Today's business day: 18 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Receipts still print the real date and time\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        /A change starts with the next business day, 19 Nov 2026: it begins as usual and ends at the new hour on 20 Nov 2026.*Today, every earlier day, their day closes and their reports stay exactly as they are\./
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save day end' })).toBeDisabled();
  });

  it('saves a later hour at the loaded revision and says from which day', async () => {
    render(<DayEndHourPanel branchId="branch-1" />);
    fireEvent.change(screen.getByLabelText('The business day ends at'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save day end' }));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch-1',
        revision: 2,
        dayEndsAtHour: 5,
      })
    );
    expect(
      await screen.findByText(
        "Saved. From the business day of 20 Nov 2026, this branch's day ends at 5:00 AM."
      )
    ).toBeInTheDocument();
  });

  it('offers only midnight to 6:00 AM', () => {
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Midnight',
      '1:00 AM',
      '2:00 AM',
      '3:00 AM',
      '4:00 AM',
      '5:00 AM',
      '6:00 AM',
    ]);
  });

  it('shows a change already set for a later day, and starts from it', () => {
    mocks.data = { ...midnight, scheduledHour: 5, pendingChange: { from: '2026-11-20', hour: 5 } };
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByText('Ends at Midnight')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Already set: from the business day of 20 Nov 2026, the day ends at 5:00 AM.'
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText('The business day ends at')).toHaveValue('5');
  });

  it('shows the server refusal when a save is refused', async () => {
    mocks.mutateAsync.mockRejectedValue(
      new Error('This setting changed while you were editing it. Reload and try again.')
    );
    render(<DayEndHourPanel branchId="branch-1" />);
    fireEvent.change(screen.getByLabelText('The business day ends at'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save day end' }));
    expect(
      await screen.findByText(/This setting changed while you were editing it/)
    ).toBeInTheDocument();
  });

  it('explains who may change it to anyone else, and loading', () => {
    mocks.data = undefined;
    mocks.error = { data: { code: 'FORBIDDEN' } };
    const { unmount } = render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByRole('alert').textContent).toMatch(
      /Only the owner, or a manager assigned to this branch/
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();
    mocks.error = null;
    mocks.isLoading = true;
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading this branch/);
  });
});
