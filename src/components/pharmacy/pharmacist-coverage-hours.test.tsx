import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Coverage = {
  branchId: string;
  timeZone: string;
  windows: { days: number[]; start: string; end: string }[];
  revision: number;
  liveSaleHoursCheck: boolean;
};

const mocks = vi.hoisted(() => ({
  data: undefined as Coverage | undefined,
  isError: false,
  refetch: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOnboarding: {
      pharmacistCoverage: {
        useQuery: () => ({
          data: mocks.data,
          isLoading: false,
          isError: mocks.isError,
          refetch: mocks.refetch,
        }),
      },
      savePharmacistCoverage: {
        useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
      },
    },
  },
}));

import { PharmacistCoverageHoursPanel } from './pharmacist-coverage-hours';

const recorded: Coverage = {
  branchId: 'branch-1',
  timeZone: 'Asia/Karachi',
  windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
  revision: 4,
  liveSaleHoursCheck: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = recorded;
  mocks.isError = false;
  mocks.refetch.mockResolvedValue({ error: null });
  mocks.mutateAsync.mockResolvedValue({});
});
afterEach(cleanup);

describe('PharmacistCoverageHoursPanel (DEV-846)', () => {
  it('says the live-sale hours check is off and the per-sale pharmacist check still applies', () => {
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    expect(screen.getByText('Hours check off')).toBeInTheDocument();
    expect(screen.getByText(/The hours check for live sales is off\./).textContent).toMatch(
      /stays off until the pharmacist adviser's Punjab and Sindh rules are confirmed.*refuse no sale.*still needs its pharmacist check/
    );
    expect(screen.getByText('Times are in Asia/Karachi.')).toBeInTheDocument();
  });

  it('shows the recorded window and saves an added one at the loaded revision', async () => {
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    expect(screen.getByLabelText('From (HH:MM)')).toHaveValue('09:00');
    const save = screen.getByRole('button', { name: 'Save coverage hours' });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add window' }));
    const [, start] = screen.getAllByLabelText('From (HH:MM)');
    const [, end] = screen.getAllByLabelText('Until (HH:MM, 24:00 for midnight)');
    fireEvent.change(start!, { target: { value: '18:00' } });
    fireEvent.change(end!, { target: { value: '24:00' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch-1',
        revision: 4,
        timeZone: 'Asia/Karachi',
        windows: [
          { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
          { days: [1, 2, 3, 4, 5, 6], start: '18:00', end: '24:00' },
        ],
      })
    );
    expect(await screen.findByText('Coverage hours saved.')).toBeInTheDocument();
  });

  it('sends a non-default stored time zone with the save', async () => {
    mocks.data = { ...recorded, timeZone: 'Asia/Dubai' };
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    fireEvent.change(screen.getByLabelText('From (HH:MM)'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save coverage hours' }));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ timeZone: 'Asia/Dubai' })
      )
    );
  });

  it('keeps the whole panel disabled from the save until the refresh finishes', async () => {
    let finish!: (value: { error: null }) => void;
    mocks.refetch.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    fireEvent.change(screen.getByLabelText('From (HH:MM)'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save coverage hours' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
    expect(screen.getByLabelText('From (HH:MM)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add window' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save coverage hours' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload coverage hours' })).toBeDisabled();
    finish({ error: null });
    await waitFor(() => expect(screen.getByLabelText('From (HH:MM)')).toBeEnabled());
  });

  it('keeps an overnight window, marks its end invalid and does not save', async () => {
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    const end = screen.getByLabelText('Until (HH:MM, 24:00 for midnight)');
    fireEvent.change(end, { target: { value: '03:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save coverage hours' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Window 1: End must follow start. Split a shift past midnight into two windows.'
    );
    expect(end).toHaveValue('03:00');
    expect(end).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('clears the record when the last window is removed', async () => {
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove window 1' }));
    expect(screen.getByText(/No coverage hours are recorded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save coverage hours' }));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        branchId: 'branch-1',
        revision: 4,
        timeZone: 'Asia/Karachi',
        windows: [],
      })
    );
    expect(await screen.findByText('Coverage hours cleared.')).toBeInTheDocument();
  });

  it('says sales follow the published rules when the rule set sets presence hours', () => {
    mocks.data = { ...recorded, liveSaleHoursCheck: true };
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    expect(screen.getByText('Hours check on')).toBeInTheDocument();
    expect(
      screen.getByText(/checked against those, not against the hours recorded here/)
    ).toBeInTheDocument();
  });

  it('explains when the hours cannot be read, for example to a non-owner', () => {
    mocks.data = undefined;
    mocks.isError = true;
    render(<PharmacistCoverageHoursPanel branchId="branch-1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The workspace owner records them for each branch.'
    );
    expect(screen.getByRole('button', { name: 'Save coverage hours' })).toBeDisabled();
  });
});
