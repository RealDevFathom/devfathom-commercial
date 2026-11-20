import { selectFieldControl } from '@/lib/testing/select-field';
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
  barcodeMutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
  onBarcodeSaved: undefined as ((row: { code: string }) => Promise<void>) | undefined,
  invalidateMedicine: vi.fn(),
  onSuccess: undefined as ((row: { id: string; status?: string }) => Promise<void>) | undefined,
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
        useMutation: (options: {
          onSuccess: (row: { id: string; status?: string }) => Promise<void>;
        }) => {
          mocks.onSuccess = options.onSuccess;
          return mocks.mutation;
        },
      },
      setPackBarcode: {
        useMutation: (options: { onSuccess: (row: { code: string }) => Promise<void> }) => {
          mocks.onBarcodeSaved = options.onSuccess;
          return mocks.barcodeMutation;
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
        packLevels: [],
      },
    ],
  };
  mocks.search.error = mocks.medicine.error = mocks.mutation.error = null;
  mocks.barcodeMutation.error = null;
  mocks.search.isFetching = mocks.medicine.isFetching = mocks.mutation.isPending = false;
  mocks.barcodeMutation.isPending = false;
});
afterEach(cleanup);

function fill() {
  fireEvent.change(selectFieldControl(screen.getByLabelText('Medicine', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'medicine-secret' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Presentation', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'presentation-secret' },
  });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Pack type', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'STRIP' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText(/Individual units per pack/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '10' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText(/Effective from/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '2026-09-06' } });
}

describe('medicine pack setup', () => {
  it('repeats the same search after publication instead of keeping an empty result', () => {
    mocks.search.data = [];
    render(<MedicinePackSetup />);
    fireEvent.change(selectFieldControl(screen.getByLabelText('Find a medicine', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Paracetamol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }));
    expect(mocks.search.refetch).toHaveBeenCalledOnce();
  });

  it('selects readable medicine/presentation labels and invokes the existing pack procedure', () => {
    render(<MedicinePackSetup />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Medicine' }), { key: 'ArrowDown' });
    expect(
      screen.getByRole('option', { name: 'Paracetamol — Panadol — 500 mg — GSK' })
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fill();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Presentation' }), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Tablet — 10 tablets' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Create pack' }));
    expect(mocks.mutation.mutate).toHaveBeenCalledExactlyOnceWith({
      presentationId: 'presentation-secret',
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-09-06T00:00:00+05:00'),
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
    fireEvent.change(selectFieldControl(screen.getByLabelText('Pack type', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'UNIT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pack' }));
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('exactly 1');
    expect(selectFieldControl(screen.getByLabelText(/Individual units per pack/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(10);
    expect(screen.getByLabelText(/Individual units per pack/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute(
      'aria-invalid',
      'true'
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
      expect(selectFieldControl(screen.getByLabelText(/Individual units per pack/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(10);
      expect(selectFieldControl(screen.getByLabelText('Presentation', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('presentation-secret');
      expect(selectFieldControl(screen.getByLabelText(/Effective from/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2026-09-06');
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
    expect(screen.getByLabelText('Medicine', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
    await mocks.onSuccess?.({ id: 'pack-created' });
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
    fireEvent.change(selectFieldControl(screen.getByLabelText('Find a medicine', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Missing' } });
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
              barcodes: [],
            },
            {
              id: 'later',
              level: 'BOX',
              unitsPerParent: 100,
              parentPackLevelId: null,
              effectiveFrom: new Date('2099-01-01'),
              effectiveTo: null,
              barcodes: [],
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
  function publishedPack(barcodes: Array<{ code: string }>) {
    mocks.medicine.data = {
      presentations: [
        {
          id: 'presentation-secret',
          dosageForm: 'Tablet',
          presentation: '10 tablets',
          packLevels: [
            {
              id: 'default-pack',
              level: 'BOX',
              unitsPerParent: 10,
              parentPackLevelId: null,
              effectiveFrom: new Date('2020-01-01'),
              effectiveTo: null,
              barcodes,
            },
          ],
        },
      ],
    };
  }

  it('attaches a barcode to the published default pack', async () => {
    publishedPack([]);
    render(<MedicinePackSetup />);
    fill();
    expect(screen.getByText(/No barcode yet/)).toBeVisible();
    const input = screen.getByLabelText('Barcode for 1 BOX = 10 units', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(screen.getByRole('button', { name: 'Attach barcode' })).toBeDisabled();
    fireEvent.change(selectFieldControl(input), { target: { value: ' 8964000123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach barcode' }));
    expect(mocks.barcodeMutation.mutate).toHaveBeenCalledExactlyOnceWith({
      packLevelId: 'default-pack',
      code: '8964000123456',
    });
    await mocks.onBarcodeSaved?.({ code: '8964000123456' });
    await waitFor(() =>
      expect(screen.getByText('Barcode 8964000123456 saved on this pack.')).toBeVisible()
    );
    expect(mocks.invalidateMedicine).toHaveBeenCalledWith({ id: 'medicine-secret' });
  });

  it('keeps the entry after an attach conflict', () => {
    publishedPack([]);
    const view = render(<MedicinePackSetup />);
    fill();
    const input = screen.getByLabelText('Barcode for 1 BOX = 10 units', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.change(selectFieldControl(input), { target: { value: '2222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach barcode' }));
    expect(mocks.barcodeMutation.mutate).toHaveBeenCalledExactlyOnceWith({
      packLevelId: 'default-pack',
      code: '2222',
    });
    mocks.barcodeMutation.error = {
      message: 'This barcode is already assigned to another pack.',
      data: { code: 'CONFLICT' },
    };
    view.rerender(<MedicinePackSetup />);
    expect(screen.getByRole('alert')).toHaveTextContent('already assigned to another pack');
    expect(selectFieldControl(screen.getByLabelText('Barcode for 1 BOX = 10 units', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2222');
  });

  it('shows every existing pack barcode read-only, since barcodes are append-only', () => {
    publishedPack([{ code: '1111' }, { code: '3333' }]);
    render(<MedicinePackSetup />);
    fill();
    expect(screen.getByText('Barcodes: 1111, 3333')).toBeVisible();
    expect(screen.getByText(/permanent once attached/)).toBeVisible();
    expect(screen.queryByLabelText('Barcode for 1 BOX = 10 units', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /barcode/i })).not.toBeInTheDocument();
  });

  function packRow(
    id: string,
    level: string,
    unitsPerParent: number,
    parentPackLevelId: string | null = null
  ) {
    return {
      id,
      level,
      unitsPerParent,
      parentPackLevelId,
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: null,
      barcodes: [] as Array<{ code: string }>,
    };
  }
  function withPacks(packLevels: ReturnType<typeof packRow>[]) {
    mocks.medicine.data = {
      presentations: [
        { id: 'presentation-secret', dosageForm: 'Tablet', presentation: '10 x 10', packLevels },
      ],
    };
  }
  function choosePresentation() {
    fireEvent.change(selectFieldControl(screen.getByLabelText('Medicine', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'medicine-secret' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Presentation', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'presentation-secret' },
    });
  }

  it('shows each pack ID next to its barcode', () => {
    withPacks([
      { ...packRow('pack_box_1', 'BOX', 100), barcodes: [{ code: '1111' }] },
      packRow('pack_strip_1', 'STRIP', 10),
    ]);
    render(<MedicinePackSetup />);
    choosePresentation();
    expect(screen.getByText('pack_box_1')).toBeVisible();
    expect(screen.getByText('pack_strip_1')).toBeVisible();
    expect(screen.getByText('Barcode: 1111')).toBeVisible();
    expect(selectFieldControl(screen.getByLabelText('Barcode for 1 STRIP = 10 units', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
  });

  it('creates independent side-by-side packs as before without a divisibility warning', () => {
    withPacks([packRow('box', 'BOX', 100), packRow('strip', 'STRIP', 30)]);
    render(<MedicinePackSetup />);
    fill();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create pack' }));
    expect(mocks.mutation.mutate).toHaveBeenCalledExactlyOnceWith({
      presentationId: 'presentation-secret',
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-09-06T00:00:00+05:00'),
      versionGroupId: expect.any(String),
    });
  });
});
