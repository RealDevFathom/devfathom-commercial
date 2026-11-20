import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => {
  const branches = vi.fn(),
    printers = vi.fn(),
    devices = vi.fn(),
    mutate = vi.fn(),
    reset = vi.fn(),
    rename = vi.fn(),
    renameReset = vi.fn(),
    retire = vi.fn(),
    retireReset = vi.fn();
  return {
    branches,
    printers,
    devices,
    mutate,
    reset,
    rename,
    renameReset,
    retire,
    retireReset,
    renameOptions: null as unknown,
    retireOptions: null as unknown,
    options: null as unknown,
    client: {
      restaurantStaff: { listBranches: { query: branches } },
      restaurantDevices: { listPrinters: { query: printers }, list: { query: devices } },
    },
  };
});
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ client: h.client }),
    restaurantDevices: {
      renamePrinter: {
        useMutation: (options: unknown) => {
          h.renameOptions = options;
          return { mutateAsync: h.rename, reset: h.renameReset };
        },
      },
      retirePrinter: {
        useMutation: (options: unknown) => {
          h.retireOptions = options;
          return { mutateAsync: h.retire, reset: h.retireReset };
        },
      },
      registerPrinters: {
        useMutation: (options: unknown) => {
          h.options = options;
          return { mutateAsync: h.mutate, reset: h.reset };
        },
      },
    },
  },
}));
import { PrinterInventoryPanel } from './printer-inventory-panel';
const branches = [
  { id: 'a', name: 'Downtown', active: true, isDefault: true },
  { id: 'b', name: 'Uptown', active: true, isDefault: false },
  { id: 'closed', name: 'Closed', active: false, isDefault: false },
];
const bridge = {
  id: 'bridge',
  name: 'Kitchen host',
  kind: 'PRINT_BRIDGE',
  branch: { id: 'a', name: 'Downtown' },
  status: 'ACTIVE',
  revokedAt: null,
};
const printer = {
  id: 'printer',
  branchId: 'a',
  name: 'Receipt',
  address: 'tcp://printer:9100',
  paperWidthMm: 80,
  status: 'OFFLINE',
  lastSeenAt: null,
  retiredAt: null as Date | null,
  bridge: { id: 'bridge', name: 'Kitchen host' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.branches.mockResolvedValue(branches);
  h.devices.mockResolvedValue([bridge]);
  h.printers.mockResolvedValue([printer]);
  h.mutate.mockResolvedValue({ registered: 1 });
  h.retire.mockResolvedValue(retirementResult());
});
async function chooseBranch(id = 'a') {
  await waitFor(() => expect(screen.getByLabelText('Inventory branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeEnabled());
  fireEvent.change(selectFieldControl(screen.getByLabelText('Inventory branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: id } });
}
async function openRegistration() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Register printers' }));
  fireEvent.change(selectFieldControl(screen.getByLabelText('Print bridge', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'bridge' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: ' Receipt ' } });
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: ' tcp://printer:9100 ' },
  });
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save printers' }));
it('keeps an invalid target editable without issuing a mutation and enables a correction', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'https://printer' },
  });
  expect(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('valid TCP');
  const button = screen.getByRole('button', { name: 'Save printers' });
  expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(h.mutate).not.toHaveBeenCalled();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer 1 target', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
    target: { value: 'queue:///Receipt%20Printer' },
  });
  expect(button).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('keeps reconciliation blocked after a failed refresh until the original branch reloads successfully', async () => {
  h.printers
    .mockResolvedValueOnce([printer])
    .mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValueOnce([printer]);
  h.mutate.mockRejectedValue(new Error('uncertain'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  await screen.findByText('Printers could not be loaded. Refresh the list to try again.');
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled()
  );
  expect(h.mutate).toHaveBeenCalledOnce();
});
it('requires an active branch, reads management inventory independently, and does not invent telemetry', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
  await chooseBranch();
  expect(screen.queryByRole('option', { hidden: true, name: 'Closed' })).not.toBeInTheDocument();
  await screen.findByText('Receipt');
  expect(h.printers).toHaveBeenCalledExactlyOnceWith({ branchId: 'a' });
  expect(h.devices).toHaveBeenCalledOnce();
  expect(screen.getAllByText('Not reported')).toHaveLength(2);
  expect(screen.queryByText('OFFLINE')).not.toBeInTheDocument();
});
it('rejects demo-directory success when management inventory authorization fails', async () => {
  h.printers.mockRejectedValue({ data: { code: 'FORBIDDEN' }, message: 'private detail' });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private detail');
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});
it('offers only active non-revoked print bridges in the selected branch', async () => {
  h.devices.mockResolvedValue([
    bridge,
    { ...bridge, id: 'pos', name: 'POS', kind: 'POS' },
    { ...bridge, id: 'wrong', name: 'Other branch', branch: { id: 'b', name: 'Uptown' } },
    { ...bridge, id: 'revoked', name: 'Revoked', revokedAt: new Date() },
    { ...bridge, id: 'inactive', name: 'Inactive', status: 'REVOKED' },
  ]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  expect(
    within(selectFieldControl(screen.getByLabelText('Print bridge', { selector: ':not([data-select-field-native][aria-hidden="true"])' })))
      .getAllByRole('option', { hidden: true })
      .map((option) => option.textContent)
  ).toEqual(['Select a print bridge', 'Kitchen host']);
});
it('snapshots the target and suppresses simultaneous duplicate submissions and dismissal', async () => {
  const command = deferred<{ registered: number }>();
  h.mutate.mockReturnValue(command.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  const form = screen.getByRole('button', { name: 'Save printers' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({
    branchId: 'a',
    bridgeId: 'bridge',
    printers: [{ name: 'Receipt', address: 'tcp://printer:9100', paperWidthMm: 80 }],
  });
  expect(h.options).toEqual({ retry: false, gcTime: 0 });
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByLabelText('Printer 1 name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await act(async () => {
    command.resolve({ registered: 1 });
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(await screen.findByText(/Registered 1 printer/)).toBeVisible();
});
it('retains uncertainty across branch changes and requires reconciliation against its original target', async () => {
  h.mutate.mockRejectedValue(new Error('private sql and credentials'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  expect(await screen.findByRole('alert')).toHaveTextContent('Kitchen host in Downtown');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  await chooseBranch('b');
  await waitFor(() => expect(h.printers).toHaveBeenCalledWith({ branchId: 'b' }));
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
  await chooseBranch('a');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'I have reconciled the printers' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled()
  );
  expect(h.mutate).toHaveBeenCalledOnce();
});
it('requires fresh inventory after an uncertain write before reconciliation can be acknowledged', async () => {
  const refresh = deferred<(typeof printer)[]>();
  h.printers.mockResolvedValueOnce([printer]).mockReturnValueOnce(refresh.promise);
  h.mutate.mockRejectedValue(new Error('uncertain'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled();
  await act(async () => {
    refresh.resolve([printer]);
  });
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled();
});
it('clears an earlier success receipt when a later registration becomes uncertain', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  await screen.findByText(/Registered 1 printer/);
  h.mutate.mockRejectedValue(new Error('uncertain'));
  await openRegistration();
  save();
  await screen.findByRole('alert');
  expect(screen.queryByText(/Registration is confirmed/)).not.toBeInTheDocument();
});
it('keeps confirmed success separate from a failed list refresh without resubmitting', async () => {
  h.printers.mockResolvedValueOnce([printer]).mockRejectedValue(new Error('read failed'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  await screen.findByText(/Registered 1 printer/);
  expect(await screen.findByRole('alert')).toHaveTextContent('Printers could not be loaded');
  expect(
    screen.queryByRole('button', { name: 'I have reconciled the printers' })
  ).not.toBeInTheDocument();
  expect(h.mutate).toHaveBeenCalledOnce();
});
it('discards obsolete inventory responses during an A/B/A branch race', async () => {
  const old = deferred<(typeof printer)[]>();
  h.printers
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ ...printer, name: 'Current' }]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch('a');
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(1));
  await chooseBranch('b');
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
  await chooseBranch('a');
  await screen.findByText('Current');
  await act(async () => {
    old.resolve([{ ...printer, name: 'Obsolete' }]);
  });
  expect(screen.getByText('Current')).toBeVisible();
  expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
});
it('hides prior-owner inventory immediately and requires a fresh directory', async () => {
  const next = deferred<typeof branches>();
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await screen.findByText('Receipt');
  h.branches.mockReturnValueOnce(next.promise);
  view.rerender(<PrinterInventoryPanel ownerKey="org:other" />);
  expect(screen.queryByText('Receipt')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Inventory branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
  await act(async () => {
    next.resolve([]);
  });
  expect(h.branches).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});
it('ignores a mutation result after an owner A/B/A transition', async () => {
  const command = deferred<{ registered: number }>();
  h.mutate.mockReturnValue(command.promise);
  const view = render(<PrinterInventoryPanel key="org:admin" ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  view.rerender(<PrinterInventoryPanel key="org:other" ownerKey="org:other" />);
  view.rerender(<PrinterInventoryPanel key="org:admin" ownerKey="org:admin" />);
  await act(async () => {
    command.resolve({ registered: 1 });
  });
  expect(screen.queryByText(/Registered 1 printer/)).not.toBeInTheDocument();
});
it('does not apply a late mutation after unmount', async () => {
  const command = deferred<{ registered: number }>();
  h.mutate.mockReturnValue(command.promise);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  view.unmount();
  await act(async () => {
    command.resolve({ registered: 1 });
  });
  expect(h.printers).toHaveBeenCalledOnce();
});
it('retries a failed branch directory without reading unauthorized inventory', async () => {
  h.branches.mockRejectedValueOnce(new Error('failure'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Branches could not be loaded');
  expect(h.printers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry branches' }));
  await chooseBranch();
  await screen.findByText('Receipt');
});
it('refreshes inventory and eligible bridges when device changes are reported', async () => {
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await screen.findByText('Receipt');
  h.devices.mockResolvedValue([]);
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await screen.findByText(/No active print bridge/);
  expect(h.printers).toHaveBeenCalledTimes(2);
  expect(h.devices).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});

async function openRename() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Rename Receipt' }));
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: ' Front desk ' } });
}
const saveName = () => fireEvent.click(screen.getByRole('button', { name: 'Save printer name' }));
const renameResult = (name = 'Front desk', changed = true) => ({
  printer: { id: 'printer', branchId: 'a', name },
  changed,
});
it('renames only a label even with no active bridge and absent telemetry', async () => {
  h.devices.mockResolvedValue([]);
  h.rename.mockResolvedValue(renameResult());
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  await screen.findByText(/Renamed printer to Front desk/);
  expect(h.rename).toHaveBeenCalledExactlyOnceWith({
    branchId: 'a',
    printerId: 'printer',
    expectedName: 'Receipt',
    name: 'Front desk',
  });
  expect(h.renameOptions).toEqual({ retry: false, gcTime: 0 });
  expect(h.mutate).not.toHaveBeenCalled();
});
it('keeps invalid names editable without a mutation', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: ' ' } });
  const button = screen.getByRole('button', { name: 'Save printer name' });
  expect(button).toBeDisabled();
  fireEvent.submit(button.closest('form')!);
  expect(h.rename).not.toHaveBeenCalled();
});
it('guards simultaneous name submissions, branch changes and dismissal while pending', async () => {
  const pending = deferred<ReturnType<typeof renameResult>>();
  h.rename.mockReturnValue(pending.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  const form = screen.getByRole('button', { name: 'Save printer name' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(h.rename).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel rename' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await act(async () => pending.resolve(renameResult()));
  await screen.findByText(/Renamed printer to Front desk/);
});
it('requires explicit fresh baseline adoption on a name conflict and never automatically retries', async () => {
  const fresh = deferred<(typeof printer)[]>();
  h.rename.mockRejectedValueOnce({ data: { code: 'CONFLICT' } });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockReturnValueOnce(fresh.promise);
  saveName();
  await screen.findByText('Checking the current name…');
  expect(screen.getByRole('button', { name: 'Keep draft with current name' })).toBeDisabled();
  await act(async () => fresh.resolve([{ ...printer, name: 'Changed elsewhere' }]));
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft with current name' }));
  expect(h.rename).toHaveBeenCalledOnce();
  h.rename.mockResolvedValueOnce(renameResult());
  saveName();
  await waitFor(() => expect(h.rename).toHaveBeenCalledTimes(2));
  expect(h.rename.mock.calls[1][0]).toEqual({
    branchId: 'a',
    printerId: 'printer',
    expectedName: 'Changed elsewhere',
    name: 'Front desk',
  });
});
it('observes a matching name after uncertainty without claiming prior success or repeating the command', async () => {
  h.rename.mockRejectedValue(new Error('lost response'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockResolvedValue([{ ...printer, name: 'Front desk' }]);
  saveName();
  await screen.findByText('Current saved name: Front desk');
  expect(screen.getByText(/does not confirm that the earlier request completed/)).toBeVisible();
  expect(screen.queryByText(/Renamed printer to/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use current name' }));
  expect(h.rename).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('does not use a background read started before mutation failure as reconciliation evidence', async () => {
  const pending = deferred<ReturnType<typeof renameResult>>(),
    old = deferred<(typeof printer)[]>(),
    fresh = deferred<(typeof printer)[]>();
  h.rename.mockReturnValue(pending.promise);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await openRename();
  saveName();
  h.printers.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
  await act(async () => pending.reject(new Error('lost response')));
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(3));
  await act(async () => old.resolve([{ ...printer, name: 'Old background' }]));
  expect(screen.getByRole('button', { name: 'Keep draft with current name' })).toBeDisabled();
  await act(async () => fresh.resolve([{ ...printer, name: 'Fresh dedicated' }]));
  await screen.findByText('Current saved name: Fresh dedicated');
  expect(screen.getByRole('button', { name: 'Keep draft with current name' })).toBeEnabled();
  expect(h.rename).toHaveBeenCalledOnce();
});
it('keeps review pending across close and branch navigation', async () => {
  h.rename.mockRejectedValue(new Error('lost response'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  await screen.findByText('Current saved name: Receipt');
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await chooseBranch('b');
  expect(screen.getByRole('button', { name: 'Review printer name' })).toBeDisabled();
  await chooseBranch('a');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Review printer name' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review printer name' }));
  expect(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(' Front desk ');
  expect(screen.getByRole('button', { name: 'Save printer name' })).toBeDisabled();
  expect(h.rename).toHaveBeenCalledOnce();
});
it('does not adopt another printer or an empty baseline and permits explicit draft abandonment', async () => {
  h.rename.mockRejectedValue(new Error('lost response'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockResolvedValue([{ ...printer, id: 'other' }]);
  saveName();
  await screen.findByText('This printer is no longer available in the branch.');
  expect(screen.getByRole('button', { name: 'Keep draft with current name' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Abandon draft' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(h.rename).toHaveBeenCalledOnce();
});
it('keeps a failed reconciliation blocked until a dedicated read succeeds', async () => {
  h.rename.mockRejectedValue(new Error('lost response'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockRejectedValueOnce(new Error('read failed'));
  saveName();
  await screen.findByText('The current name could not be checked.');
  expect(screen.getByRole('button', { name: 'Keep draft with current name' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check current name' }));
  await screen.findByText('Current saved name: Receipt');
  expect(h.rename).toHaveBeenCalledOnce();
});
it('hides inventory after forbidden rename until a new authorized inventory read succeeds', async () => {
  h.rename.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' } });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  await screen.findByText(/Refresh to check your access again/);
  expect(screen.queryByRole('button', { name: 'Rename Receipt' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Rename Receipt' }));
  expect(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(' Front desk ');
  expect(h.rename).toHaveBeenCalledOnce();
});
it('retains a definite failed draft without an uncertain-outcome claim or automatic retry', async () => {
  h.rename.mockRejectedValueOnce({ data: { code: 'BAD_REQUEST' } });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  await screen.findByText(/Name was not saved/);
  expect(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue(' Front desk ');
  expect(screen.queryByText(/Rename outcome is uncertain/)).not.toBeInTheDocument();
  expect(h.printers).toHaveBeenCalledOnce();
});
it('preserves confirmed rename after a failed list refresh', async () => {
  h.rename.mockResolvedValue(renameResult());
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockRejectedValue(new Error('refresh failed'));
  saveName();
  await screen.findByText(/Renamed printer to Front desk/);
  await screen.findByText(/Printers could not be loaded/);
  expect(screen.queryByText(/Rename outcome is uncertain/)).not.toBeInTheDocument();
  expect(h.rename).toHaveBeenCalledOnce();
});
it('reports a confirmed no-op honestly', async () => {
  h.rename.mockResolvedValue(renameResult('Receipt', false));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  fireEvent.change(selectFieldControl(screen.getByLabelText('Printer name', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'Receipt' } });
  saveName();
  await screen.findByText(/Printer name remains Receipt/);
  expect(screen.queryByText(/Renamed printer to/)).not.toBeInTheDocument();
});
it('ignores late rename success after an owner remount', async () => {
  const pending = deferred<ReturnType<typeof renameResult>>();
  h.rename.mockReturnValue(pending.promise);
  const view = render(<PrinterInventoryPanel key="a" ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  view.rerender(<PrinterInventoryPanel key="b" ownerKey="other:user" />);
  await act(async () => pending.resolve(renameResult()));
  expect(screen.queryByText(/Renamed printer to/)).not.toBeInTheDocument();
});
it('discards a dedicated reconciliation response after an owner A to B to A remount', async () => {
  const pending = deferred<(typeof printer)[]>();
  h.rename.mockRejectedValue(new Error('lost'));
  const view = render(<PrinterInventoryPanel key="a1" ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockReturnValueOnce(pending.promise);
  saveName();
  await screen.findByText('Checking the current name…');
  view.rerender(<PrinterInventoryPanel key="b" ownerKey="other:user" />);
  view.rerender(<PrinterInventoryPanel key="a2" ownerKey="org:admin" />);
  await act(async () => pending.resolve([{ ...printer, name: 'Obsolete' }]));
  expect(screen.queryByText(/Obsolete/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Rename outcome is uncertain/)).not.toBeInTheDocument();
});
it('keeps registration uncertainty independent and blocks name changes until it is reconciled', async () => {
  h.mutate.mockRejectedValue(new Error('lost registration'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled()
  );
  expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeDisabled();
  expect(h.rename).not.toHaveBeenCalled();
});

it('does not release an uncertain command while its dedicated read is pending or failed', async () => {
  const pending = deferred<(typeof printer)[]>();
  h.rename.mockRejectedValue(new Error('lost response'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  h.printers.mockReturnValueOnce(pending.promise);
  saveName();
  await screen.findByText('Checking the current name…');
  expect(screen.getByRole('button', { name: 'Abandon draft' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Abandon draft' }));
  expect(screen.getByRole('button', { name: 'Save printer name' })).toBeDisabled();
  await act(async () => pending.reject(new Error('read failed')));
  await screen.findByText('The current name could not be checked.');
  expect(screen.getByRole('button', { name: 'Abandon draft' })).toBeDisabled();
  expect(h.rename).toHaveBeenCalledOnce();
});
it('rejects a pre-denial inventory response and waits for a later authorized read', async () => {
  const pending = deferred<ReturnType<typeof renameResult>>(),
    old = deferred<(typeof printer)[]>();
  h.rename.mockReturnValue(pending.promise);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await openRename();
  saveName();
  h.printers.mockReturnValueOnce(old.promise);
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
  await act(async () => pending.reject({ data: { code: 'FORBIDDEN' } }));
  await screen.findByText(/Refresh to check your access again/);
  await act(async () => old.resolve([printer]));
  expect(screen.queryByRole('button', { name: 'Rename Receipt' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled());
  expect(h.rename).toHaveBeenCalledOnce();
});

it('keeps branch B loading independent of a late branch A reconciliation denial', async () => {
  const oldA = deferred<(typeof printer)[]>(),
    pendingB = deferred<(typeof printer)[]>();
  h.rename.mockRejectedValue(new Error('lost rename'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch('a');
  await openRename();
  h.printers.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(pendingB.promise);
  saveName();
  await screen.findByText('Checking the current name…');
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  await chooseBranch('b');
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(3));
  await act(async () => oldA.reject({ data: { code: 'FORBIDDEN' } }));
  await act(async () =>
    pendingB.resolve([{ ...printer, id: 'printer-b', branchId: 'b', name: 'Branch B printer' }])
  );
  expect(await screen.findByText('Branch B printer')).toBeVisible();
  expect(screen.queryByText('Loading printers…')).not.toBeInTheDocument();
  expect(h.printers).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: 'Review printer name' })).toBeDisabled();
  expect(h.rename).toHaveBeenCalledOnce();
});

const savedRetirement = new Date('2026-10-14T10:15:30.000Z');
function retirementResult(changed = true, retiredAt = savedRetirement) {
  return {
    printer: { id: 'printer', branchId: 'a', name: 'Receipt', retiredAt },
    changed,
  };
}
async function openRetirement() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Retire Receipt' }));
}
const confirmRetirement = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' }));

it('identifies the exact branch and printer and cancels without a mutation', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Receipt in Downtown');
  expect(dialog).toHaveTextContent('tcp://printer:9100');
  expect(dialog).toHaveTextContent('Inventory ID: printer');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel retirement' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(h.retire).not.toHaveBeenCalled();
});

it('retains the saved server timestamp after a failed refresh and does not offer a repeat action', async () => {
  h.printers.mockResolvedValueOnce([printer]).mockRejectedValueOnce(new Error('read failed'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  const result = await screen.findByText(/Retired Receipt/);
  expect(result.closest('[role="status"]')).toHaveTextContent('Saved retirement time:');
  expect(result.closest('[role="status"]')?.querySelector('time')).toHaveAttribute(
    'datetime',
    savedRetirement.toISOString()
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Printers could not be loaded');
  expect(screen.queryByText(/Retirement outcome is uncertain/)).not.toBeInTheDocument();
  expect(h.retire).toHaveBeenCalledExactlyOnceWith({ branchId: 'a', printerId: 'printer' });
  expect(h.retireOptions).toEqual({ retry: false, gcTime: 0 });
});

it('reports an idempotent server result with its original timestamp', async () => {
  h.retire.mockResolvedValue(retirementResult(false));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  const result = await screen.findByText(/Receipt was already retired/);
  expect(result.closest('[role="status"]')?.querySelector('time')).toHaveAttribute(
    'datetime',
    savedRetirement.toISOString()
  );
  expect(screen.queryByText(/Retired Receipt/)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retire Receipt' })).not.toBeInTheDocument()
  );
  expect(h.retire).toHaveBeenCalledOnce();
});

it('keeps an idempotent retirement receipt when its list refresh fails', async () => {
  h.retire.mockResolvedValue(retirementResult(false));
  h.printers.mockResolvedValueOnce([printer]).mockRejectedValueOnce(new Error('read failed'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  const result = await screen.findByText(/Receipt was already retired/);
  expect(result.closest('[role="status"]')?.querySelector('time')).toHaveAttribute(
    'datetime',
    savedRetirement.toISOString()
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Printers could not be loaded');
  expect(h.retire).toHaveBeenCalledOnce();
});

it('keeps a retired row visible with lifecycle separate from observed health', async () => {
  h.printers.mockResolvedValue([
    {
      ...printer,
      status: 'ONLINE',
      lastSeenAt: new Date('2026-10-14T09:00:00.000Z'),
      retiredAt: savedRetirement,
    },
  ]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await screen.findByText('Receipt');
  expect(screen.getByText('ONLINE')).toBeVisible();
  expect(screen.getByText('Retired')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Retire Receipt' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled();
  expect(h.retire).not.toHaveBeenCalled();
});

it('allows authorized retirement when the owning bridge is revoked', async () => {
  h.devices.mockResolvedValue([{ ...bridge, status: 'REVOKED', revokedAt: new Date() }]);
  h.printers.mockResolvedValue([
    { ...printer, bridge: { ...printer.bridge, status: 'REVOKED', revokedAt: new Date() } },
  ]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
  await openRetirement();
  confirmRetirement();
  await screen.findByText(/Retired Receipt/);
  expect(h.retire).toHaveBeenCalledOnce();
});

it.each([
  'registered route',
  'unfinished print job',
  'transaction isolation mismatch',
  'printer changed concurrently',
])('reports a definite %s conflict and never retries the mutation', async (blocker) => {
  h.retire.mockRejectedValueOnce({
    data: { code: 'CONFLICT' },
    message: `${blocker}: private server detail`,
  });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  expect(await screen.findByRole('alert')).toHaveTextContent('server reported a conflict');
  expect(screen.getByRole('alert')).toHaveTextContent('No retirement was saved by this request');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private server detail');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'I reviewed the current inventory' })).toBeEnabled()
  );
  expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeDisabled();
  expect(h.retire).toHaveBeenCalledOnce();
});

it('keeps a definite missing-target error separate from uncertainty', async () => {
  h.retire.mockRejectedValueOnce({ data: { code: 'NOT_FOUND' } });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be retired');
  expect(screen.queryByText(/Retirement outcome is uncertain/)).not.toBeInTheDocument();
  expect(h.retire).toHaveBeenCalledOnce();
});

it('blocks duplicate clicks, cross-mutations, branch changes, and dismissal while retiring', async () => {
  const pending = deferred<ReturnType<typeof retirementResult>>();
  h.retire.mockReturnValue(pending.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  const form = screen.getByRole('button', { name: 'Confirm retirement' }).closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(h.retire).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Cancel retirement' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retiring…' })).toBeDisabled();
  expect(screen.getByLabelText('Inventory branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Register printers', hidden: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Rename Receipt', hidden: true })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await act(async () => pending.resolve(retirementResult()));
  await screen.findByText(/Retired Receipt/);
  expect(h.mutate).not.toHaveBeenCalled();
  expect(h.rename).not.toHaveBeenCalled();
});

it('does not start retirement during an in-flight registration', async () => {
  const pending = deferred<{ registered: number }>();
  h.mutate.mockReturnValue(pending.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRegistration();
  save();
  const retire = screen.getByRole('button', { name: 'Retire Receipt', hidden: true });
  expect(retire).toBeDisabled();
  fireEvent.click(retire);
  expect(h.retire).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ registered: 1 }));
});

it('does not start retirement during an in-flight rename', async () => {
  const pending = deferred<ReturnType<typeof renameResult>>();
  h.rename.mockReturnValue(pending.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRename();
  saveName();
  const retire = screen.getByRole('button', { name: 'Retire Receipt', hidden: true });
  expect(retire).toBeDisabled();
  fireEvent.click(retire);
  expect(h.retire).not.toHaveBeenCalled();
  await act(async () => pending.resolve(renameResult()));
});

it('keeps uncertainty explicit when the fresh read fails and requires a later reviewed inventory', async () => {
  h.retire.mockRejectedValueOnce(new Error('lost response with private detail'));
  h.printers
    .mockResolvedValueOnce([printer])
    .mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValueOnce([printer]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Retirement outcome is uncertain');
  expect(alert).not.toHaveTextContent('private detail');
  expect(screen.getByRole('button', { name: 'I reviewed the current inventory' })).toBeDisabled();
  await screen.findByText(/Printers could not be loaded/);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'I reviewed the current inventory' })).toBeEnabled()
  );
  expect(h.retire).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current inventory' }));
  expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeEnabled();
  expect(h.retire).toHaveBeenCalledOnce();
});

it('keeps a confirmed retirement receipt after an authorized refresh during the pending command', async () => {
  const pending = deferred<ReturnType<typeof retirementResult>>();
  h.retire.mockReturnValue(pending.promise);
  h.printers
    .mockResolvedValueOnce([printer])
    .mockResolvedValueOnce([printer])
    .mockResolvedValueOnce([{ ...printer, retiredAt: savedRetirement }]);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
  await act(async () => pending.resolve(retirementResult()));
  const receipt = await screen.findByText(/Retired Receipt/);
  expect(receipt.closest('[role="status"]')?.querySelector('time')).toHaveAttribute(
    'datetime',
    savedRetirement.toISOString()
  );
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(/Retirement outcome is uncertain/)).not.toBeInTheDocument();
  expect(h.retire).toHaveBeenCalledOnce();
});

it('requires a post-outcome read after an authorized refresh before acknowledging uncertainty', async () => {
  const pending = deferred<ReturnType<typeof retirementResult>>();
  const afterOutcome = deferred<(typeof printer)[]>();
  h.retire.mockReturnValue(pending.promise);
  h.printers
    .mockResolvedValueOnce([printer])
    .mockResolvedValueOnce([printer])
    .mockReturnValueOnce(afterOutcome.promise);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
  await act(async () => pending.reject(new Error('unknown with private detail')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Retirement outcome is uncertain');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private detail');
  await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(3));
  expect(screen.getByRole('button', { name: 'I reviewed the current inventory' })).toBeDisabled();
  await act(async () => afterOutcome.resolve([printer]));
  expect(screen.getByRole('button', { name: 'I reviewed the current inventory' })).toBeEnabled();
  expect(h.retire).toHaveBeenCalledOnce();
});

it.each(['register', 'rename'] as const)(
  'blocks %s opening and an already-open form until retirement is explicitly reconciled',
  async (kind) => {
    const afterOutcome = deferred<(typeof printer)[]>();
    h.retire.mockRejectedValueOnce(new Error('lost response'));
    h.printers.mockResolvedValueOnce([printer]).mockReturnValueOnce(afterOutcome.promise);
    render(<PrinterInventoryPanel ownerKey="org:admin" />);
    await chooseBranch();
    if (kind === 'register') await openRegistration();
    else await openRename();
    fireEvent.click(screen.getByRole('button', { name: 'Retire Receipt', hidden: true }));
    confirmRetirement();
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent(
      'Retirement outcome is uncertain'
    );
    await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
    await act(async () => afterOutcome.resolve([printer]));
    expect(
      screen.getByRole('button', { name: 'I reviewed the current inventory', hidden: true })
    ).toBeEnabled();
    const saveButton = screen.getByRole('button', {
      name: kind === 'register' ? 'Save printers' : 'Save printer name',
    });
    expect(saveButton).toBeDisabled();
    fireEvent.submit(saveButton.closest('form')!);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: kind === 'register' ? 'Cancel' : 'Cancel rename' })
    );
    expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh printers' })).toBeEnabled();
    expect(screen.getByLabelText('Inventory branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current inventory' }));
    expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeEnabled();
    expect(h.retire).toHaveBeenCalledOnce();
  }
);

it('hides inventory after retirement permission loss until a fresh authorized read', async () => {
  h.retire.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' } });
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  await screen.findByText(/Refresh to check your access again/);
  expect(screen.queryByRole('button', { name: 'Retire Receipt' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Retired Receipt/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeEnabled());
  expect(h.retire).toHaveBeenCalledOnce();
});

it('ignores retirement success after an owner remount', async () => {
  const pending = deferred<ReturnType<typeof retirementResult>>();
  h.retire.mockReturnValue(pending.promise);
  const view = render(<PrinterInventoryPanel key="a" ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  view.rerender(<PrinterInventoryPanel key="b" ownerKey="org:other" />);
  await act(async () => pending.resolve(retirementResult()));
  expect(screen.queryByText(/Retired Receipt/)).not.toBeInTheDocument();
  expect(h.printers).toHaveBeenCalledOnce();
});

it.each(['success', 'unknown error'] as const)(
  'releases the obsolete %s operation after a same-instance owner A/B/A transition',
  async (outcome) => {
    const pending = deferred<ReturnType<typeof retirementResult>>();
    h.retire.mockReturnValue(pending.promise);
    const view = render(<PrinterInventoryPanel ownerKey="org:admin" />);
    await chooseBranch();
    await openRetirement();
    confirmRetirement();
    view.rerender(<PrinterInventoryPanel ownerKey="other:user" />);
    view.rerender(<PrinterInventoryPanel ownerKey="org:admin" />);
    if (outcome === 'success') await act(async () => pending.resolve(retirementResult()));
    else await act(async () => pending.reject(new Error('unknown private detail')));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Rename Receipt' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retire Receipt' })).toBeEnabled();
    expect(screen.queryByText(/Retired Receipt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retirement outcome is uncertain/)).not.toBeInTheDocument();
    expect(h.retire).toHaveBeenCalledOnce();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
  }
);

it('ignores retirement success after a permission-denied read supersedes its generation', async () => {
  const pending = deferred<ReturnType<typeof retirementResult>>();
  h.retire.mockReturnValue(pending.promise);
  h.printers
    .mockResolvedValueOnce([printer])
    .mockRejectedValueOnce({ data: { code: 'FORBIDDEN' } });
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />);
  await screen.findByText(/Refresh to check your access again/);
  await act(async () => pending.resolve(retirementResult()));
  expect(screen.queryByText(/Retired Receipt/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retire Receipt' })).not.toBeInTheDocument();
  expect(h.retire).toHaveBeenCalledOnce();
});

it('ignores an old branch refresh after a retirement and branch switch', async () => {
  const old = deferred<(typeof printer)[]>();
  h.printers
    .mockResolvedValueOnce([printer])
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([{ ...printer, id: 'other', branchId: 'b', name: 'Uptown printer' }]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  await chooseBranch();
  await openRetirement();
  confirmRetirement();
  await screen.findByText(/Retired Receipt/);
  await chooseBranch('b');
  await screen.findByText('Uptown printer');
  await act(async () => old.resolve([{ ...printer, name: 'Obsolete Downtown' }]));
  expect(screen.getByText('Uptown printer')).toBeVisible();
  expect(screen.queryByText('Obsolete Downtown')).not.toBeInTheDocument();
  expect(h.retire).toHaveBeenCalledOnce();
});
