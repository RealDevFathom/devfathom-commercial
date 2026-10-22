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
  invalidatePurchasing: vi.fn(),
  onSuccess: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: { get: { invalidate: mocks.invalidateMedicine } },
      pharmacyPurchasing: { workspace: { invalidate: mocks.invalidatePurchasing } },
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
import { MedicinePackSetup } from '@/components/pharmacy/medicine-pack-setup';

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
        packLevels: [],
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
  fireEvent.change(screen.getByLabelText(/Individual units per pack/), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-09-06' } });
}

describe('WHA1223 independent UI adversarial probes', () => {
  it('clears selected presentation when changing medicine; cannot send old presentation', () => {
    const view = render(<MedicinePackSetup />); fill();
    mocks.search.data = [{id:'medicine-b', productName:'Other medicine', strengths:[]}];
    view.rerender(<MedicinePackSetup />);
    fireEvent.change(screen.getByLabelText('Medicine'), {target:{value:'medicine-b'}});
    expect(screen.getByLabelText('Presentation')).toHaveValue('');
    expect(screen.getByRole('button', {name:'Create pack'})).toBeDisabled();
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
  });
  it('rejects stale presentation absent from refetched medicine', () => {
    const view = render(<MedicinePackSetup />); fill();
    mocks.medicine.data = {presentations:[{id:'new-presentation', dosageForm:'Capsule', presentation:'20 capsules', packLevels:[]}]};
    view.rerender(<MedicinePackSetup />);
    expect(screen.getByRole('button', {name:'Create pack'})).toBeDisabled();
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
  });
  it('refetches whitespace-equivalent repeated search and clears old selection', () => {
    render(<MedicinePackSetup />); fill();
    fireEvent.change(screen.getByLabelText('Medicine name'), {target:{value:'Paracetamol'}});
    fireEvent.click(screen.getByRole('button', {name:'Find medicine'}));
    fireEvent.change(screen.getByLabelText('Medicine name'), {target:{value:'  Paracetamol  '}});
    fireEvent.click(screen.getByRole('button', {name:'Find medicine'}));
    expect(mocks.search.refetch).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Medicine')).toHaveValue('');
    expect(screen.getByLabelText('Presentation')).toHaveValue('');
  });
  it('preserves user values on failed detail refresh and blocks mutation', () => {
    const view=render(<MedicinePackSetup />); fill();
    mocks.medicine.error={message:'Offline',data:{code:'INTERNAL_SERVER_ERROR'}};
    view.rerender(<MedicinePackSetup />);
    expect(screen.getByLabelText(/Individual units per pack/)).toHaveValue(10);
    expect(screen.getByLabelText(/Effective from/)).toHaveValue('2026-09-06');
    expect(screen.getByRole('button',{name:'Create pack'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Retry loading'}));
    expect(mocks.medicine.refetch).toHaveBeenCalledOnce();
  });
});
