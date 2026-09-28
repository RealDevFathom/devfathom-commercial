import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn(), options: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyInventory: {
      breakPack: {
        useMutation: (options: unknown) => {
          mocks.options(options);
          return { mutateAsync: mocks.mutate };
        },
      },
    },
  },
}));

import { BreakPackForm, type BreakPackFormProps } from './break-pack-form';

const stock: BreakPackFormProps = {
  branchId: 'branch-main',
  inventoryLotId: 'lot-a',
  stockLocationId: 'location-rack',
  medicineName: 'Medicine A',
  batchNumber: 'B-100',
  locationName: 'Rack 2',
  sealedPacks: 3,
  looseUnits: 4,
  unitsPerPack: 10,
  onHandUnits: 34,
  expiresAt: '2099-01-01T00:00:00.000Z',
  unavailableReason: null,
  observedAt: Date.parse('2026-09-12T00:00:00.000Z'),
};

function review(count = '2') {
  fireEvent.click(screen.getByRole('button', { name: 'Break pack' }));
  fireEvent.change(screen.getByLabelText('Sealed packs to open'), { target: { value: count } });
  fireEvent.click(screen.getByRole('button', { name: 'Review break' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutate.mockResolvedValue({
    movement: { id: 'movement' },
    packsToBreak: 2,
    sealedPackDelta: -2,
    looseUnitDelta: 20,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Inventory break-pack form', () => {
  it('confirms the selected arrangement and sends the exact existing API payload once', async () => {
    render(<BreakPackForm {...stock} />);
    review();
    expect(screen.getByText('Medicine A · Batch B-100 · Rack 2')).toBeVisible();
    expect(
      screen.getByText('3 sealed + 4 loose · 10 units per pack · 34 total units')
    ).toBeVisible();
    expect(
      screen.getByText('Open 2 sealed packs? Result: 1 sealed + 24 loose. Total stays 34 units.')
    ).toBeVisible();
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-main',
      inventoryLotId: 'lot-a',
      stockLocationId: 'location-rack',
      requiredLooseUnits: 24,
      idempotencyKey: expect.stringMatching(/^inventory-break-pack:[\da-f-]{36}$/),
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 sealed packs opened, 20 loose units released. Total units unchanged.'
    );
    expect(mocks.options).toHaveBeenCalledWith({ retry: false });
  });

  it.each(['0', '-1', '1.5', '', '4', '9007199254740992'])(
    'rejects invalid or excess sealed-pack count %s without a mutation',
    (count) => {
      render(<BreakPackForm {...stock} />);
      review(count);
      expect(screen.getByRole('alert')).toBeVisible();
      expect(screen.getByLabelText('Sealed packs to open')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Review break' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Confirm break pack' })).toBeNull();
      expect(mocks.mutate).not.toHaveBeenCalled();
    }
  );

  it.each([
    { unavailableReason: 'Permission required.' },
    { unavailableReason: 'Batch is recalled.' },
    { unavailableReason: 'Stock is not available.' },
    { sealedPacks: 0, looseUnits: 4, onHandUnits: 4 },
    { onHandUnits: 0 },
    { looseUnits: Number.NaN },
    { unitsPerPack: 0 },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: '' },
  ])('disables blocked or unknown stock: %j', (overrides) => {
    render(<BreakPackForm {...stock} {...overrides} />);
    const button = screen.getByRole('button', { name: 'Break pack' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription();
    fireEvent.click(button);
    expect(screen.queryByLabelText('Sealed packs to open')).toBeNull();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('allows the exact maximum pack count and preserves existing loose units in the target', async () => {
    render(<BreakPackForm {...stock} />);
    review('3');
    expect(
      screen.getByText('Open 3 sealed packs? Result: 0 sealed + 34 loose. Total stays 34 units.')
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.mutate.mock.calls[0][0].requiredLooseUnits).toBe(34);
  });

  it('guards duplicate submits synchronously while a request is pending', async () => {
    let resolve!: (value: unknown) => void;
    mocks.mutate.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<BreakPackForm {...stock} />);
    review();
    const confirm = screen.getByRole('button', { name: 'Confirm break pack' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Recording pack break');
    expect(screen.getByRole('button', { name: 'Break pack' })).toBeDisabled();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () =>
      resolve({ movement: { id: 'one' }, packsToBreak: 2, sealedPackDelta: -2, looseUnitDelta: 20 })
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND'])(
    'shows a server rejection (%s) and keeps stock unrefreshed',
    async (code) => {
      mocks.mutate.mockRejectedValue(
        Object.assign(new Error('Stock permission denied'), { data: { code } })
      );
      render(<BreakPackForm {...stock} />);
      review();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Pack break rejected. Stock permission denied'
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    new Error('Connection lost'),
    Object.assign(new Error('Timed out'), { data: { code: 'TIMEOUT' } }),
    Object.assign(new Error('Server response lost'), { data: { code: 'INTERNAL_SERVER_ERROR' } }),
  ])('locks an uncertain outcome without retrying or refreshing: %s', async (error) => {
    mocks.mutate.mockRejectedValue(error);
    const view = render(<BreakPackForm {...stock} />);
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Outcome unknown. Do not submit another pack break.'
    );
    expect(screen.getByText(/^Reference: inventory-break-pack:/)).toBeVisible();
    view.rerender(<BreakPackForm {...stock} sealedPacks={1} looseUnits={24} />);
    fireEvent.click(screen.getByRole('button', { name: 'Break pack' }));
    expect(screen.getByRole('button', { name: 'Break pack' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Confirm break pack' })).toBeNull();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('treats a missing mutation response as unknown', async () => {
    mocks.mutate.mockResolvedValue(undefined);
    render(<BreakPackForm {...stock} />);
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Outcome unknown');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rechecks expiry at confirmation even if the form was opened before expiry', async () => {
    render(<BreakPackForm {...stock} />);
    review();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(stock.expiresAt));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Batch has expired. No pack break submitted.'
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('reports a confirmed no-op honestly and refreshes once', async () => {
    mocks.mutate.mockResolvedValue({
      movement: null,
      packsToBreak: 0,
      sealedPackDelta: 0,
      looseUnitDelta: 0,
    });
    render(<BreakPackForm {...stock} />);
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent('No packs opened');
  });

  it('requires a new review when the selected stock changes', async () => {
    const view = render(<BreakPackForm {...stock} />);
    review();
    view.rerender(<BreakPackForm {...stock} sealedPacks={2} looseUnits={14} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Stock changed');
    expect(screen.getByRole('button', { name: 'Confirm break pack' })).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review break' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm break pack' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.mutate.mock.calls[0][0].requiredLooseUnits).toBe(34);
  });
});
