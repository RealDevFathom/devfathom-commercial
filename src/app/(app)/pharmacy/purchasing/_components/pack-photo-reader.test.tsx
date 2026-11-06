import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function harness(onSubmit = vi.fn((event: Event) => event.preventDefault())) {
  const view = render(
    <form data-testid="receipt" onSubmit={(event) => onSubmit(event.nativeEvent)}>
      <input name="batchNumber:pol-1" defaultValue="" />
      <input name="printedExpiry:pol-1" type="date" defaultValue="" />
      <select name="expiryPrecision:pol-1" defaultValue="MONTH">
        <option value="MONTH">Month</option>
        <option value="DAY">Day</option>
      </select>
      <input name="receivedPacks:pol-1" defaultValue="" />
      <input name="serialNumber:pol-1" defaultValue="" />
      <select name="stockLocation:pol-1" defaultValue="loc-a">
        <option value="loc-a">Front shelf</option>
      </select>
      <PackPhotoReader
        branchId="branch-a"
        defaultLocationId="loc-a"
        fieldKey="pol-1"
        locations={[{ id: 'loc-a', label: 'Front shelf' }]}
        lotLabel="Lot 1"
        medicineName="Synthetic 500 mg"
        outstandingPacks={10}
        packLevel="STRIP"
        purchaseOrderId="po-1"
        purchaseOrderLineId="pol-1"
        unitsPerPack={10}
      />
    </form>
  );
  return { ...view, onSubmit };
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

async function openAndRead() {
  fireEvent.click(screen.getByRole('button', { name: /Read batch and expiry/ }));
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Photo of one pack'), {
      target: { files: [photo()] },
    });
  });
  await screen.findByDisplayValue('SYN-B2741');
}

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
    const batch = screen.getByLabelText('Batch number');
    const receipt = getByTestId('receipt') as HTMLFormElement;
    expect((batch as HTMLInputElement).form).not.toBe(receipt);
    expect(receipt.contains(batch)).toBe(true);
    fireEvent.submit((batch as HTMLInputElement).form!);
    expect(onSubmit).not.toHaveBeenCalled();
    // An invalid count inside the reader cannot block the receipt's own validity.
    fireEvent.change(screen.getByLabelText('Packs with this exact batch and expiry'), {
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

    fireEvent.change(screen.getByLabelText('Packs with this exact batch and expiry'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByLabelText(/I checked this batch and expiry/));
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
    fireEvent.change(screen.getByLabelText('Photo of one pack'), {
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
      fireEvent.change(screen.getByLabelText('Photo of one pack'), {
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
      fireEvent.change(screen.getByLabelText('Photo of one pack'), {
        target: { files: [photo()] },
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    const batch = (getByTestId('receipt') as HTMLFormElement).elements.namedItem(
      'batchNumber:pol-1'
    ) as HTMLInputElement;
    fireEvent.change(batch, { target: { value: 'TYPED-1' } });
    expect(batch.value).toBe('TYPED-1');
  });
});
