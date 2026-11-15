import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoyaltySettingsForm } from './settings-form';
import { saveLoyaltySettings } from './actions';
vi.mock('./actions', () => ({ saveLoyaltySettings: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('owner earning setup', () => {
  it('requires an explicit choice and reconciliation approval without inventing defaults', () => {
    render(<LoyaltySettingsForm digest={'a'.repeat(64)} migrated={false} />);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Khata/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /reviewed/ })).toBeRequired();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'step-custom' } });
    expect(screen.getByLabelText('Points per step')).toBeRequired();
    expect(screen.getByLabelText('Spend per step (PKR)')).toBeRequired();
  });
  it('shows pending and error states while preserving the selected rate', async () => {
    let resolve!: (state: { message: string; saved: boolean }) => void;
    vi.mocked(saveLoyaltySettings).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    render(<LoyaltySettingsForm digest={'a'.repeat(64)} migrated />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'percent-custom' } });
    fireEvent.change(screen.getByLabelText('Percentage of spend'), { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /approve/ }));
    fireEvent.submit(screen.getByRole('button').closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled());
    resolve({ message: 'Balances changed. Review again.', saved: false });
    await screen.findByRole('alert');
    expect(screen.getByRole('combobox')).toHaveValue('percent-custom');
    expect(screen.getByLabelText('Percentage of spend')).toHaveValue(1.25);
  });
});

it('preserves the existing owner Khata switch when selecting a new rate', () => {
  render(<LoyaltySettingsForm digest={'a'.repeat(64)} migrated khataEnabled />);
  expect(screen.getByRole('checkbox', { name: /Khata/ })).toBeChecked();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'percent-2' } });
  expect(screen.getByRole('checkbox', { name: /Khata/ })).toBeChecked();
});
