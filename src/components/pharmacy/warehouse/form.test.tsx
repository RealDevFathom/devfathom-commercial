import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ActionForm, Field, WarehouseFeedback } from './form';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyWarehouse: { invalidate: vi.fn().mockResolvedValue(undefined) },
      pharmacyInventory: { transferBoard: { invalidate: vi.fn().mockResolvedValue(undefined) } },
    }),
  },
}));

afterEach(cleanup);

it('advances from a barcode scan without submitting or skipping the next field', () => {
  const action = vi.fn();
  render(
    <ActionForm action={action} label="Confirm pick" success="Pick recorded.">
      <Field name="lot" label="Lot barcode" scan />
      <Field name="bin" label="Staging bin" scan />
    </ActionForm>
  );
  fireEvent.keyDown(screen.getByLabelText('Lot barcode'), { key: 'Enter' });
  expect(screen.getByLabelText('Staging bin')).toHaveFocus();
  expect(action).not.toHaveBeenCalled();
});

it('keeps a failed scan and retries the same server command once after connection loss', async () => {
  const action = vi
    .fn()
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce(undefined);
  render(
    <WarehouseFeedback>
      <ActionForm action={action} label="Confirm pick" success="Pick recorded.">
        <Field name="lot" label="Lot barcode" scan />
      </ActionForm>
    </WarehouseFeedback>
  );
  fireEvent.change(screen.getByLabelText('Lot barcode'), { target: { value: 'LOT123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pick' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(screen.getByLabelText('Lot barcode')).toHaveValue('LOT123');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pick' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Pick recorded.'));
  expect(action.mock.calls).toHaveLength(2);
  expect(action.mock.calls[0]![1]).toEqual(action.mock.calls[1]![1]);
});

it('disables confirmation while offline, keeping the operator on the same form', () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    render(
      <WarehouseFeedback>
        <ActionForm action={vi.fn()} label="Confirm receipt" success="Received." />
      </WarehouseFeedback>
    );
    expect(screen.getByRole('button', { name: 'Confirm receipt' })).toBeDisabled();
    expect(screen.getByText(/waiting for a connection/i)).toBeVisible();
  } finally {
    online.mockRestore();
  }
});
