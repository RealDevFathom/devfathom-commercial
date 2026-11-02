import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspace: { data: undefined as unknown, isLoading: false, error: null },
  mutation: { mutateAsync: vi.fn(), isPending: false, error: null },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrescriptions: { workspace: { invalidate: vi.fn() } } }),
    pharmacyPrescriptions: {
      workspace: { useQuery: () => mocks.workspace },
      capture: { useMutation: () => mocks.mutation },
      uploadSource: { useMutation: () => mocks.mutation },
      captureRefillReminder: { useMutation: () => mocks.mutation },
    },
  },
}));

import { PrescriptionsConsole } from './prescriptions-console';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.data = {
    branches: [{ id: 'branch', name: 'Main branch' }],
    selectedBranchId: 'branch',
    canDispense: true,
    patients: [],
    prescribers: [],
    medicines: [
      {
        id: 'amoxicillin',
        productName: 'Amoxicillin 500mg',
        presentations: [{ id: 'capsule', presentation: 'Capsule' }],
      },
      { id: 'cetirizine', productName: 'Cetirizine 10mg', presentations: [] },
      { id: 'paracetamol', productName: 'Paracetamol 500mg', presentations: [] },
    ],
    reminderCaptures: [],
    prescriptions: [],
  };
});
afterEach(cleanup);

describe('capture medicine-name search', () => {
  it('matches names without case or surrounding spaces, explains no matches, and clears', () => {
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });
    const medicine = form.getByRole('combobox', { name: 'Medicine' });

    fireEvent.change(search, { target: { value: ' AMOX ' } });
    expect(within(medicine).getByRole('option', { name: 'Amoxicillin 500mg' })).toBeInTheDocument();
    expect(within(medicine).queryByRole('option', { name: 'Cetirizine 10mg' })).toBeNull();
    expect(within(medicine).queryByRole('option', { name: 'Paracetamol 500mg' })).toBeNull();
    expect(medicine).toHaveValue('');

    fireEvent.change(search, { target: { value: 'unlisted medicine' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(search).toHaveAttribute('aria-describedby', 'capture-medicine-search-empty');
    expect(within(medicine).getAllByRole('option')).toHaveLength(1);
    expect(medicine).toHaveValue('');

    fireEvent.change(search, { target: { value: '' } });
    expect(within(medicine).getAllByRole('option')).toHaveLength(4);
    expect(form.queryByText(/No medicines match/)).toBeNull();
    expect(search).not.toHaveAttribute('aria-describedby');
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the selected medicine and line details when the name filter excludes it', () => {
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });
    const medicine = form.getByRole('combobox', { name: 'Medicine' });
    const presentation = form.getByRole('combobox', { name: 'Presentation' });
    const quantity = form.getByRole('spinbutton', { name: 'Authorized units' });
    const directions = form.getByRole('textbox', { name: 'Directions' });
    fireEvent.change(medicine, { target: { value: 'amoxicillin' } });
    fireEvent.change(presentation, { target: { value: 'capsule' } });
    fireEvent.change(quantity, { target: { value: '12' } });
    fireEvent.change(directions, { target: { value: 'One capsule every 8 hours' } });

    fireEvent.change(search, { target: { value: 'cetir' } });
    expect(medicine).toHaveValue('amoxicillin');
    expect(within(medicine).getByRole('option', { name: 'Amoxicillin 500mg' })).toBeInTheDocument();
    expect(within(medicine).getByRole('option', { name: 'Cetirizine 10mg' })).toBeInTheDocument();
    expect(within(medicine).queryByRole('option', { name: 'Paracetamol 500mg' })).toBeNull();
    expect(presentation).toHaveValue('capsule');
    expect(quantity).toHaveValue(12);
    expect(directions).toHaveValue('One capsule every 8 hours');

    fireEvent.change(search, { target: { value: 'unlisted medicine' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(medicine).toHaveValue('amoxicillin');
    expect(presentation).toHaveValue('capsule');
    expect(quantity).toHaveValue(12);
    expect(directions).toHaveValue('One capsule every 8 hours');

    fireEvent.change(search, { target: { value: '' } });
    expect(within(medicine).getAllByRole('option', { name: 'Amoxicillin 500mg' })).toHaveLength(1);
    expect(medicine).toHaveValue('amoxicillin');
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows no no-match message for an empty catalog until a search is typed', () => {
    (mocks.workspace.data as { medicines: unknown[] }).medicines = [];
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });

    expect(search).toHaveValue('');
    expect(form.queryByText(/No medicines match/)).toBeNull();
    expect(search).not.toHaveAttribute('aria-describedby');

    fireEvent.change(search, { target: { value: 'amox' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(search).toHaveAttribute('aria-describedby', 'capture-medicine-search-empty');
  });
});
