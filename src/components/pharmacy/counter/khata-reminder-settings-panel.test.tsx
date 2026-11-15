import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KhataReminderSettingsPanel } from './khata-reminder-settings-panel';

const mocks = vi.hoisted(() => ({
  query: {
    data: { settings: { enabled: true, cadenceDays: 7, minBalanceMinor: 10_000 }, revision: 4 } as
      | {
          settings: { enabled: boolean; cadenceDays: number; minBalanceMinor: number };
          revision: number;
        }
      | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      khataReminderSettings: { useQuery: () => mocks.query },
      saveKhataReminderSettings: {
        useMutation: () => ({ mutateAsync: mocks.save, isPending: false }),
      },
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = {
    settings: { enabled: true, cadenceDays: 7, minBalanceMinor: 10_000 },
    revision: 4,
  };
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  mocks.query.refetch.mockResolvedValue({ data: mocks.query.data });
  mocks.save.mockResolvedValue({ revision: 5 });
});

describe('DEV-76 khata reminder schedule form', () => {
  it('shows the saved schedule and saves the owner change against the loaded revision', async () => {
    render(<KhataReminderSettingsPanel branchId="branch" />);
    expect(screen.getByLabelText('Days between reminders')).toHaveValue(7);
    expect(screen.getByLabelText('Minimum balance to remind (Rs)')).toHaveValue('100.00');
    fireEvent.change(screen.getByLabelText('Days between reminders'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Minimum balance to remind (Rs)'), {
      target: { value: '250.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder schedule' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        branchId: 'branch',
        revision: 4,
        settings: { enabled: true, cadenceDays: 3, minBalanceMinor: 25_050 },
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Reminder schedule saved.');
  });

  it('lets the owner switch reminders off', async () => {
    render(<KhataReminderSettingsPanel branchId="branch" />);
    fireEvent.click(screen.getByLabelText('Send scheduled khata reminders from this branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder schedule' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        branchId: 'branch',
        revision: 4,
        settings: { enabled: false, cadenceDays: 7, minBalanceMinor: 10_000 },
      })
    );
  });

  it('keeps an invalid cadence for correction without saving', async () => {
    render(<KhataReminderSettingsPanel branchId="branch" />);
    fireEvent.change(screen.getByLabelText('Days between reminders'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder schedule' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Enter whole days from 1 to 30.');
    expect(screen.getByLabelText('Days between reminders')).toHaveValue(45);
    expect(screen.getByLabelText('Days between reminders')).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('disables edits when the schedule cannot be loaded', () => {
    mocks.query.isError = true;
    mocks.query.data = undefined;
    render(<KhataReminderSettingsPanel branchId="branch" />);
    expect(screen.getByRole('alert')).toHaveTextContent('The reminder schedule is unavailable');
    expect(screen.getByLabelText('Days between reminders')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save reminder schedule' })).toBeDisabled();
  });
});
