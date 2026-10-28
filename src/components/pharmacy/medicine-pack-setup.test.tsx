import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: {
    data: undefined as unknown,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  medicine: {
    data: undefined as unknown,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  mutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
  invalidateMedicine: vi.fn(),
  onSuccess: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: { get: { invalidate: mocks.invalidateMedicine } },
    }),
    pharmacyMedicine: {
      search: { useQuery: () => mocks.search },
      get: { useQuery: () => mocks.medicine },
      createPackLevel: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.onSuccess = options.onSuccess;
          return mocks.mutation;
        },
      },
    },
  },
}));
import { MedicinePackSetup } from './medicine-pack-setup';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.data = [
    {
      id: 'medicine-secret',
      productName: 'Paracetamol',
      brandName: 'Panadol',
      manufacturer: 'GSK',
      strengths: [{ value: '500', unit: 'mg' }],
    },
  ];
  mocks.medicine.data = {
    presentations: [
      {
        id: 'presentation-secret',
        dosageForm: 'Tablet',
        presentation: '10 tablets',
        packLevels: [
          {
            id: 'box-1',
            level: 'BOX',
            unitsPerParent: 1,
            parentPackLevelId: null,
            effectiveFrom: new Date('2026-01-01'),
            effectiveTo: null,
          },
        ],
      },
    ],
  };
  mocks.search.error = mocks.medicine.error = mocks.mutation.error = null;
  mocks.search.isFetching = mocks.medicine.isFetching = mocks.mutation.isPending = false;
});
afterEach(cleanup);

function fill() {
  fireEvent.change(screen.getByLabelText('Medicine'), { target: { value: 'medicine-secret' } });
  fireEvent.change(screen.getByLabelText('Presentation'), {
    target: { value: 'presentation-secret' },
  });
  fireEvent.change(screen.getByLabelText('Pack type'), { target: { value: 'STRIP' } });
  fireEvent.change(screen.getByLabelText('Inside'), { target: { value: 'box-1' } });
  fireEvent.change(screen.getByLabelText(/How many fit inside/), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-09-06' } });
}

describe('medicine pack setup', () => {
  it('repeats the same search after publication instead of keeping an empty result', () => {
    mocks.search.data = [];
    render(<MedicinePackSetup />);
    fireEvent.change(screen.getByLabelText('Medicine name'), { target: { value: 'Paracetamol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }));
    expect(mocks.search.refetch).toHaveBeenCalledOnce();
  });

  it('selects readable medicine/presentation labels and invokes the existing pack procedure', () => {
    render(<MedicinePackSetup />);
    expect(
      screen.getByRole('option', { name: 'Paracetamol — Panadol — 500 mg — GSK' })
    ).toBeVisible();
    fill();
    expect(screen.getByRole('option', { name: 'Tablet — 10 tablets' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create pack' }));
    expect(mocks.mutation.mutate).toHaveBeenCalledExactlyOnceWith({
      presentationId: 'presentation-secret',
      level: 'STRIP',
      parentPackLevelId: 'box-1',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-09-06T00:00:00Z'),
      versionGroupId: expect.any(String),
    });
    expect(screen.queryByText(/presentation-secret|medicine-secret/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to Pharmacy setup' })).toHaveAttribute(
      'href',
      '/pharmacy'
    );
  });

  it('keeps values and describes validation errors without submitting an invalid unit conversion', () => {
    render(<MedicinePackSetup />);
    fill();
    fireEvent.change(screen.getByLabelText(/How many fit inside/), { target: { value: '2.5' } });
    // Submit directly so the component validation runs even if native validation is bypassed.
    fireEvent.submit(screen.getByRole('button', { name: 'Create pack' }).closest('form')!);
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
    expect(screen.getByLabelText(/How many fit inside/)).toHaveValue(2.5);
    expect(screen.getByLabelText(/How many fit inside/)).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('creates the outer pack without a parent or count, then nests a unit inside it', () => {
    render(<MedicinePackSetup />);
    fill();
    fireEvent.change(screen.getByLabelText('Inside'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Pack type'), { target: { value: 'BOX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pack' }));
    expect(mocks.mutation.mutate).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ parentPackLevelId: expect.anything() })
    );
    expect(mocks.mutation.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ level: 'BOX', unitsPerParent: 1 })
    );
  });

  it.each(['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'])(
    'preserves entries after %s from the server',
    (code) => {
      const view = render(<MedicinePackSetup />);
      fill();
      mocks.mutation.error = { message: 'Pack was not created.', data: { code } };
      view.rerender(<MedicinePackSetup />);
      expect(screen.getByRole('alert')).toHaveTextContent(/entries are preserved/);
      expect(screen.getByLabelText(/How many fit inside/)).toHaveValue(10);
      expect(screen.getByLabelText('Presentation')).toHaveValue('presentation-secret');
      expect(screen.getByLabelText(/Effective from/)).toHaveValue('2026-09-06');
      if (code !== 'BAD_REQUEST')
        expect(screen.getByRole('button', { name: 'Create pack' })).toBeDisabled();
    }
  );

  it('disables repeat submission while pending and refreshes the medicine after success', async () => {
    const view = render(<MedicinePackSetup />);
    fill();
    mocks.mutation.isPending = true;
    view.rerender(<MedicinePackSetup />);
    expect(screen.getByRole('button', { name: 'Creating pack…' })).toBeDisabled();
    expect(screen.getByLabelText('Medicine')).toBeDisabled();
    await mocks.onSuccess?.();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Pack created'));
    expect(mocks.invalidateMedicine).toHaveBeenCalledWith({ id: 'medicine-secret' });
  });

  it('provides loading, no-result and retry states', () => {
    mocks.search.data = [];
    mocks.search.isFetching = true;
    const view = render(<MedicinePackSetup />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading medicine');
    mocks.search.isFetching = false;
    view.rerender(<MedicinePackSetup />);
    fireEvent.change(screen.getByLabelText('Medicine name'), { target: { value: 'Missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }));
    expect(screen.getByText(/No saleable medicines match/)).toBeVisible();
    mocks.search.error = { message: 'Try again', data: { code: 'INTERNAL_SERVER_ERROR' } };
    view.rerender(<MedicinePackSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(mocks.search.refetch).toHaveBeenCalledOnce();
  });

  it('shows only effective packs using the same conversion function as receiving', () => {
    mocks.medicine.data = {
      presentations: [
        {
          id: 'presentation-secret',
          dosageForm: 'Tablet',
          presentation: '10 tablets',
          packLevels: [
            {
              id: 'now',
              level: 'STRIP',
              unitsPerParent: 10,
              parentPackLevelId: null,
              effectiveFrom: new Date('2020-01-01'),
              effectiveTo: null,
            },
            {
              id: 'unit',
              level: 'UNIT',
              unitsPerParent: 10,
              parentPackLevelId: 'now',
              effectiveFrom: new Date('2020-01-01'),
              effectiveTo: null,
            },
            {
              id: 'later',
              level: 'BOX',
              unitsPerParent: 100,
              parentPackLevelId: null,
              effectiveFrom: new Date('2099-01-01'),
              effectiveTo: null,
            },
          ],
        },
      ],
    };
    render(<MedicinePackSetup />);
    fill();
    expect(screen.getByText('1 STRIP = 10 units')).toBeVisible();
    expect(screen.queryByText('1 BOX = 100 units')).not.toBeInTheDocument();
  });
});
