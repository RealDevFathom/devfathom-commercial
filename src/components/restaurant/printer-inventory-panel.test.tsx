import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => {
  const branches = vi.fn(), printers = vi.fn(), devices = vi.fn(), mutate = vi.fn(), reset = vi.fn();
  return { branches, printers, devices, mutate, reset, options: null as unknown, client: { restaurantStaff: { listBranches: { query: branches } }, restaurantDevices: { listPrinters: { query: printers }, list: { query: devices } } } };
});
vi.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => ({ client: h.client }), restaurantDevices: { registerPrinters: { useMutation: (options: unknown) => { h.options = options; return { mutateAsync: h.mutate, reset: h.reset }; } } } } }));
import { PrinterInventoryPanel } from './printer-inventory-panel';
const branches = [{ id: 'a', name: 'Downtown', active: true, isDefault: true }, { id: 'b', name: 'Uptown', active: true, isDefault: false }, { id: 'closed', name: 'Closed', active: false, isDefault: false }];
const bridge = { id: 'bridge', name: 'Kitchen host', kind: 'PRINT_BRIDGE', branch: { id: 'a', name: 'Downtown' }, status: 'ACTIVE', revokedAt: null };
const printer = { id: 'printer', name: 'Receipt', address: 'tcp://printer:9100', paperWidthMm: 80, status: 'OFFLINE', lastSeenAt: null, bridge: { id: 'bridge', name: 'Kitchen host' } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks(); h.branches.mockResolvedValue(branches); h.devices.mockResolvedValue([bridge]); h.printers.mockResolvedValue([printer]); h.mutate.mockResolvedValue({ registered: 1 });
});
async function chooseBranch(id = 'a') {
  await waitFor(() => expect(screen.getByLabelText('Inventory branch')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Inventory branch'), { target: { value: id } });
}
async function openRegistration() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Register printers' }));
  fireEvent.change(screen.getByLabelText('Print bridge'), { target: { value: 'bridge' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  fireEvent.change(screen.getByLabelText('Printer 1 name'), { target: { value: ' Receipt ' } });
  fireEvent.change(screen.getByLabelText('Printer 1 target'), { target: { value: ' tcp://printer:9100 ' } });
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save printers' }));
it('keeps an invalid target editable without issuing a mutation and enables a correction', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration();
  fireEvent.change(screen.getByLabelText('Printer 1 target'), { target: { value: 'https://printer' } });
  expect(screen.getByLabelText('Printer 1 target')).toHaveAttribute('aria-invalid', 'true'); expect(screen.getByRole('alert')).toHaveTextContent('valid TCP');
  const button = screen.getByRole('button', { name: 'Save printers' }); expect(button).toBeDisabled(); fireEvent.submit(button.closest('form')!); expect(h.mutate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Printer 1 target'), { target: { value: 'queue:///Receipt%20Printer' } }); expect(button).toBeEnabled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('keeps reconciliation blocked after a failed refresh until the original branch reloads successfully', async () => {
  h.printers.mockResolvedValueOnce([printer]).mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce([printer]); h.mutate.mockRejectedValue(new Error('uncertain'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save();
  await screen.findByText('Printers could not be loaded. Refresh the list to try again.');
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh printers' })); await waitFor(() => expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled());
  expect(h.mutate).toHaveBeenCalledOnce();
});
it('requires an active branch, reads management inventory independently, and does not invent telemetry', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />);
  expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
  await chooseBranch(); expect(screen.queryByRole('option', { name: 'Closed' })).not.toBeInTheDocument();
  await screen.findByText('Receipt'); expect(h.printers).toHaveBeenCalledExactlyOnceWith({ branchId: 'a' }); expect(h.devices).toHaveBeenCalledOnce();
  expect(screen.getAllByText('Not reported')).toHaveLength(2); expect(screen.queryByText('OFFLINE')).not.toBeInTheDocument();
});
it('rejects demo-directory success when management inventory authorization fails', async () => {
  h.printers.mockRejectedValue({ data: { code: 'FORBIDDEN' }, message: 'private detail' });
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch();
  expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private detail'); expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});
it('offers only active non-revoked print bridges in the selected branch', async () => {
  h.devices.mockResolvedValue([bridge, { ...bridge, id: 'pos', name: 'POS', kind: 'POS' }, { ...bridge, id: 'wrong', name: 'Other branch', branch: { id: 'b', name: 'Uptown' } }, { ...bridge, id: 'revoked', name: 'Revoked', revokedAt: new Date() }, { ...bridge, id: 'inactive', name: 'Inactive', status: 'REVOKED' }]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration();
  expect(within(screen.getByLabelText('Print bridge')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a print bridge', 'Kitchen host']);
});
it('snapshots the target and suppresses simultaneous duplicate submissions and dismissal', async () => {
  const command = deferred<{ registered: number }>(); h.mutate.mockReturnValue(command.promise);
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration();
  const form = screen.getByRole('button', { name: 'Save printers' }).closest('form')!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(h.mutate).toHaveBeenCalledExactlyOnceWith({ branchId: 'a', bridgeId: 'bridge', printers: [{ name: 'Receipt', address: 'tcp://printer:9100', paperWidthMm: 80 }] });
  expect(h.options).toEqual({ retry: false, gcTime: 0 }); expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled(); expect(screen.getByLabelText('Printer 1 name')).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.getByRole('dialog')).toBeInTheDocument();
  await act(async () => { command.resolve({ registered: 1 }); }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(await screen.findByText(/Registered 1 printer/)).toBeVisible();
});
it('retains uncertainty across branch changes and requires reconciliation against its original target', async () => {
  h.mutate.mockRejectedValue(new Error('private sql and credentials'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save();
  expect(await screen.findByRole('alert')).toHaveTextContent('Kitchen host in Downtown'); expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  await chooseBranch('b'); await waitFor(() => expect(h.printers).toHaveBeenCalledWith({ branchId: 'b' }));
  expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
  await chooseBranch('a'); await waitFor(() => expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'I have reconciled the printers' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Register printers' })).toBeEnabled()); expect(h.mutate).toHaveBeenCalledOnce();
});
it('requires fresh inventory after an uncertain write before reconciliation can be acknowledged', async () => {
  const refresh = deferred<typeof printer[]>(); h.printers.mockResolvedValueOnce([printer]).mockReturnValueOnce(refresh.promise); h.mutate.mockRejectedValue(new Error('uncertain'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save();
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeDisabled();
  await act(async () => { refresh.resolve([printer]); }); expect(screen.getByRole('button', { name: 'I have reconciled the printers' })).toBeEnabled();
});
it('clears an earlier success receipt when a later registration becomes uncertain', async () => {
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save(); await screen.findByText(/Registered 1 printer/);
  h.mutate.mockRejectedValue(new Error('uncertain')); await openRegistration(); save(); await screen.findByRole('alert');
  expect(screen.queryByText(/Registration is confirmed/)).not.toBeInTheDocument();
});
it('keeps confirmed success separate from a failed list refresh without resubmitting', async () => {
  h.printers.mockResolvedValueOnce([printer]).mockRejectedValue(new Error('read failed'));
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save(); await screen.findByText(/Registered 1 printer/);
  expect(await screen.findByRole('alert')).toHaveTextContent('Printers could not be loaded'); expect(screen.queryByRole('button', { name: 'I have reconciled the printers' })).not.toBeInTheDocument(); expect(h.mutate).toHaveBeenCalledOnce();
});
it('discards obsolete inventory responses during an A/B/A branch race', async () => {
  const old = deferred<typeof printer[]>(); h.printers.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...printer, name: 'Current' }]);
  render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch('a'); await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(1));
  await chooseBranch('b'); await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2)); await chooseBranch('a'); await screen.findByText('Current');
  await act(async () => { old.resolve([{ ...printer, name: 'Obsolete' }]); }); expect(screen.getByText('Current')).toBeVisible(); expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
});
it('hides prior-owner inventory immediately and requires a fresh directory', async () => {
  const next = deferred<typeof branches>(); const view = render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await screen.findByText('Receipt');
  h.branches.mockReturnValueOnce(next.promise); view.rerender(<PrinterInventoryPanel ownerKey="org:other" />);
  expect(screen.queryByText('Receipt')).not.toBeInTheDocument(); expect(screen.getByLabelText('Inventory branch')).toBeDisabled();
  await act(async () => { next.resolve([]); }); expect(h.branches).toHaveBeenCalledTimes(2); expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});
it('ignores a mutation result after an owner A/B/A transition', async () => {
  const command = deferred<{ registered: number }>(); h.mutate.mockReturnValue(command.promise);
  const view = render(<PrinterInventoryPanel key="org:admin" ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save();
  view.rerender(<PrinterInventoryPanel key="org:other" ownerKey="org:other" />); view.rerender(<PrinterInventoryPanel key="org:admin" ownerKey="org:admin" />);
  await act(async () => { command.resolve({ registered: 1 }); }); expect(screen.queryByText(/Registered 1 printer/)).not.toBeInTheDocument();
});
it('does not apply a late mutation after unmount', async () => {
  const command = deferred<{ registered: number }>(); h.mutate.mockReturnValue(command.promise);
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" />); await chooseBranch(); await openRegistration(); save(); view.unmount();
  await act(async () => { command.resolve({ registered: 1 }); }); expect(h.printers).toHaveBeenCalledOnce();
});
it('retries a failed branch directory without reading unauthorized inventory', async () => {
  h.branches.mockRejectedValueOnce(new Error('failure')); render(<PrinterInventoryPanel ownerKey="org:admin" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Branches could not be loaded'); expect(h.printers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry branches' })); await chooseBranch(); await screen.findByText('Receipt');
});
it('refreshes inventory and eligible bridges when device changes are reported', async () => {
  const view = render(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={0} />); await chooseBranch(); await screen.findByText('Receipt');
  h.devices.mockResolvedValue([]); view.rerender(<PrinterInventoryPanel ownerKey="org:admin" refreshVersion={1} />); await screen.findByText(/No active print bridge/);
  expect(h.printers).toHaveBeenCalledTimes(2); expect(h.devices).toHaveBeenCalledTimes(2); expect(screen.getByRole('button', { name: 'Register printers' })).toBeDisabled();
});
