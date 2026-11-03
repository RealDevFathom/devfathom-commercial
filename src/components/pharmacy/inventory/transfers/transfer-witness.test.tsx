import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { receiveInput } from './transfer-form-data';
import { TransferReceiveForm } from './transfer-receive-form';
import type { TransferBoardRow } from './transfer-presentation';
const transfer = {
  id: 'transfer-test',
  lines: [
    {
      id: 'line',
      receivedUnits: 0,
      quantityUnits: 20,
      medicineName: 'Test medicine',
      batchNumber: 'LOT',
    },
  ],
} as unknown as TransferBoardRow;
afterEach(cleanup);
function show(witnesses = [{ id: 'staff-a', displayName: 'Assigned colleague' }]) {
  render(
    <TransferReceiveForm
      transfer={transfer}
      branchId="destination"
      witnesses={witnesses}
      action={vi.fn()}
    />
  );
  return screen.getByRole('form') as HTMLFormElement;
}
it('keeps a complete receipt possible without any witness credentials', () => {
  const form = show([]),
    data = new FormData(form);
  const pin = screen.getByLabelText('Witness PIN');
  expect(pin).toHaveAttribute('type', 'password');
  expect(pin).not.toBeRequired();
  expect(form.checkValidity()).toBe(true);
  expect(receiveInput(data)).toMatchObject({
    branchId: 'destination',
    lines: [{ lineId: 'line', receivedUnits: 20 }],
    variance: undefined,
  });
  expect(screen.getByText(/No eligible witness is available/)).toBeVisible();
});
it('submits an explicit staff PIN for a shortfall without accepting a supplied witness user ID', () => {
  const form = show();
  fireEvent.change(screen.getByLabelText(/Received units/), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Witness', { exact: true }), {
    target: { value: 'staff-a' },
  });
  fireEvent.change(screen.getByLabelText('Witness PIN'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Variance reason'), { target: { value: 'Broken seal' } });
  fireEvent.change(screen.getByLabelText('Evidence reference'), { target: { value: 'PHOTO' } });
  const data = new FormData(form);
  data.set('witnessId', 'forged-user');
  expect(receiveInput(data)).toMatchObject({
    lines: [{ lineId: 'line', receivedUnits: 10 }],
    variance: {
      staffProfileId: 'staff-a',
      pin: '1234',
      reason: 'Broken seal',
      evidenceRef: 'PHOTO',
    },
  });
  expect(receiveInput(data).variance).not.toHaveProperty('witnessId');
});
it('does not turn incomplete evidence into an authorized variance', () => {
  const form = show();
  const data = new FormData(form);
  data.set('staffProfileId', 'staff-a');
  data.set('varianceReason', 'Missing');
  data.set('evidenceRef', 'PHOTO');
  expect(receiveInput(data).variance).toBeUndefined();
});
