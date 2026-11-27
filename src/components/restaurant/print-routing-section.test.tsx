import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintRoutingConfig } from '@/lib/restaurant/printing/contract';
const h = vi.hoisted(() => {
  const printers = vi.fn();
  return {
    session: { user: { id: 'user', organizationId: 'org' } },
    organizationId: 'org',
    status: 'authenticated',
    printers,
    client: { restaurantDevices: { listPrinters: { query: printers } } },
    success: vi.fn(),
  };
});
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session, status: h.status }) }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: h.organizationId }),
}));
vi.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => ({ client: h.client }) } }));
vi.mock('sonner', () => ({ toast: { success: h.success } }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    'aria-label': label,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
    'aria-label': string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
import { PrintRoutingSection } from './print-routing-section';
type Branch = {
  id: string;
  name: string;
  kitchenStations: Array<{ id: string; name: string }>;
  config: PrintRoutingConfig;
};
const target = 'tcp://receipt:9100';
const receipt = (id: string | null = null) => ({
  documentType: 'RECEIPT' as const,
  stationId: null,
  printerId: target,
  registeredPrinterId: id,
  enabled: true,
});
const branch = (id: string, routes: PrintRoutingConfig['routes'] = [receipt()]): Branch => ({
  id,
  name: `Branch ${id}`,
  kitchenStations: [{ id: 'hot', name: 'Hot' }],
  config: { branchId: id, routes },
});
const printer = (id: string, branchId = 'A', address = target) => ({
  id,
  branchId,
  address,
  name: `Printer ${id}`,
  bridge: {
    id: `bridge-${id}`,
    name: `Bridge ${id}`,
    kind: 'PRINT_BRIDGE',
    status: 'ACTIVE',
    revokedAt: null,
  },
  status: 'OFFLINE',
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let branches: Branch[];
let fetchMock: ReturnType<typeof vi.fn>;
async function server(_url: unknown, options?: RequestInit) {
  if (options?.method === 'PUT') {
    const parsed = JSON.parse(options.body as string) as PrintRoutingConfig;
    const config = { branchId: parsed.branchId, routes: parsed.routes };
    branches = branches.map((item) => (item.id === config.branchId ? { ...item, config } : item));
    return response({ config });
  }
  if (options?.method === 'POST')
    return response({ result: { status: 'QUEUED', printerId: target } }, 202);
  return response({ branches });
}
const calls = (method: string) => fetchMock.mock.calls.filter((call) => call[1]?.method === method);
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save print routes' }));
async function ready() {
  await screen.findByLabelText('Receipts printer ID');
  await waitFor(() =>
    expect(screen.queryByText('Loading printer inventory…')).not.toBeInTheDocument()
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  h.session = { user: { id: 'user', organizationId: 'org' } };
  h.organizationId = 'org';
  h.status = 'authenticated';
  branches = [branch('A'), branch('B')];
  h.printers.mockResolvedValue([printer('p1'), printer('p2')]);
  fetchMock = vi.fn(server);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('printer selection and legacy preservation', () => {
  it('sets registry ID and exact raw address and makes registered addresses read-only', async () => {
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Receipts destination', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'p1' } }
    );
    expect(screen.getByLabelText('Receipts printer ID')).toHaveAttribute('readonly');
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(calls('PUT')[0][1].body).routes[0]).toMatchObject({
      printerId: target,
      registeredPrinterId: 'p1',
    });
    await screen.findByText(/This save is confirmed/);
  });
  it('requires explicit manual selection before clearing a saved registry reference', async () => {
    branches = [branch('A', [receipt('gone')])];
    h.printers.mockRejectedValue({ data: { code: 'FORBIDDEN' } });
    render(<PrintRoutingSection />);
    await ready();
    expect(
      screen.getByRole('option', { hidden: true, name: /Saved binding unavailable/ })
    ).toHaveValue('gone');
    expect(screen.getByLabelText('Receipts printer ID')).toHaveAttribute('readonly');
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Receipts destination', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: '' } }
    );
    expect(screen.getByLabelText('Receipts printer ID')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Receipts printer ID')).toHaveValue(target);
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(calls('PUT')[0][1].body).routes[0]).toEqual(receipt(null));
  });
  it('preserves unavailable bindings and all additional station routes in a save', async () => {
    const extra = { ...receipt('unavailable'), stationId: 'hot', enabled: false };
    branches = [branch('A', [receipt(), extra])];
    h.printers.mockRejectedValue(new Error('denied'));
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Manual' },
    });
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(calls('PUT')[0][1].body).routes).toEqual([
      { ...receipt(), printerId: 'queue:///Manual' },
      extra,
    ]);
  });
  it('does not offer printers from another branch or inactive/non-bridge devices', async () => {
    h.printers.mockResolvedValue([
      printer('valid'),
      printer('other', 'B'),
      { ...printer('pos'), bridge: { ...printer('pos').bridge, kind: 'POS' } },
      { ...printer('revoked'), bridge: { ...printer('revoked').bridge, revokedAt: new Date() } },
    ]);
    render(<PrintRoutingSection />);
    await ready();
    expect(screen.getAllByRole('option', { hidden: true, name: /Printer valid/ })).toHaveLength(3);
    expect(
      screen.queryByRole('option', {
        hidden: true,
        name: /Printer other|Printer pos|Printer revoked/,
      })
    ).not.toBeInTheDocument();
  });
  it('removes only the displayed first route explicitly', async () => {
    const extra = { ...receipt('p2'), stationId: 'hot', enabled: false };
    branches = [branch('A', [receipt(), extra])];
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove displayed receipts route' }));
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(calls('PUT')[0][1].body).routes).toEqual([extra]);
  });
  it('preserves sibling branch drafts while saving the selected branch', async () => {
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///DraftA' },
    });
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'B' } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///DraftB' },
    });
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'A' } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled()
    );
    save();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled()
    );
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'B' } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled()
    );
    expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///DraftB');
    expect(JSON.parse(calls('PUT')[0][1].body).branchId).toBe('A');
  });
});

describe('save confirmation and reconciliation', () => {
  it('blocks a stale baseline before sending PUT and retains the draft', async () => {
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Draft' },
    });
    branches[0] = branch('A', [{ ...receipt(), printerId: 'queue:///Elsewhere' }]);
    save();
    await screen.findByText(/Saved routes changed/);
    expect(calls('PUT')).toHaveLength(0);
    expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///Draft');
    fireEvent.click(screen.getByRole('button', { name: 'Keep draft with refreshed baseline' }));
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled();
    expect(calls('PUT')).toHaveLength(0);
  });
  it('guards duplicate save clicks synchronously', async () => {
    const pending = deferred<Response>();
    let reads = 0;
    fetchMock.mockImplementation((url, options) =>
      !options?.method && ++reads === 2 ? pending.promise : server(url, options)
    );
    render(<PrintRoutingSection />);
    await ready();
    act(() => {
      save();
      save();
    });
    expect(reads).toBe(2);
    expect(calls('PUT')).toHaveLength(0);
    await act(async () => pending.resolve(response({ branches })));
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
  });
  it('retains confirmed success when the following refresh fails', async () => {
    let saved = false;
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        saved = true;
        return server(url, options);
      }
      if (saved && !options?.method) throw new Error('refresh failed');
      return server(url, options);
    });
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Confirmed' },
    });
    save();
    await screen.findByText(/This save is confirmed/);
    await screen.findByText(/could not be refreshed/);
    expect(calls('PUT')).toHaveLength(1);
    expect(h.success).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeEnabled();
  });
  it('does not retry an uncertain PUT and requires an explicit decision after a matching fresh read', async () => {
    fetchMock.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        await server(url, options);
        throw new Error('lost response');
      }
      return server(url, options);
    });
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Changed' },
    });
    save();
    await screen.findByText(/Save outcome is uncertain/);
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved routes' }));
    await screen.findByText(/Saved routes match your submission/);
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use saved routes' }));
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled();
    expect(calls('PUT')).toHaveLength(1);
  });
  it('keeps uncertain state attached to its original branch across navigation', async () => {
    fetchMock.mockImplementation(async (url, options) =>
      options?.method === 'PUT' ? response({}, 500) : server(url, options)
    );
    render(<PrintRoutingSection />);
    await ready();
    save();
    await screen.findByText(/Save outcome is uncertain/);
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'B' } }
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save print routes' })).toBeEnabled()
    );
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'A' } }
    );
    await screen.findByText(/Saved routes match your submission/);
    expect(screen.getByRole('button', { name: 'Save print routes' })).toBeDisabled();
    expect(calls('PUT')).toHaveLength(1);
  });
  it.each([400, 409])(
    'retains draft and rejects response %s without success or automatic retry',
    async (status) => {
      fetchMock.mockImplementation((url, options) =>
        options?.method === 'PUT' ? Promise.resolve(response({}, status)) : server(url, options)
      );
      render(<PrintRoutingSection />);
      await ready();
      fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
        target: { value: 'queue:///Draft' },
      });
      save();
      await screen.findByRole('alert');
      expect(h.success).not.toHaveBeenCalled();
      expect(calls('PUT')).toHaveLength(1);
      expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///Draft');
    }
  );
});

describe('owner, branch and receipt-test isolation', () => {
  it('hides routing when owner context is unavailable or mismatched', () => {
    h.organizationId = 'other';
    render(<PrintRoutingSection />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Receipts printer ID')).not.toBeInTheDocument();
  });
  it('does not expose prior owner data or late save notifications after a switch', async () => {
    const put = deferred<Response>();
    fetchMock.mockImplementation((url, options) =>
      options?.method === 'PUT' ? put.promise : server(url, options)
    );
    const view = render(<PrintRoutingSection />);
    await ready();
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    h.organizationId = 'other';
    view.rerender(<PrintRoutingSection />);
    await act(async () => put.resolve(response({})));
    expect(h.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/This save is confirmed/)).not.toBeInTheDocument();
  });
  it('discards obsolete A inventory after A to B to A navigation', async () => {
    const first = deferred<unknown>();
    let reads = 0;
    h.printers.mockImplementation(({ branchId }: { branchId: string }) =>
      ++reads === 1
        ? first.promise
        : Promise.resolve([printer(reads === 2 ? 'B-fresh' : 'A-fresh', branchId)])
    );
    render(<PrintRoutingSection />);
    await screen.findByLabelText('Branch', {
      selector: ':not([data-select-field-native][aria-hidden="true"])',
    });
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'B' } }
    );
    await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(2));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'A' } }
    );
    await waitFor(() => expect(h.printers).toHaveBeenCalledTimes(3));
    await act(async () => first.resolve([printer('obsolete')]));
    expect(
      screen.queryByRole('option', { hidden: true, name: /Printer obsolete/ })
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { hidden: true, name: /Printer A-fresh/ })).toHaveLength(
      3
    );
  });
  it('configuration denial blocks actions despite inventory access', async () => {
    fetchMock.mockResolvedValue(response({}, 403));
    render(<PrintRoutingSection />);
    await screen.findAllByText(/permission to configure printing/);
    expect(screen.queryByRole('button', { name: 'Save print routes' })).not.toBeInTheDocument();
    expect(calls('PUT')).toHaveLength(0);
  });
  it('reuses receipt intent for retries and changes it when registry identity changes at the same address', async () => {
    branches = [branch('A', [receipt('p1')])];
    render(<PrintRoutingSection />);
    await ready();
    const test = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    test();
    await screen.findByText(/Paper output is not confirmed/);
    test();
    await waitFor(() => expect(calls('POST')).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeEnabled()
    );
    expect(calls('POST')[0][1].body).toBe(calls('POST')[1][1].body);
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Receipts destination', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'p2' } }
    );
    save();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeEnabled()
    );
    test();
    await waitFor(() => expect(calls('POST')).toHaveLength(3));
    expect(JSON.parse(calls('POST')[2][1].body).idempotencyKey).not.toBe(
      JSON.parse(calls('POST')[0][1].body).idempotencyKey
    );
  });
});

describe('refresh transition regressions', () => {
  it('drops a reverted clean draft when the saved baseline changes', async () => {
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Temporary' },
    });
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), { target: { value: target } });
    branches[0] = branch('A', [{ ...receipt(), printerId: 'queue:///NewSaved' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved routes' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///NewSaved')
    );
    expect(screen.queryByText(/Saved routes changed/)).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(calls('PUT')[0][1].body).routes[0].printerId).toBe('queue:///NewSaved');
  });
  it('canonicalizes contract whitespace and field order without false post-save conflict', async () => {
    const extra = { ...receipt(), documentType: 'BAR_TICKET' as const, stationId: 'hot' };
    branches = [branch('A', [receipt(), extra])];
    fetchMock.mockImplementation(async (url, options) => {
      const result = await server(url, options);
      if (options?.method === 'PUT')
        branches = branches.map((item) => ({
          ...item,
          config: {
            ...item.config,
            routes: [...item.config.routes].reverse().map((route) => ({
              enabled: route.enabled,
              registeredPrinterId: route.registeredPrinterId,
              printerId: route.printerId.trim(),
              stationId: route.stationId,
              documentType: route.documentType,
            })),
          },
        }));
      return result;
    });
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: '  queue:///Trimmed  ' },
    });
    save();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeEnabled()
    );
    expect(JSON.parse(calls('PUT')[0][1].body).routes[0].printerId).toBe('queue:///Trimmed');
    expect(screen.queryByText(/Saved routes changed/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///Trimmed');
  });
  it('discards old owner configuration reads after a fully authenticated owner switch', async () => {
    const old = deferred<Response>();
    fetchMock.mockImplementationOnce(() => old.promise);
    const view = render(<PrintRoutingSection />);
    h.session = { user: { id: 'new-user', organizationId: 'new-org' } };
    h.organizationId = 'new-org';
    branches = [branch('NEW', [{ ...receipt(), printerId: 'queue:///NewOwner' }])];
    view.rerender(<PrintRoutingSection />);
    await screen.findByDisplayValue('queue:///NewOwner');
    await act(async () =>
      old.resolve(
        response({ branches: [branch('OLD', [{ ...receipt(), printerId: 'queue:///OldOwner' }])] })
      )
    );
    expect(screen.queryByDisplayValue('queue:///OldOwner')).not.toBeInTheDocument();
    expect(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('NEW');
  });
  it('ignores obsolete REST branch responses after A to B to A navigation', async () => {
    render(<PrintRoutingSection />);
    await ready();
    const oldA = deferred<Response>();
    fetchMock.mockImplementationOnce(() => oldA.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved routes' }));
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'B' } }
    );
    branches[0] = branch('A', [{ ...receipt(), printerId: 'queue:///FreshA' }]);
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: 'A' } }
    );
    await screen.findByDisplayValue('queue:///FreshA');
    await act(async () =>
      oldA.resolve(
        response({
          branches: [branch('A', [{ ...receipt(), printerId: 'queue:///Obsolete' }]), branch('B')],
        })
      )
    );
    expect(screen.getByLabelText('Receipts printer ID')).toHaveValue('queue:///FreshA');
    expect(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('A');
  });
  it('guards duplicate receipt clicks and preserves the same intent after an uncertain response', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url, options) =>
      options?.method === 'POST' ? pending.promise : server(url, options)
    );
    render(<PrintRoutingSection />);
    await ready();
    const button = screen.getByRole('button', { name: 'Test receipt printer' });
    const preflight = deferred<Response>();
    fetchMock.mockImplementationOnce(() => preflight.promise);
    const before = fetchMock.mock.calls.length;
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(fetchMock.mock.calls).toHaveLength(before + 1);
    expect(calls('POST')).toHaveLength(0);
    await act(async () => preflight.resolve(response({ branches })));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    await act(async () => pending.reject(new Error('lost response')));
    await screen.findByText(/Delivery may be uncertain/);
    fetchMock.mockImplementation(server);
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(2));
    expect(calls('POST')[0][1].body).toBe(calls('POST')[1][1].body);
  });
  it('uses a new receipt intent when explicitly switching from registered to manual at the same address', async () => {
    branches = [branch('A', [receipt('p1')])];
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await screen.findByText(/Paper output is not confirmed/);
    fireEvent.change(
      selectFieldControl(
        screen.getByLabelText('Receipts destination', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      { target: { value: '' } }
    );
    save();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(2));
    expect(JSON.parse(calls('POST')[0][1].body).idempotencyKey).not.toBe(
      JSON.parse(calls('POST')[1][1].body).idempotencyKey
    );
  });
});

describe('receipt route preflight', () => {
  it('requires review when the registry owner changed at the same address before testing', async () => {
    branches = [branch('A', [receipt('p1')])];
    render(<PrintRoutingSection />);
    await ready();
    branches = [branch('A', [receipt('p2')])];
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await screen.findByText(/Saved routes changed/);
    expect(calls('POST')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use saved routes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
  });
  it('sends no receipt test when the fresh configuration read fails', async () => {
    render(<PrintRoutingSection />);
    await ready();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await screen.findByText(/No receipt test was sent/);
    expect(calls('POST')).toHaveLength(0);
  });
  it('sends no receipt test after an owner change while its preflight is pending', async () => {
    const view = render(<PrintRoutingSection />);
    await ready();
    const pending = deferred<Response>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    h.organizationId = 'other';
    view.rerender(<PrintRoutingSection />);
    await act(async () => pending.resolve(response({ branches })));
    expect(calls('POST')).toHaveLength(0);
  });
});

describe('atomic routing UI guards', () => {
  it('sends the original full baseline separately from the edited draft', async () => {
    const extra = { ...receipt('p2'), stationId: 'hot', enabled: false };
    branches = [branch('A', [receipt(), extra])];
    const baseline = structuredClone(branches[0].config);
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.change(screen.getByLabelText('Receipts printer ID'), {
      target: { value: 'queue:///Draft' },
    });
    save();
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    const payload = JSON.parse(calls('PUT')[0][1].body);
    expect(payload.expectedConfig).toEqual(baseline);
    expect(payload.routes).toEqual([{ ...receipt(), printerId: 'queue:///Draft' }, extra]);
  });
  it.each([null, 'p1'])(
    'sends the saved address and explicit registry identity %s for receipt tests',
    async (id) => {
      branches = [branch('A', [receipt(id)])];
      render(<PrintRoutingSection />);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
      await waitFor(() => expect(calls('POST')).toHaveLength(1));
      expect(JSON.parse(calls('POST')[0][1].body).expectedDestination).toEqual({
        printerId: target,
        registeredPrinterId: id,
      });
    }
  );
  it('requires fresh explicit reconciliation after a server-side conflict and retains the same receipt intent', async () => {
    fetchMock.mockImplementation((url, options) =>
      options?.method === 'POST'
        ? response({ code: 'REFRESH_REQUIRED' }, 409)
        : server(url, options)
    );
    render(<PrintRoutingSection />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await screen.findByText(/Receipt test was rejected/);
    expect(screen.queryByText(/Delivery may be uncertain/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test receipt printer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use saved routes' })).toBeDisabled();
    expect(calls('POST')).toHaveLength(1);
    fetchMock.mockImplementation(server);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved routes' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use saved routes' })).toBeEnabled()
    );
    expect(calls('POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use saved routes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test receipt printer' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(2));
    expect(calls('POST')[0][1].body).toBe(calls('POST')[1][1].body);
  });
});
