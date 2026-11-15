import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calendar: vi.fn(),
  spikes: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyReports: { seasonalCalendar: { invalidate: mocks.invalidate } } }),
    pharmacyReports: {
      seasonalCalendar: { useQuery: mocks.calendar },
      saltSpikes: { useQuery: mocks.spikes },
      saveSeasonalWindow: {
        useMutation: () => ({ mutate: mocks.save, isPending: false }),
      },
      deleteSeasonalWindow: {
        useMutation: () => ({ mutate: mocks.remove, isPending: false }),
      },
    },
  },
}));

import { SeasonalCalendarPanel } from './seasonal-calendar-panel';

const windows = [
  {
    id: 'win-1',
    branchId: 'branch-1',
    kind: 'RAMADAN',
    label: 'Ramadan 1448',
    startDate: '2027-02-08',
    endDateExclusive: '2027-03-10',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spikes.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      salts: [
        {
          ingredientId: 'para',
          name: 'Paracetamol',
          spikes: [
            {
              date: '2026-11-02',
              units: 50,
              baselineMeanUnits: 10,
              upliftBps: 50_000,
              baselineDays: 28,
            },
          ],
        },
      ],
    },
  });
});

describe('seasonal calendar panel', () => {
  it('lets the owner add and remove windows for the selected branch', () => {
    mocks.calendar.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { windows, canEdit: true },
    });
    render(<SeasonalCalendarPanel branchId="branch-1" today="2026-11-03" />);
    expect(screen.getByText('Ramadan 1448')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: 'MONSOON' } });
    expect(screen.getByLabelText('Label')).toHaveValue('Monsoon');
    fireEvent.click(screen.getByRole('button', { name: 'Add window' }));
    expect(mocks.save).toHaveBeenCalledWith({
      branchId: 'branch-1',
      kind: 'MONSOON',
      label: 'Monsoon',
      startDate: '2026-11-03',
      endDateExclusive: '2026-12-03',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mocks.remove).toHaveBeenCalledWith({ branchId: 'branch-1', id: 'win-1' });
  });

  it('edits an existing window and blocks an inverted range before sending', () => {
    mocks.calendar.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { windows, canEdit: true },
    });
    render(<SeasonalCalendarPanel branchId="branch-1" today="2026-11-03" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Ends before'), { target: { value: '2027-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save window' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The end date must be after the start date.'
    );
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Ends before'), { target: { value: '2027-03-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save window' }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'win-1', kind: 'RAMADAN', endDateExclusive: '2027-03-11' })
    );
  });

  it('shows windows read-only to staff and lists salt spikes as estimates', () => {
    mocks.calendar.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { windows, canEdit: false },
    });
    render(<SeasonalCalendarPanel branchId="branch-1" today="2026-11-03" />);
    expect(screen.queryByRole('button', { name: 'Add window' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByText('Paracetamol')).toBeVisible();
    expect(screen.getByText('5.0×')).toBeVisible();
    expect(mocks.spikes).toHaveBeenCalledWith(
      { branchId: 'branch-1', from: '2026-10-21', to: '2026-11-03' },
      { retry: false }
    );
  });
});
