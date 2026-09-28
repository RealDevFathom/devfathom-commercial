import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  type UseMutationOptions,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  detail: vi.fn(),
  requirements: vi.fn(),
  costs: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addLine: vi.fn(),
  removeLine: vi.fn(),
  addExtra: vi.fn(),
  removeExtra: vi.fn(),
  delivery: vi.fn(),
  transition: vi.fn(),
}));
const orderA = {
  id: 'order_a',
  branchId: 'branch_1',
  customerId: null,
  eventName: 'Founders dinner',
  eventDate: '2026-09-20T00:00:00Z',
  serviceTime: null,
  headcount: 40,
  venueAddress: 'Atrium',
  deliveryAddressId: null,
  status: 'DRAFT',
  quotedTotal: '1200',
  depositAmount: '200',
  notes: null,
  lines: [{ id: 'line_a', description: 'Lunch', portions: '40', unitPrice: '4.1234' }],
  extraCosts: [{ id: 'extra_a', label: 'Transport', amount: '30.1234' }],
  delivery: {
    scheduledAt: '2026-09-20T10:00:00Z',
    vehicle: 'Van A',
    driverStaffId: 'staff_1',
    dispatchedAt: null,
    deliveredAt: null,
    notes: 'Door A',
  },
};
const orderB = {
  ...orderA,
  id: 'order_b',
  eventName: 'Team lunch',
  eventDate: '2026-09-21T00:00:00Z',
  delivery: {
    ...orderA.delivery,
    scheduledAt: '2026-09-21T10:00:00Z',
    vehicle: 'Van B',
    notes: 'Door B',
  },
};
const requirements = [
  {
    ingredientId: 'ingredient_1',
    ingredientName: 'Rice',
    baseUnitId: 'kg',
    quantityInBaseUnit: '5',
  },
];
const costs = {
  recipeCost: '170.1234',
  extraCost: '30',
  totalCost: '200.1234',
  quotedTotal: '1200',
  margin: '999.8766',
  marginPercent: '83.32305',
};
function query(data: unknown) {
  return { data, error: null, isLoading: false, refetch: vi.fn() };
}
type MutationOptions = UseMutationOptions<unknown, Error, unknown>;
function useTestMutation(
  mutationFn: (data: unknown) => Promise<unknown>,
  options: MutationOptions
) {
  return useMutation({ ...options, mutationFn });
}
function useEventQuery(
  name: 'detail' | 'requirements' | 'costs',
  input: { orderId: string },
  options: { enabled: boolean }
) {
  return useQuery({
    queryKey: [name, input.orderId],
    queryFn: () => mocks[name](input),
    enabled: options.enabled,
  });
}
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantCatering: { invalidate: mocks.invalidate } }),
    restaurantStaff: {
      listBranches: {
        useQuery: () => query([{ id: 'branch_1', name: 'Central', active: true, isDefault: true }]),
      },
      listDirectory: { useQuery: () => query([{ id: 'staff_1', displayName: 'Mina Driver' }]) },
    },
    restaurantCatalog: {
      listProducts: { useQuery: () => query([{ id: 'product_1', name: 'Lunch box' }]) },
      listRecipes: {
        useQuery: () =>
          query([{ id: 'recipe_1', name: 'Harvest lunch', activeVersionId: 'version_1' }]),
      },
      listRecipeCosts: {
        useQuery: () => query([{ recipeId: 'recipe_1', costPerPortion: '4.1234' }]),
      },
    },
    restaurantDelivery: {
      listCustomers: { useQuery: () => query({ customers: [] }) },
      listAddresses: { useQuery: () => query([]) },
    },
    restaurantCatering: {
      list: { useQuery: () => query([orderA, orderB]) },
      get: {
        useQuery: (input: { orderId: string }, options: { enabled: boolean }) =>
          useEventQuery('detail', input, options),
      },
      productionRequirements: {
        useQuery: (input: { orderId: string }, options: { enabled: boolean }) =>
          useEventQuery('requirements', input, options),
      },
      costSummary: {
        useQuery: (input: { orderId: string }, options: { enabled: boolean }) =>
          useEventQuery('costs', input, options),
      },
      create: { useMutation: (options: MutationOptions) => useTestMutation(mocks.create, options) },
      update: { useMutation: (options: MutationOptions) => useTestMutation(mocks.update, options) },
      addLine: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.addLine, options),
      },
      removeLine: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.removeLine, options),
      },
      addExtraCost: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.addExtra, options),
      },
      removeExtraCost: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.removeExtra, options),
      },
      setDelivery: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.delivery, options),
      },
      transition: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.transition, options),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { CateringConsole } from './catering-console';
const entitlements: EntitlementView = {
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: ['restaurant-core'],
  modules: [],
  limits: {},
};
let client: QueryClient;
function mount(currency: string | null = 'USD', enabled = true) {
  return render(
    <QueryClientProvider client={client}>
      <EntitlementsProvider
        value={{ ...entitlements, enabledModules: enabled ? ['restaurant-core'] : [] }}
      >
        <CateringConsole currency={currency} />
      </EntitlementsProvider>
    </QueryClientProvider>
  );
}
function select(name = 'Founders dinner') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`Select event ${name}`) }));
}
function form(name: string) {
  return screen.getByRole('form', { name: new RegExp(name) });
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('CateringConsole', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    for (const order of [orderA, orderB]) {
      client.setQueryData(['detail', order.id], order);
      client.setQueryData(['requirements', order.id], requirements);
      client.setQueryData(['costs', order.id], costs);
    }
    mocks.detail.mockImplementation(({ orderId }: { orderId: string }) =>
      Promise.resolve(orderId === orderA.id ? orderA : orderB)
    );
    mocks.requirements.mockResolvedValue(requirements);
    mocks.costs.mockResolvedValue(costs);
    for (const name of [
      'create',
      'update',
      'addLine',
      'removeLine',
      'addExtra',
      'removeExtra',
      'delivery',
      'transition',
    ] as const)
      mocks[name].mockResolvedValue(orderA);
  });
  afterEach(() => {
    cleanup();
    client.clear();
    vi.restoreAllMocks();
  });

  it('uses named native event buttons, selected state and 44px primary controls', () => {
    mount();
    expect(screen.getByLabelText('Filter by branch')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Select event Founders dinner/ });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    button.focus();
    expect(button).toHaveFocus();
    select();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.closest('tr')).toHaveAttribute('data-state', 'selected');
    for (const control of document.querySelectorAll('input, select, button')) {
      expect(control.className).toMatch(/(?:min-)?h-11/);
      expect(control).toHaveAccessibleName();
    }
  });
  it('confirms warm A/B dirty switches and resets every form to the selected event', async () => {
    mount();
    select('Team lunch');
    select();
    change('Vehicle', 'Unsaved A');
    change('Description', 'A menu');
    change('Label', 'A cost');
    select('Team lunch');
    let dialog = screen.getByRole('dialog', { name: 'Discard unsaved event edits?' });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-09-20');
    expect(dialog).toHaveTextContent('Team lunch · 2026-09-21');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Unsaved A');
    select('Team lunch');
    dialog = screen.getByRole('dialog', { name: 'Discard unsaved event edits?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Van B');
    expect(screen.getByLabelText('Delivery notes')).toHaveValue('Door B');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByLabelText('Label')).toHaveValue('');
    expect(form('Delivery for Team lunch')).toHaveTextContent('Saving for Team lunch · 2026-09-21');
    fireEvent.submit(form('Delivery'));
    await waitFor(() =>
      expect(mocks.delivery).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'order_b', vehicle: 'Van B', notes: 'Door B' }),
        expect.anything()
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save delivery' })).toBeEnabled()
    );
    select();
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Van A');
    expect(mocks.transition).not.toHaveBeenCalled();
  });
  it('preserves unsaved inputs across successful and failed background refetches', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const consoleWarning = vi.spyOn(console, 'warn');
    mount();
    select();
    change('Vehicle', 'Draft vehicle');
    change('Driver', '');
    change('Description', 'Draft line');
    change('Amount', '12.34');
    await act(async () => {
      client.setQueryData(['detail', orderA.id], {
        ...orderA,
        delivery: { ...orderA.delivery, vehicle: 'Server changed' },
      });
    });
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Draft vehicle');
    expect(screen.getByLabelText('Driver')).toHaveValue('');
    mocks.detail.mockRejectedValueOnce(new Error('Detail offline'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['detail', orderA.id] });
    });
    await screen.findByText(/Your edits are kept. Retry before saving/);
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Draft vehicle');
    expect(screen.getByLabelText('Description')).toHaveValue('Draft line');
    expect(screen.getByLabelText('Amount')).toHaveValue(12.34);
    expect(screen.getByRole('button', { name: 'Save delivery' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry order detail' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save delivery' })).toBeEnabled()
    );
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Draft vehicle');
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarning).not.toHaveBeenCalled();
  });
  it('locks selection/forms while saving and preserves failed drafts', async () => {
    const pending = deferred<unknown>();
    mocks.delivery.mockReturnValue(pending.promise);
    mount();
    select();
    change('Vehicle', 'A pending');
    fireEvent.submit(form('Delivery'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeDisabled()
    );
    expect(screen.getByLabelText('Vehicle')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move to quoted' })).toBeDisabled();
    select('Team lunch');
    fireEvent.submit(form('Delivery'));
    expect(mocks.delivery).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(orderA));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save delivery' })).toBeEnabled()
    );
    expect(mocks.delivery).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order_a', vehicle: 'A pending' }),
      expect.anything()
    );
    mocks.delivery.mockRejectedValueOnce(new Error('Save unavailable'));
    change('Vehicle', 'Retry A');
    fireEvent.submit(form('Delivery'));
    await screen.findByText(/Save unavailable.*Your edits are kept/);
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Retry A');
  });
  it('saves bound IDs/exact line and extra strings, clearing only the successful draft', async () => {
    mount();
    select();
    change('Vehicle', 'Keep delivery');
    change('Product or recipe', 'recipe:recipe_1');
    change('Description', 'Buffet');
    change('Portions', '3.125');
    change('Unit price', '9007199254740993.12');
    change('Label', 'Keep extra');
    fireEvent.submit(form('Order lines'));
    await waitFor(() =>
      expect(mocks.addLine).toHaveBeenCalledWith(
        {
          orderId: 'order_a',
          productId: null,
          recipeId: 'recipe_1',
          description: 'Buffet',
          portions: '3.125',
          unitPrice: '9007199254740993.12',
        },
        expect.anything()
      )
    );
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue(''));
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Keep delivery');
    expect(screen.getByLabelText('Label')).toHaveValue('Keep extra');
    change('Amount', '123.45');
    fireEvent.submit(form('Extra costs'));
    await waitFor(() =>
      expect(mocks.addExtra).toHaveBeenCalledWith(
        { orderId: 'order_a', kind: 'LABOUR', label: 'Keep extra', amount: '123.45' },
        expect.anything()
      )
    );
    await waitFor(() => expect(screen.getByLabelText('Label')).toHaveValue(''));
    select('Team lunch');
    expect(
      screen.getByRole('dialog', { name: 'Discard unsaved event edits?' })
    ).toBeInTheDocument();
  });
  it('refuses a form with an ID different from the visible event', () => {
    mount();
    select();
    const delivery = form('Delivery');
    delivery.dataset.orderId = orderB.id;
    fireEvent.submit(delivery);
    expect(mocks.delivery).not.toHaveBeenCalled();
  });
  it('requires discard before creating an order from a dirty event', () => {
    mount();
    select();
    change('Vehicle', 'Draft A');
    fireEvent.click(screen.getByRole('button', { name: 'New order' }));
    expect(screen.getByRole('dialog', { name: 'Discard unsaved event edits?' })).toHaveTextContent(
      'Create a new order?'
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['USD', 'PKR', null, ''])(
    'preserves exact major amounts with currency %s',
    (currency) => {
      client.setQueryData(['detail', orderA.id], {
        ...orderA,
        quotedTotal: '9007199254740993.1234',
      });
      mount(currency);
      select();
      const label = currency || 'Currency unavailable';
      for (const amount of ['9007199254740993.1234', '170.1234', '999.8766'])
        expect(screen.getByText(`${label} ${amount}`)).toBeInTheDocument();
      expect(screen.getByText(`Transport · ${label} 30.1234`)).toBeInTheDocument();
      expect(screen.getByLabelText('Product or recipe')).toHaveTextContent(
        `${label} 4.1234/portion`
      );
      expect(screen.getByText(/Margin is the quoted amount/)).toHaveTextContent(
        'not realized profit or cash'
      );
      if (!currency) expect(document.body).not.toHaveTextContent(/USD|\$/);
    }
  );
  it.each(['detail', 'requirements', 'costs'] as const)(
    'retries only the selected %s query',
    async (name) => {
      client.removeQueries({ queryKey: [name, orderA.id] });
      mocks[name].mockRejectedValueOnce(new Error(`${name} unavailable`));
      mount();
      select();
      const label = {
        detail: 'Retry order detail',
        requirements: 'Retry production requirements',
        costs: 'Retry cost summary',
      }[name];
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
      );
      expect(mocks[name]).toHaveBeenCalledTimes(2);
      expect(mocks[name]).toHaveBeenLastCalledWith({ orderId: 'order_a' });
      for (const other of ['detail', 'requirements', 'costs'] as const)
        if (other !== name) expect(mocks[other]).not.toHaveBeenCalled();
    }
  );
  it('blocks unknown/loading/error/refetch printing and permits confirmed empty requirements', async () => {
    const pending = deferred<typeof requirements>();
    mocks.requirements.mockReturnValue(pending.promise);
    client.removeQueries({ queryKey: ['requirements', orderA.id] });
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    mount();
    select();
    expect(
      screen.getByRole('button', { name: /Print production sheet for Founders dinner/ })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Print production sheet/ }));
    expect(print).not.toHaveBeenCalled();
    await act(async () => pending.resolve([]));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Print production sheet/ })).toBeEnabled()
    );
    expect(screen.getByText('No recipe ingredients are required yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Print production sheet/ }));
    expect(print).toHaveBeenCalledTimes(1);
    mocks.requirements.mockRejectedValueOnce(new Error('Requirements offline'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['requirements', orderA.id] });
    });
    await screen.findByRole('button', { name: 'Retry production requirements' });
    expect(screen.getByRole('button', { name: /Print production sheet/ })).toBeDisabled();
    const refetch = deferred<typeof requirements>();
    mocks.requirements.mockReturnValue(refetch.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry production requirements' }));
    expect(screen.getByRole('button', { name: /Print production sheet/ })).toBeDisabled();
    await act(async () => refetch.resolve(requirements));
  });
  it.each([
    ['Move to quoted', 'QUOTED'],
    ['Cancel', 'CANCELLED'],
  ])('keeps %s explicit and bound while pending', async (buttonName, to) => {
    const pending = deferred<unknown>();
    mocks.transition.mockReturnValue(pending.promise);
    mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm status change' });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-09-20');
    if (to === 'CANCELLED')
      expect(dialog).toHaveTextContent('Ready-order ingredient consumption will be reversed.');
    expect(mocks.transition).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm change' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Keep current status' })).toBeDisabled()
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(mocks.transition).toHaveBeenCalledWith({ orderId: 'order_a', to }, expect.anything());
    await act(async () => pending.resolve(orderA));
  });
  it('binds the editor to its event and prevents pending dismissal', async () => {
    const pending = deferred<unknown>();
    mocks.update.mockReturnValue(pending.promise);
    mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Edit order' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit catering order' });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-09-20');
    fireEvent.change(within(dialog).getByLabelText('Event name'), {
      target: { value: 'Renamed dinner' },
    });
    fireEvent.submit(within(dialog).getByLabelText('Event name').closest('form')!);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order_a', eventName: 'Renamed dinner' }),
      expect.anything()
    );
    await act(async () => pending.resolve(orderA));
  });
  it('preserves the disabled-module state', () => {
    mount('USD', false);
    expect(
      screen.getByRole('heading', { name: 'Restaurant Core module disabled' })
    ).toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
  });
});
