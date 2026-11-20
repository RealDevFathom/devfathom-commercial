import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn(), options: null as unknown }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantDevices: {
      initiatePrintBridgeEnrollment: {
        useMutation: (options: unknown) => {
          h.options = options;
          return { mutateAsync: h.mutate, reset: h.reset };
        },
      },
    },
  },
}));
import { PrintBridgeEnrollment } from './print-bridge-enrollment';
const code = `pbe_${'A'.repeat(32)}`;
const result = {
  enrollmentCode: code,
  expiresAt: new Date('2026-10-14T02:00:00Z'),
  device: { id: 'new' },
};
const branches = [
  { id: 'branch', name: 'Downtown', active: true },
  { id: 'inactive', name: 'Closed', active: false },
];
const onCreated = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  h.mutate.mockResolvedValue(result);
});
function openForm() {
  render(<PrintBridgeEnrollment ownerKey="org:admin" branches={branches} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
}
function fill() {
  fireEvent.change(selectFieldControl(screen.getByLabelText('Bridge name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Kitchen host' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'branch' } });
}
it('requires an explicit active branch and name', () => {
  openForm();
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeDisabled();
  expect(screen.queryByRole('option', { hidden: true, name: 'Closed' })).not.toBeInTheDocument();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Bridge name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Kitchen host' } });
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeDisabled();
  expect(h.mutate).not.toHaveBeenCalled();
});
it('creates a new device only, shows the code once, and clears it on close', async () => {
  openForm();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  await waitFor(() => expect(selectFieldControl(screen.getByLabelText('One-time enrollment code', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(code));
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({ name: 'Kitchen host', branchId: 'branch' });
  expect(h.options).toEqual({ retry: false, gcTime: 0 });
  expect(onCreated).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  expect(screen.queryByDisplayValue(code)).not.toBeInTheDocument();
  expect(selectFieldControl(screen.getByLabelText('Bridge name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
});
it('retains an uncertain failure for reconciliation without retry or sensitive error text', async () => {
  h.mutate.mockRejectedValue(new Error(`internal ${code} rdk_private`));
  openForm();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).not.toHaveTextContent(/internal|rdk_private|pbe_/);
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeDisabled();
  expect(h.mutate).toHaveBeenCalledOnce();
  expect(onCreated).not.toHaveBeenCalled();
});
it('ignores late results after the owning tenant component unmounts', async () => {
  let resolve!: (value: typeof result) => void;
  h.mutate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(
    <PrintBridgeEnrollment ownerKey="org:admin" branches={branches} onCreated={onCreated} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  view.unmount();
  await act(async () => {
    resolve(result);
  });
  expect(onCreated).not.toHaveBeenCalled();
});

it('hides a displayed code immediately when the same organization changes user', async () => {
  const view = render(
    <PrintBridgeEnrollment ownerKey="org:admin" branches={branches} onCreated={onCreated} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  await screen.findByLabelText('One-time enrollment code', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
  view.rerender(
    <PrintBridgeEnrollment ownerKey="org:other" branches={branches} onCreated={onCreated} />
  );
  expect(screen.queryByDisplayValue(code)).not.toBeInTheDocument();
});
it('rejects a pending result from a prior user without relying on unmount', async () => {
  let resolve!: (value: typeof result) => void;
  h.mutate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(
    <PrintBridgeEnrollment ownerKey="org:admin" branches={branches} onCreated={onCreated} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  view.rerender(
    <PrintBridgeEnrollment ownerKey="org:other" branches={branches} onCreated={onCreated} />
  );
  await act(async () => {
    resolve(result);
  });
  expect(screen.queryByDisplayValue(code)).not.toBeInTheDocument();
  expect(onCreated).not.toHaveBeenCalled();
});
it('keeps reconciliation required across closing until explicitly acknowledged', async () => {
  h.mutate.mockRejectedValue(new Error('uncertain'));
  openForm();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  expect(screen.getByRole('alert')).toHaveTextContent('reconcile');
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'I have reconciled the device' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fill();
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeEnabled();
  expect(h.mutate).toHaveBeenCalledOnce();
});

it('includes optional printer drafts with the new bridge and omits UI row keys', async () => {
  openForm();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  expect(screen.getByRole('button', { name: 'Create enrollment code' })).toBeDisabled();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: ' Receipt ' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: ' tcp://printer:9100 ' },
  });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 paper width', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '58' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create enrollment code' }));
  await screen.findByLabelText('One-time enrollment code', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({
    name: 'Kitchen host',
    branchId: 'branch',
    printers: [{ name: 'Receipt', address: 'tcp://printer:9100', paperWidthMm: 58 }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enroll print bridge' }));
  expect(screen.queryByLabelText('Printer 1 name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).not.toBeInTheDocument();
});
it('prevents duplicate same-tick enrollment and freezes printer drafts while submitting', async () => {
  let resolve!: (value: typeof result) => void;
  h.mutate.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  openForm();
  fill();
  const form = screen.getByRole('button', { name: 'Create enrollment code' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(h.mutate).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Add printer' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => {
    resolve(result);
  });
});

it('keeps an invalid printer target editable without creating an uncertain enrollment', () => {
  openForm();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Receipt' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'https://printer' },
  });
  const button = screen.getByRole('button', { name: 'Create enrollment code' });
  expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(h.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('valid TCP');
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: '/dev/usb/lp0' },
  });
  expect(button).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
