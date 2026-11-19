import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Setting = {
  branchId: string;
  dayEndsAtHour: number;
  revision: number;
  timeZone: string;
  currentBusinessDay: string;
  openDrawers: number;
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
  revision: 2,
  timeZone: 'Asia/Karachi',
  currentBusinessDay: '2026-11-02',
  openDrawers: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = midnight;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.refetch.mockResolvedValue({ error: null });
  mocks.mutateAsync.mockResolvedValue({});
});
afterEach(cleanup);

describe('DayEndHourPanel (DEV-958A)', () => {
  it('shows midnight, today and that receipts keep the real time', () => {
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByText('Ends at Midnight')).toBeInTheDocument();
    expect(screen.getByLabelText('The business day ends at')).toHaveValue('0');
    expect(screen.getByText(/Today's business day: 2 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Receipts still print the real date and time\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save day end' })).toBeDisabled();
  });

  it('saves a later hour at the loaded revision', async () => {
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
      await screen.findByText("Saved. This branch's business day now ends at 5:00 AM.")
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

  it('is disabled while a drawer is open, and says why', () => {
    mocks.data = { ...midnight, dayEndsAtHour: 5, openDrawers: 2 };
    render(<DayEndHourPanel branchId="branch-1" />);
    expect(screen.getByLabelText('The business day ends at')).toBeDisabled();
    expect(screen.getByText(/2 drawers are open\. Close the day first/)).toBeInTheDocument();
    expect(screen.getByText('Ends at 5:00 AM')).toBeInTheDocument();
  });

  it('shows the server refusal when a save is refused', async () => {
    mocks.mutateAsync.mockRejectedValue(
      new Error(
        'Close every open drawer at this branch (day close) before changing when its day ends.'
      )
    );
    render(<DayEndHourPanel branchId="branch-1" />);
    fireEvent.change(screen.getByLabelText('The business day ends at'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save day end' }));
    expect(await screen.findByText(/Close every open drawer at this branch/)).toBeInTheDocument();
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
