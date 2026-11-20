import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyPackLabel: {
      read: { useMutation: () => ({ mutateAsync: h.mutateAsync, isPending: false }) },
    },
  },
}));

import { PackPhotoReader } from './pack-photo-reader';

const PROPOSAL = {
  status: 'PROPOSED',
  requiresReceiverConfirmation: true,
  adapter: 'FIXTURE',
  adapterVersion: 'test',
  batch: { value: 'SYN-B2741', confidence: 0.93 },
  expiry: {
    kind: 'read',
    printed: 'EXP 06/2028',
    candidate: { date: '2028-06-30', precision: 'MONTH' },
    confidence: 0.9,
  },
  serialPrinted: false,
  warnings: [],
};

type Location = { id: string; label: string };
type HarnessOptions = {
  /** Locations offered to the reader. */
  locations?: Location[];
  defaultLocationId?: string | null;
  /** Initial values of the main line's capture fields (keyed by field prefix). */
  line?: Partial<Record<string, string>>;
  /** Hidden GS1 payload already on the line (as after a 2D scan). */
  gs1Payload?: string;
  serialLocked?: boolean;
  siblings?: { key: string; batch: string; packs: string }[];
};

const TWO_LOCATIONS: Location[] = [
  { id: 'loc-a', label: 'Front shelf' },
  { id: 'loc-b', label: 'Cold room' },
];

function harness(options: HarnessOptions = {}) {
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  const locations = options.locations ?? [{ id: 'loc-a', label: 'Front shelf' }];
  const defaultLocationId =
    options.defaultLocationId === undefined ? 'loc-a' : options.defaultLocationId;
  const line = options.line ?? {};
  const siblings = options.siblings ?? [];
  const view = render(
    <form data-testid="receipt" onSubmit={(event) => onSubmit(event.nativeEvent)}>
      <input name="batchNumber:pol-1" defaultValue={line.batchNumber ?? ''} />
      <input name="printedExpiry:pol-1" type="date" defaultValue={line.printedExpiry ?? ''} />
      <select name="expiryPrecision:pol-1" defaultValue={line.expiryPrecision ?? 'MONTH'}>
        <option value="MONTH">Month</option>
        <option value="DAY">Day</option>
      </select>
      <input name="receivedPacks:pol-1" defaultValue={line.receivedPacks ?? ''} />
      <input name="printedMrp:pol-1" defaultValue={line.printedMrp ?? ''} />
      <input name="serialNumber:pol-1" defaultValue={line.serialNumber ?? ''} />
      {options.gs1Payload !== undefined ? (
        <input name="gs1Payload:pol-1" type="hidden" defaultValue={options.gs1Payload} />
      ) : null}
      <select
        name="stockLocation:pol-1"
        defaultValue={line.stockLocation ?? defaultLocationId ?? ''}
      >
        {locations.length ? (
          locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.label}
            </option>
          ))
        ) : (
          <option value="">No location</option>
        )}
      </select>
      {siblings.map((sibling) => (
        <fieldset key={sibling.key}>
          <input name={`batchNumber:${sibling.key}`} defaultValue={sibling.batch} />
          <input name={`receivedPacks:${sibling.key}`} defaultValue={sibling.packs} />
        </fieldset>
      ))}
      <PackPhotoReader
        branchId="branch-a"
        defaultLocationId={defaultLocationId}
        fieldKey="pol-1"
        locations={locations}
        lotLabel="Lot 1"
        medicineName="Synthetic 500 mg"
        outstandingPacks={10}
        packLevel="STRIP"
        purchaseOrderId="po-1"
        purchaseOrderLineId="pol-1"
        serialLocked={options.serialLocked}
        siblingFieldKeys={siblings.length ? siblings.map((sibling) => sibling.key) : undefined}
        unitsPerPack={10}
      />
    </form>
  );
  const receipt = view.getByTestId('receipt') as HTMLFormElement;
  /** Current value of a receipt capture field for the main line. */
  const lineValue = (name: string) =>
    (receipt.elements.namedItem(`${name}:pol-1`) as HTMLInputElement | HTMLSelectElement).value;
  return { ...view, onSubmit, receipt, lineValue };
}

const photo = () => new File([new Uint8Array([1, 2, 3])], 'pack.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  h.mutateAsync.mockReset();
  // jsdom cannot decode images; model a device that re-encodes successfully.
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 40, height: 20, close: vi.fn() }))
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' }));
  };
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

async function openAndRead(
  ready: () => Promise<unknown> = () => screen.findByDisplayValue('SYN-B2741')
) {
  fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
  await act(async () => {
    fireEvent.change(selectFieldControl(screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { files: [photo()] },
    });
  });
  await ready();
}

const packsField = () => screen.getByLabelText('Packs with this exact batch and expiry', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
const confirmBox = () =>
  screen.getByLabelText(/I checked this batch and expiry/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
const applyButton = () => screen.getByRole('button', { name: 'Use for lot 1' });

/** Type a count, tick the confirmation and press "Use for lot 1". */
function countConfirmApply(packs: string) {
  fireEvent.change(selectFieldControl(packsField()), { target: { value: packs } });
  if (!confirmBox().checked) fireEvent.click(confirmBox());
  fireEvent.click(applyButton());
}

const ONE_AT_A_TIME = /one at a time/;

describe('PackPhotoReader', () => {
  it('sends only a re-encoded JPEG for the chosen line, never the original file', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    harness();
    await openAndRead();
    expect(h.mutateAsync).toHaveBeenCalledWith({
      branchId: 'branch-a',
      purchaseOrderId: 'po-1',
      purchaseOrderLineId: 'pol-1',
      photo: { contentType: 'image/jpeg', dataBase64: 'CQkJ' },
    });
  });

  it('keeps its controls out of the receipt form: Enter never files the receipt', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { onSubmit, getByTestId } = harness();
    await openAndRead();
    const batch = screen.getByLabelText('Batch number', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    const receipt = getByTestId('receipt') as HTMLFormElement;
    expect((batch as HTMLInputElement).form).not.toBe(receipt);
    expect(receipt.contains(batch)).toBe(true);
    fireEvent.submit((batch as HTMLInputElement).form!);
    expect(onSubmit).not.toHaveBeenCalled();
    // An invalid count inside the reader cannot block the receipt's own validity.
    fireEvent.change(selectFieldControl(screen.getByLabelText('Packs with this exact batch and expiry', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '-4' },
    });
    expect(receipt.checkValidity()).toBe(true);
  });

  it('fills the line only after an explicit count and confirmation', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { getByTestId } = harness();
    await openAndRead();
    const receipt = getByTestId('receipt') as HTMLFormElement;
    fireEvent.click(screen.getByRole('button', { name: 'Use for lot 1' }));
    expect((receipt.elements.namedItem('batchNumber:pol-1') as HTMLInputElement).value).toBe('');

    fireEvent.change(selectFieldControl(screen.getByLabelText('Packs with this exact batch and expiry', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByLabelText(/I checked this batch and expiry/, { selector: ':not([data-select-field-native][aria-hidden="true"])' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use for lot 1' }));
    const value = (name: string) =>
      (receipt.elements.namedItem(`${name}:pol-1`) as HTMLInputElement).value;
    expect([value('batchNumber'), value('printedExpiry'), value('expiryPrecision')]).toEqual([
      'SYN-B2741',
      '2028-06-30',
      'MONTH',
    ]);
    expect(value('receivedPacks')).toBe('7');
    expect(value('stockLocation')).toBe('loc-a');
    expect(screen.getByRole('status')).toHaveTextContent('Nothing is in stock yet');
    expect(document.activeElement).toBe(receipt.elements.namedItem('batchNumber:pol-1'));
  });

  it('does not spend a read when closed while the device is still encoding', async () => {
    let finishEncode!: () => void;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finishEncode = () => resolve({ width: 40, height: 20, close: vi.fn() });
          })
      )
    );
    harness();
    fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
    fireEvent.change(selectFieldControl(screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { files: [photo()] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => finishEncode());
    await waitFor(() => expect(h.mutateAsync).not.toHaveBeenCalled());
  });

  it('fails closed, without uploading the original, when the device cannot re-encode', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed');
      })
    );
    harness();
    fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
    await act(async () => {
      fireEvent.change(selectFieldControl(screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
        target: { files: [photo()] },
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'enter the batch and expiry by hand'
    );
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('keeps manual entry usable when the read fails', async () => {
    h.mutateAsync.mockRejectedValue(
      new Error('The pack photo could not be read. Enter the batch and expiry by hand.')
    );
    const { getByTestId } = harness();
    fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
    await act(async () => {
      fireEvent.change(selectFieldControl(screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
        target: { files: [photo()] },
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    const batch = (getByTestId('receipt') as HTMLFormElement).elements.namedItem(
      'batchNumber:pol-1'
    ) as HTMLInputElement;
    fireEvent.change(selectFieldControl(batch), { target: { value: 'TYPED-1' } });
    expect(batch.value).toBe('TYPED-1');
  });
});

const AMBIGUOUS = {
  ...PROPOSAL,
  expiry: {
    kind: 'ambiguous',
    printed: 'EXP 03/04/2028',
    candidates: [
      { date: '2028-04-03', precision: 'DAY' },
      { date: '2028-03-04', precision: 'DAY' },
    ],
    confidence: 0.88,
  },
  warnings: [
    {
      code: 'EXPIRY_AMBIGUOUS',
      message:
        'The printed expiry could be read as day-month or month-day. Choose the date that matches the pack.',
    },
  ],
};

const UNREADABLE = {
  ...PROPOSAL,
  batch: { value: null, confidence: 0 },
  expiry: { kind: 'unreadable', printed: null, confidence: 0 },
  warnings: [
    {
      code: 'BATCH_UNREADABLE',
      message: 'The batch number could not be read clearly from the photo. Type it from the pack.',
    },
    {
      code: 'EXPIRY_UNREADABLE',
      message: 'The expiry could not be read as one clear date. Type it from the pack.',
    },
  ],
};

const SERIALIZED = {
  ...PROPOSAL,
  serialPrinted: true,
  warnings: [
    {
      code: 'SERIAL_PRINTED',
      message:
        "This pack prints its own serial number. Serialized packs must be received one pack at a time by scanning each pack's 2D code, and a serial is never copied from one pack to another.",
    },
  ],
};

describe('PackPhotoReader capture input', () => {
  it('opens the rear camera and accepts only JPEG, PNG and WebP', () => {
    harness();
    fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
    const input = screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.getAttribute('capture')).toBe('environment');
    expect(input.accept.split(',')).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('sends nothing and leaves the line alone when the capture is cancelled', async () => {
    const createImageBitmap = vi.fn(async () => ({ width: 40, height: 20, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const { lineValue } = harness({
      line: {
        batchNumber: 'HAND-7',
        printedExpiry: '2029-01-31',
        expiryPrecision: 'DAY',
        receivedPacks: '3',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
    await act(async () => {
      fireEvent.change(selectFieldControl(screen.getByLabelText('Photo of one pack', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { files: [] } });
    });
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByLabelText('Batch number', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeNull();
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('expiryPrecision'),
      lineValue('receivedPacks'),
      lineValue('stockLocation'),
    ]).toEqual(['HAND-7', '2029-01-31', 'DAY', '3', 'loc-a']);
  });
});

describe('PackPhotoReader review of uncertain reads', () => {
  it('makes the receiver choose between two readings of an ambiguous expiry', async () => {
    h.mutateAsync.mockResolvedValue(AMBIGUOUS);
    const { lineValue } = harness();
    await openAndRead();
    const expiry = screen.getByLabelText('Printed expiry', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    const precision = screen.getByLabelText('Expiry precision', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLSelectElement;
    expect(expiry.value).toBe('');
    expect(selectFieldControl(precision).value).toBe('');
    expect(screen.getByText(/could be read as day-month or month-day/)).toBeInTheDocument();
    const first = screen.getByRole('radio', { name: '2028-04-03' }) as HTMLInputElement;
    const second = screen.getByRole('radio', { name: '2028-03-04' }) as HTMLInputElement;
    expect([first.checked, second.checked]).toEqual([false, false]);

    countConfirmApply('7');
    expect(screen.getByText('Enter the printed expiry date.')).toBeInTheDocument();
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('receivedPacks'),
    ]).toEqual(['', '', '']);

    fireEvent.click(second);
    expect(expiry.value).toBe('2028-03-04');
    expect(selectFieldControl(precision).value).toBe('DAY');
    expect(second.checked).toBe(true);
    // Choosing a reading is an edit, so the earlier confirmation no longer counts.
    expect(confirmBox().checked).toBe(false);

    countConfirmApply('7');
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('expiryPrecision'),
      lineValue('receivedPacks'),
    ]).toEqual(['SYN-B2741', '2028-03-04', 'DAY', '7']);
  });

  it('invents nothing for an unreadable label and waits for typed batch, date and precision', async () => {
    h.mutateAsync.mockResolvedValue(UNREADABLE);
    const { lineValue } = harness();
    await openAndRead(() => screen.findByText(/batch number could not be read clearly/));
    expect(screen.getByText(/expiry could not be read as one clear date/)).toBeInTheDocument();
    const batch = screen.getByLabelText('Batch number', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    const expiry = screen.getByLabelText('Printed expiry', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    const precision = screen.getByLabelText('Expiry precision', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLSelectElement;
    expect([batch.value, expiry.value, selectFieldControl(precision).value]).toEqual(['', '', '']);
    expect(
      screen.getByText('Not readable on the photo. Type it from the pack.')
    ).toBeInTheDocument();
    expect(screen.getByText(/No expiry was readable/)).toBeInTheDocument();

    countConfirmApply('4');
    expect(lineValue('batchNumber')).toBe('');
    expect(screen.getByText('Type the batch number printed on the pack.')).toBeInTheDocument();

    fireEvent.change(selectFieldControl(batch), { target: { value: 'SYN-HAND-9' } });
    countConfirmApply('4');
    expect(lineValue('batchNumber')).toBe('');
    expect(screen.getByText('Enter the printed expiry date.')).toBeInTheDocument();

    fireEvent.change(selectFieldControl(expiry), { target: { value: '2028-09-15' } });
    countConfirmApply('4');
    expect(lineValue('batchNumber')).toBe('');
    expect(
      screen.getByText(/Choose whether the pack prints a month or an exact day/)
    ).toBeInTheDocument();

    fireEvent.change(selectFieldControl(precision), { target: { value: 'DAY' } });
    countConfirmApply('4');
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('expiryPrecision'),
      lineValue('receivedPacks'),
    ]).toEqual(['SYN-HAND-9', '2028-09-15', 'DAY', '4']);
  });

  it('files the receiver’s corrected batch and drops a confirmation given before the edit', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness();
    await openAndRead();
    fireEvent.change(selectFieldControl(packsField()), { target: { value: '2' } });
    fireEvent.click(confirmBox());
    expect(confirmBox().checked).toBe(true);

    fireEvent.change(selectFieldControl(screen.getByLabelText('Batch number', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'SYN-B2747' } });
    expect(confirmBox().checked).toBe(false);
    fireEvent.click(applyButton());
    expect(lineValue('batchNumber')).toBe('');
    expect(
      screen.getByText('Confirm you checked the values against the pack and the count.')
    ).toBeInTheDocument();

    fireEvent.click(confirmBox());
    fireEvent.click(applyButton());
    expect(lineValue('batchNumber')).toBe('SYN-B2747');
    expect(lineValue('receivedPacks')).toBe('2');
  });
});

describe('PackPhotoReader serialized packs', () => {
  it('refuses a bulk count for a pack that prints its own serial, and accepts one', async () => {
    h.mutateAsync.mockResolvedValue(SERIALIZED);
    const { lineValue } = harness();
    await openAndRead();
    expect(screen.getByText(/prints its own serial number/)).toBeInTheDocument();
    expect(packsField()).toHaveAttribute('max', '1');

    countConfirmApply('5');
    expect(screen.getByText(ONE_AT_A_TIME)).toBeInTheDocument();
    expect(lineValue('receivedPacks')).toBe('');
    expect(lineValue('batchNumber')).toBe('');

    countConfirmApply('1');
    expect(lineValue('receivedPacks')).toBe('1');
    expect(lineValue('batchNumber')).toBe('SYN-B2741');
  });

  it('refuses a bulk count on a line that already carries a scanned serial', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({ line: { serialNumber: 'SYN-SN-0001' } });
    await openAndRead();
    countConfirmApply('3');
    expect(screen.getByText(ONE_AT_A_TIME)).toBeInTheDocument();
    expect([lineValue('batchNumber'), lineValue('receivedPacks')]).toEqual(['', '']);
    expect(lineValue('serialNumber')).toBe('SYN-SN-0001');
  });

  it('refuses to overwrite a lot that was filled from a 2D scan', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({
      gs1Payload: '(01)09501101530003(10)SYN-SCAN(17)280630(21)SYN-SN-9',
      line: { batchNumber: 'SYN-SCAN', printedExpiry: '2028-06-30', receivedPacks: '1' },
    });
    await openAndRead();
    countConfirmApply('1');
    expect(screen.getByRole('alert')).toHaveTextContent('This lot was filled from a 2D scan');
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('receivedPacks'),
    ]).toEqual(['SYN-SCAN', '2028-06-30', '1']);
    expect(screen.queryByText(/Nothing is in stock yet/)).toBeNull();
  });
});

describe('PackPhotoReader shelf choice', () => {
  it('moves the line to the shelf the receiver picks in the reader', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({ locations: TWO_LOCATIONS });
    await openAndRead();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Receive into (optional)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'loc-b' },
    });
    countConfirmApply('7');
    expect(lineValue('stockLocation')).toBe('loc-b');
  });

  it('leaves the line’s shelf alone when the reader’s shelf is not touched', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue, receipt } = harness({ locations: TWO_LOCATIONS });
    // The receiver changed the line's shelf before taking the photo.
    fireEvent.change(selectFieldControl(receipt.elements.namedItem('stockLocation:pol-1') as HTMLSelectElement), {
      target: { value: 'loc-b' },
    });
    await openAndRead();
    expect(selectFieldControl((screen.getByLabelText('Receive into (optional)', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLSelectElement)).value).toBe(
      'loc-b'
    );
    countConfirmApply('7');
    expect(lineValue('batchNumber')).toBe('SYN-B2741');
    expect(lineValue('stockLocation')).toBe('loc-b');
  });

  it('does not write its stale shelf over a line shelf changed while the reader was open', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue, receipt } = harness({ locations: TWO_LOCATIONS });
    await openAndRead();
    expect(selectFieldControl((screen.getByLabelText('Receive into (optional)', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLSelectElement)).value).toBe(
      'loc-a'
    );
    fireEvent.change(selectFieldControl(receipt.elements.namedItem('stockLocation:pol-1') as HTMLSelectElement), {
      target: { value: 'loc-b' },
    });
    countConfirmApply('7');
    expect(lineValue('batchNumber')).toBe('SYN-B2741');
    expect(lineValue('stockLocation')).toBe('loc-b');
  });

  it('keeps the line’s location when the receiver picks a shelf then switches back', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({ locations: TWO_LOCATIONS });
    await openAndRead();
    const shelf = screen.getByLabelText('Receive into (optional)', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.change(selectFieldControl(shelf), { target: { value: 'loc-b' } });
    fireEvent.change(selectFieldControl(shelf), { target: { value: '' } });
    expect(
      (within(selectFieldControl(shelf)).getByRole('option', { hidden: true, name: 'Keep the line’s location' }) as HTMLOptionElement)
        .selected
    ).toBe(true);
    countConfirmApply('7');
    expect(lineValue('batchNumber')).toBe('SYN-B2741');
    expect(lineValue('stockLocation')).toBe('loc-a');
  });

  it('explains a branch with no stock location and offers no shelf choice', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    harness({ locations: [], defaultLocationId: null });
    await openAndRead();
    expect(screen.getByText(/This branch has no active stock location/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Receive into (optional)', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeNull();
  });
});

describe('PackPhotoReader counts', () => {
  it('shows the pack-to-unit conversion for the count and in the filled status', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    harness();
    await openAndRead();
    const hint = () => document.getElementById(packsField().getAttribute('aria-describedby')!);
    expect(hint()).toHaveTextContent('1 STRIP = 10 units');
    fireEvent.change(selectFieldControl(packsField()), { target: { value: '7' } });
    expect(hint()).toHaveTextContent('7 STRIP × 10 = 70 units');
    expect(hint()).toHaveTextContent('10 STRIP outstanding');
    fireEvent.click(confirmBox());
    fireEvent.click(applyButton());
    expect(screen.getByRole('status')).toHaveTextContent('7 STRIP (70 units)');
  });

  it('measures over-receipt against the balance left after the line’s other lots', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({
      siblings: [{ key: 'pol-1.lot2', batch: 'SYN-B9000', packs: '6' }],
    });
    await openAndRead();
    countConfirmApply('7');
    expect(lineValue('receivedPacks')).toBe('7');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/More than the 4 packs still outstanding/);
    expect(status).toHaveTextContent(/over-receipt/);
  });

  it('ignores a sibling lot slot whose batch is still blank', async () => {
    h.mutateAsync.mockResolvedValue(PROPOSAL);
    const { lineValue } = harness({
      siblings: [{ key: 'pol-1.lot2', batch: '', packs: '6' }],
    });
    await openAndRead();
    countConfirmApply('7');
    expect(lineValue('receivedPacks')).toBe('7');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('7 STRIP (70 units)');
    expect(status).not.toHaveTextContent(/outstanding/);
    expect(status).not.toHaveTextContent(/over-receipt/);
  });
});

// ── DEV-770: printed retail price (MRP) ─────────────────────────────────────

const PRICED = {
  ...PROPOSAL,
  price: { kind: 'read', printed: 'MRP Rs. 450.00', amountMinor: 45_000, confidence: 0.9 },
  currentMrpMinor: 45_000,
};
const mrpField = () => screen.getByLabelText('Printed MRP per pack (PKR)', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
const mrpHint = () => document.getElementById(mrpField().getAttribute('aria-describedby')!);

describe('PackPhotoReader printed price', () => {
  it('suggests the MRP from a clear label with how sure the read was, and fills it on the line', async () => {
    h.mutateAsync.mockResolvedValue(PRICED);
    const { lineValue } = harness();
    await openAndRead();
    expect(mrpField().value).toBe('450.00');
    expect(mrpHint()).toHaveTextContent('Printed: “MRP Rs. 450.00” (90% sure)');
    expect(screen.getByText(/Read from the photo \(93% sure\)/)).toBeInTheDocument();
    expect(screen.getByText(/Printed: “EXP 06\/2028” \(90% sure\)/)).toBeInTheDocument();
    expect(screen.queryByText(/differs from the current price/)).not.toBeInTheDocument();
    // Nothing reaches the line before the receiver confirms.
    expect(lineValue('printedMrp')).toBe('');
    countConfirmApply('3');
    expect(lineValue('printedMrp')).toBe('450.00');
    expect(screen.getByRole('status')).toHaveTextContent('MRP Rs 450.00');
  });

  it('receives ten packs of one batch from one scan and a typed count', async () => {
    h.mutateAsync.mockResolvedValue(PRICED);
    const { lineValue, onSubmit } = harness();
    await openAndRead();
    countConfirmApply('10');
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect([
      lineValue('batchNumber'),
      lineValue('printedExpiry'),
      lineValue('expiryPrecision'),
      lineValue('printedMrp'),
      lineValue('receivedPacks'),
    ]).toEqual(['SYN-B2741', '2028-06-30', 'MONTH', '450.00', '10']);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('10 STRIP (100 units)');
    expect(status).not.toHaveTextContent(/over-receipt/);
    // The values sit on the line for the receipt; the reader filed nothing.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows both prices when they differ and makes the receiver choose', async () => {
    h.mutateAsync.mockResolvedValue({
      ...PRICED,
      price: { kind: 'read', printed: 'MRP Rs. 495.00', amountMinor: 49_500, confidence: 0.9 },
      warnings: [
        {
          code: 'PRICE_DIFFERS_FROM_CURRENT',
          message: "The printed price differs from this pack's current price.",
        },
      ],
    });
    const { lineValue } = harness({ line: { printedMrp: '440.00' } });
    await openAndRead();
    const printed = screen.getByLabelText('Printed on the pack: Rs 495.00', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    const current = screen.getByLabelText('Current price: Rs 450.00', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    expect(mrpField().value).toBe('');
    expect(printed.checked).toBe(false);
    expect(current.checked).toBe(false);

    countConfirmApply('2');
    expect(screen.getByText(/Choose the printed price or the current price/)).toBeInTheDocument();
    expect(lineValue('printedMrp')).toBe('440.00');
    expect(lineValue('batchNumber')).toBe('');

    fireEvent.click(current);
    expect(mrpField().value).toBe('450.00');
    fireEvent.click(printed);
    expect(mrpField().value).toBe('495.00');
    countConfirmApply('2');
    expect(lineValue('printedMrp')).toBe('495.00');
    expect(lineValue('receivedPacks')).toBe('2');
  });

  it('leaves an unreadable price empty, says so, and keeps the line’s own MRP', async () => {
    h.mutateAsync.mockResolvedValue({
      ...PRICED,
      price: { kind: 'unreadable', printed: null, confidence: 0 },
      currentMrpMinor: null,
    });
    const { lineValue } = harness({ line: { printedMrp: '440.00' } });
    await openAndRead();
    expect(mrpField().value).toBe('');
    expect(mrpHint()).toHaveTextContent('No price was readable');
    countConfirmApply('4');
    expect(lineValue('receivedPacks')).toBe('4');
    expect(lineValue('printedMrp')).toBe('440.00');
  });

  it('fills nothing from a label with two prices and uses the price the receiver types', async () => {
    h.mutateAsync.mockResolvedValue({
      ...PRICED,
      price: { kind: 'ambiguous', printed: 'MRP Rs 450 | MRP Rs 495', confidence: 0 },
    });
    const { lineValue } = harness();
    await openAndRead();
    expect(mrpField().value).toBe('');
    expect(mrpHint()).toHaveTextContent('More than one price on the label');
    expect(screen.queryByLabelText(/Printed on the pack/, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();

    fireEvent.change(selectFieldControl(mrpField()), { target: { value: '45O' } });
    countConfirmApply('1');
    expect(screen.getByText(/Enter the printed MRP per pack/)).toBeInTheDocument();
    expect(lineValue('printedMrp')).toBe('');

    fireEvent.change(selectFieldControl(mrpField()), { target: { value: '495' } });
    countConfirmApply('1');
    expect(lineValue('printedMrp')).toBe('495.00');
  });
});
