import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Match = {
  referenceId: string;
  fileName: string;
  inCatalogue: boolean;
  values: Record<string, string | boolean>;
};

const mocks = vi.hoisted(() => ({
  access: { data: { canEdit: true } as { canEdit: boolean } | undefined, isPending: false },
  lookup: {
    data: { hasReferenceData: true, matches: [] as Match[] } as
      { hasReferenceData: boolean; matches: Match[] } | undefined,
    isPending: false,
    isFetching: false,
    error: null as { message: string } | null,
  },
  searchInputs: [] as unknown[],
  searchOptions: [] as unknown[],
  mutate: vi.fn(),
  invalidate: vi.fn(),
  onSuccess: undefined as ((medicine: { productName: string }) => Promise<void>) | undefined,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: { referenceCandidates: { invalidate: mocks.invalidate } },
    }),
    pharmacyMedicine: {
      catalogueQueueAccess: { useQuery: () => mocks.access },
      drapReferenceSearch: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.searchInputs.push(input);
          mocks.searchOptions.push(options);
          return mocks.lookup;
        },
      },
      addMedicineDraft: {
        useMutation: (options: { onSuccess: (m: { productName: string }) => Promise<void> }) => {
          mocks.onSuccess = options.onSuccess;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
    },
  },
}));

import { AddMedicineForm } from './add-medicine-form';

// Synthetic DRAP-shaped fixtures only.
const synthamol: Match = {
  referenceId: 'ref-1',
  fileName: 'synthetic-drap.csv',
  inCatalogue: false,
  values: {
    productName: 'Synthamol',
    strength: '500 mg',
    dosageForm: 'Tablet',
    drapRegistrationNumber: 'SYN-0001',
    rx: true,
    controlled: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access = { data: { canEdit: true }, isPending: false };
  mocks.lookup = {
    data: { hasReferenceData: true, matches: [] },
    isPending: false,
    isFetching: false,
    error: null,
  };
  mocks.searchInputs = [];
  mocks.searchOptions = [];
});
afterEach(cleanup);

function field(name: string) {
  return screen.getByRole('textbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement;
}

function choice(group: 'Prescription only' | 'Controlled drug', answer: 'Yes' | 'No') {
  return within(screen.getByRole('group', { name: group })).getByRole('radio', { name: answer });
}

function search() {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'synth' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('DEV-683 add-medicine DRAP auto-fill', () => {
  it('says plainly when no DRAP data was uploaded and still lets a person enter a medicine', () => {
    mocks.lookup.data = { hasReferenceData: false, matches: [] };
    render(<AddMedicineForm />);
    expect(screen.getByText(/No DRAP reference data has been uploaded/)).toBeVisible();
    expect(screen.queryByRole('search')).toBeNull();
    fireEvent.change(field('New medicine name'), { target: { value: 'Typed medicine' } });
    fireEvent.change(field('Strength'), { target: { value: '250 mg' } });
    fireEvent.change(field('Dosage form'), { target: { value: 'Capsule' } });
    fireEvent.change(field('Pack'), { target: { value: '10 capsules' } });
    fireEvent.change(field('DRAP registration number'), { target: { value: 'SYN-0100' } });
    // Neither flag is preselected: saving waits for an explicit answer to both.
    expect(choice('Prescription only', 'Yes')).not.toBeChecked();
    expect(choice('Prescription only', 'No')).not.toBeChecked();
    fireEvent.click(choice('Prescription only', 'Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Controlled drug' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    fireEvent.click(choice('Controlled drug', 'No'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      productName: 'Typed medicine',
      strength: '250 mg',
      dosageForm: 'Capsule',
      pack: '10 capsules',
      drapRegistrationNumber: 'SYN-0100',
      rx: true,
      controlled: false,
    });
  });

  it('pre-fills an unsaved draft from a DRAP row and saves only when the person confirms', async () => {
    mocks.lookup.data = { hasReferenceData: true, matches: [synthamol] };
    render(<AddMedicineForm />);
    search();
    expect(mocks.searchInputs.at(-1)).toEqual({ query: 'synth' });
    const matches = screen.getByRole('list', { name: 'DRAP reference matches' });
    expect(within(matches).getByText(/Prescription only · Controlled/)).toBeVisible();
    fireEvent.click(within(matches).getByRole('button', { name: 'Use Synthamol' }));

    expect(screen.getByText('Unsaved draft')).toBeVisible();
    expect(screen.getByText(/Prices are never filled/)).toBeVisible();
    expect(field('New medicine name').value).toBe('Synthamol');
    expect(field('Strength').value).toBe('500 mg');
    expect(field('Dosage form').value).toBe('Tablet');
    expect(field('Pack').value).toBe('');
    expect(field('DRAP registration number')).toHaveAttribute('readonly');
    expect(choice('Prescription only', 'Yes')).toBeChecked();
    expect(choice('Prescription only', 'No')).toBeDisabled();
    expect(choice('Controlled drug', 'Yes')).toBeChecked();
    expect(choice('Controlled drug', 'No')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    // Pack is required before the draft can be confirmed.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(field('Pack')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Pack is required.')).toBeVisible();

    fireEvent.change(field('Pack'), { target: { value: '10 tablets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const sent = mocks.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      pack: '10 tablets',
      drapRegistrationNumber: 'SYN-0001',
      rx: true,
      controlled: true,
      drapReferenceId: 'ref-1',
    });
    expect(Object.keys(sent).some((key) => /price|mrp/i.test(key))).toBe(false);

    await mocks.onSuccess?.({ productName: 'Synthamol' });
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it('does not offer a DRAP row whose registration is already in the catalogue', () => {
    mocks.lookup.data = {
      hasReferenceData: true,
      matches: [{ ...synthamol, inCatalogue: true }],
    };
    render(<AddMedicineForm />);
    search();
    expect(screen.getByText('Already in catalogue')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use Synthamol' })).toBeNull();
  });

  it('clears the auto-fill and unlocks the flags', () => {
    mocks.lookup.data = { hasReferenceData: true, matches: [synthamol] };
    render(<AddMedicineForm />);
    search();
    fireEvent.click(screen.getByRole('button', { name: 'Use Synthamol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear auto-fill' }));
    expect(screen.queryByText('Unsaved draft')).toBeNull();
    expect(field('New medicine name').value).toBe('');
    expect(choice('Prescription only', 'Yes')).toBeEnabled();
    expect(choice('Prescription only', 'Yes')).not.toBeChecked();
  });

  it('asks the person to choose a flag the DRAP row does not state, with nothing preselected', () => {
    const { controlled: _unstated, ...values } = synthamol.values;
    void _unstated;
    mocks.lookup.data = { hasReferenceData: true, matches: [{ ...synthamol, values }] };
    render(<AddMedicineForm />);
    search();
    expect(screen.getByText(/Controlled status not stated/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Use Synthamol' }));
    const controlled = screen.getByRole('group', { name: 'Controlled drug' });
    expect(within(controlled).getByText(/Not stated in the DRAP reference/)).toBeVisible();
    expect(choice('Controlled drug', 'Yes')).toBeEnabled();
    expect(choice('Controlled drug', 'Yes')).not.toBeChecked();
    expect(choice('Controlled drug', 'No')).not.toBeChecked();
    // The stated flag stays locked.
    expect(choice('Prescription only', 'Yes')).toBeChecked();
    expect(choice('Prescription only', 'No')).toBeDisabled();

    fireEvent.change(field('Pack'), { target: { value: '10 tablets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(within(controlled).getByText('Choose yes or no.')).toBeVisible();

    fireEvent.click(choice('Controlled drug', 'No'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save draft' }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ rx: true, controlled: false, drapReferenceId: 'ref-1' })
    );
  });

  it('hides reference data from a member without catalogue-edit rights', () => {
    mocks.access = { data: { canEdit: false }, isPending: false };
    render(<AddMedicineForm />);
    expect(screen.getByText(/needs the catalogue edit permission/)).toBeVisible();
    expect(screen.queryByRole('form')).toBeNull();
    expect(mocks.searchOptions.at(-1)).toMatchObject({ enabled: false });
  });
});
