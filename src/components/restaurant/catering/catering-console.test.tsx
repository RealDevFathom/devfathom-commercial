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
  staffSession: vi.fn(),
  refreshSession: vi.fn(),
  invalidate: vi.fn(),
  detail: vi.fn(),
  requirements: vi.fn(),
  costs: vi.fn(),
  list: vi.fn(),
  listInput: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addLine: vi.fn(),
  removeLine: vi.fn(),
  addExtra: vi.fn(),
  removeExtra: vi.fn(),
  delivery: vi.fn(),
  transition: vi.fn(),
  booking: vi.fn(),
  capacity: vi.fn(),
  publish: vi.fn(),
  approve: vi.fn(),
  availability: vi.fn(),
  quotes: vi.fn(),
  locations: vi.fn(),
  payments: vi.fn(),
  approvals: vi.fn(),
  consumption: vi.fn(),
  disposition: vi.fn(),
}));
const orderA = {
  id: 'order_a',
  revision: 1,
  approvedQuoteRevisionId: null,
  bookingStartsAt: null,
  bookingEndsAt: null,
  fulfillmentMode: null,
  stockLocationId: null,
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
    baseUnitId: 'unit_kg',
    baseUnit: { id: 'unit_kg', name: 'Kilogram', abbreviation: 'kg' },
    quantityInBaseUnit: '5',
  },
];
const costs = {
  ingredientCost: '170.1234',
  grossMargin: '999.8766',
  costBasis: 'ESTIMATED',
  missing: [],
  actualCost: null,
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
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'unauthenticated',
    data: null,
    update: mocks.refreshSession,
    ...mocks.staffSession(),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantCatering: { invalidate: mocks.invalidate } }),
    restaurantStaff: {
      listBranches: {
        useQuery: () => query([{ id: 'branch_1', name: 'Central', active: true, isDefault: true }]),
      },
      listDirectory: {
        useQuery: () => query([{ id: 'staff_1', displayName: 'Mina Driver' }]),
      },
    },
    restaurantCatalog: {
      listProducts: {
        useQuery: () => query([{ id: 'product_1', name: 'Lunch box' }]),
      },
      listRecipes: {
        useQuery: () =>
          query([
            {
              id: 'recipe_1',
              name: 'Harvest lunch',
              activeVersionId: 'version_1',
            },
            { id: 'recipe_bad', name: 'Invalid legacy recipe', activeVersionId: 'version_bad' },
            { id: 'recipe_missing', name: 'Unpriced recipe', activeVersionId: 'version_missing' },
            { id: 'recipe_portion', name: 'No portion cost', activeVersionId: 'version_portion' },
          ]),
      },
      listRecipeCosts: {
        useQuery: () =>
          query([
            { recipeId: 'recipe_1', costPerPortion: '4.1234', error: null },
            { recipeId: 'recipe_bad', costPerPortion: null, error: 'Recipe cycle detected.' },
            {
              recipeId: 'recipe_missing',
              costPerPortion: null,
              error: 'Ingredient prices are missing.',
            },
            {
              recipeId: 'recipe_portion',
              costPerPortion: null,
              error: 'Portion cost is unavailable.',
            },
          ]),
      },
    },
    restaurantDelivery: {
      listCustomers: { useQuery: () => query({ customers: [] }) },
      listAddresses: { useQuery: () => query([]) },
    },
    restaurantCatering: {
      bookingLocations: {
        useQuery: (input: { branchId: string }, options: { enabled: boolean }) =>
          mocks.locations(input, options),
      },
      paymentSummary: { useQuery: () => mocks.payments() },
      approvalHistory: { useQuery: () => mocks.approvals() },
      consumptionHistory: { useQuery: () => mocks.consumption() },
      recordDisposition: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.disposition, options),
      },
      bookingAvailability: { useQuery: () => mocks.availability() },
      quoteHistory: { useQuery: () => mocks.quotes() },
      setBooking: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.booking, options),
      },
      setBranchCapacity: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.capacity, options),
      },
      publishQuote: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.publish, options),
      },
      approveQuote: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.approve, options),
      },
      list: {
        useQuery: (input: unknown) => {
          mocks.listInput(input);
          return mocks.list() ?? query([orderA, orderB]);
        },
      },
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
      create: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.create, options),
      },
      update: {
        useMutation: (options: MutationOptions) => useTestMutation(mocks.update, options),
      },
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
        value={{
          ...entitlements,
          enabledModules: enabled ? ['restaurant-core'] : [],
        }}
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
    mocks.payments.mockReturnValue(
      query({
        approvedQuoteTotal: null,
        plannedDepositAmount: '200',
        recordedReceipts: '0',
        recordedRefunds: '0',
        netPaid: '0',
        refundableBalance: '0',
        amountDue: null,
        currency: 'USD',
        evidence: [],
      })
    );
    mocks.approvals.mockReturnValue(query([]));
    mocks.consumption.mockReturnValue(query({ reconciliationRequired: false, movements: [] }));
    mocks.disposition.mockResolvedValue({});
    mocks.availability.mockReturnValue(
      query({
        capacityStatus: 'UNKNOWN',
        maxConcurrentHeadcount: null,
        peakHeadcount: null,
      })
    );
    mocks.quotes.mockReturnValue(query([]));
    mocks.locations.mockReturnValue(
      query([
        {
          id: 'location_1',
          name: 'Main kitchen',
        },
      ])
    );
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
      'booking',
      'capacity',
      'publish',
      'approve',
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
    const button = screen.getByRole('button', {
      name: /Select event Founders dinner/,
    });
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
  it.each(['New order', 'Edit order'])('returns editor focus to %s after Escape', async (name) => {
    mount();
    if (name === 'Edit order') select();
    const trigger = screen.getByRole('button', { name });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('confirms warm A/B dirty switches and resets every form to the selected event', async () => {
    mount();
    select('Team lunch');
    select();
    change('Vehicle', 'Unsaved A');
    change('Description', 'A menu');
    change('Label', 'A cost');
    select('Team lunch');
    let dialog = screen.getByRole('dialog', {
      name: 'Discard unsaved event edits?',
    });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-09-20');
    expect(dialog).toHaveTextContent('Team lunch · 2026-09-21');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Vehicle')).toHaveValue('Unsaved A');
    select('Team lunch');
    dialog = screen.getByRole('dialog', {
      name: 'Discard unsaved event edits?',
    });
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
        expect.objectContaining({
          orderId: 'order_b',
          vehicle: 'Van B',
          notes: 'Door B',
        }),
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
    expect(screen.queryByRole('option', { name: 'Lunch box' })).not.toBeInTheDocument();
    change('Recipe', 'recipe_1');
    change('Description', 'Buffet');
    change('Portions', '3.125');
    change('Unit price', '9007199254740993.12');
    change('Label', 'Keep extra');
    fireEvent.submit(form('Order lines'));
    await waitFor(() =>
      expect(mocks.addLine).toHaveBeenCalledWith(
        {
          orderId: 'order_a',
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
        {
          orderId: 'order_a',
          kind: 'LABOUR',
          label: 'Keep extra',
          amount: '123.45',
        },
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
      expect(screen.getByLabelText('Recipe')).toHaveTextContent(`${label} 4.1234/portion`);
      expect(
        screen.getByRole('option', {
          name: 'Invalid legacy recipe · Cost unavailable: Recipe cycle detected.',
        })
      ).toBeDisabled();
      expect(screen.getByText(/Margin is the quoted amount/)).toHaveTextContent(
        'not realized profit or cash'
      );
      if (!currency)
        expect(
          screen.getByText('Cost summary').closest('[data-slot="section-card"]')
        ).not.toHaveTextContent(/USD|\$/);
    }
  );
  it('disables missing-price and null-portion recipes while keeping a complete recipe enabled', () => {
    mount();
    select();
    expect(screen.getByRole('option', { name: /Harvest lunch/ })).toBeEnabled();
    for (const name of [
      'Unpriced recipe · Cost unavailable: Ingredient prices are missing.',
      'No portion cost · Cost unavailable: Portion cost is unavailable.',
    ]) {
      const option = screen.getByRole('option', { name });
      expect(option).toBeDisabled();
      expect(option).not.toHaveTextContent('/portion');
    }
  });
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
      screen.getByRole('button', {
        name: /Print production sheet for Founders dinner/,
      })
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
    await screen.findByRole('button', {
      name: 'Retry production requirements',
    });
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
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm status change',
    });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-09-20');
    if (to === 'CANCELLED')
      expect(dialog).toHaveTextContent(
        'Cancellation does not return prepared inventory or refund money.'
      );
    expect(mocks.transition).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm change' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Keep current status' })).toBeDisabled()
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(mocks.transition).toHaveBeenCalledWith(
      { orderId: 'order_a', to, idempotencyKey: expect.any(String) },
      expect.anything()
    );
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
      expect.objectContaining({
        orderId: 'order_a',
        eventName: 'Renamed dinner',
      }),
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
  it('uses catering-scoped locations and renders requirement unit metadata', async () => {
    mount();
    select();
    expect(await screen.findByRole('option', { name: 'Main kitchen' })).toBeInTheDocument();
    expect(mocks.locations).toHaveBeenCalledWith({ branchId: 'branch_1' }, { enabled: true });
    expect(await screen.findByText('Kilogram (kg)')).toBeInTheDocument();
  });

  it('preserves recorded production units when labels are missing', async () => {
    client.setQueryData(['requirements', orderA.id], [{ ...requirements[0], baseUnit: null }]);
    mount();
    select();
    expect(await screen.findByText('Unit label unavailable (unit_kg)')).toBeInTheDocument();
  });

  it('requires an explicit offset, preserves failed booking input, and submits labeled stock location', async () => {
    mocks.booking.mockRejectedValueOnce(new Error('Permission denied'));
    mount();
    select();
    change('Booking start with UTC offset', '2026-10-07T18:00:00');
    change('Booking end with UTC offset', '2026-10-07T20:00:00+05:00');
    change('Fulfillment', 'PICKUP');
    change('Stock location', 'location_1');
    fireEvent.submit(form('Booking'));
    expect(mocks.booking).not.toHaveBeenCalled();
    expect(screen.getByText(/Use valid timestamps/)).toBeInTheDocument();
    change('Booking start with UTC offset', '2026-10-07T18:00:00+05:00');
    fireEvent.submit(form('Booking'));
    await screen.findByText(/Permission denied/);
    expect(screen.getByLabelText('Booking start with UTC offset')).toHaveValue(
      '2026-10-07T18:00:00+05:00'
    );
    expect(mocks.booking).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingStartsAt: new Date('2026-10-07T13:00:00Z'),
        fulfillmentMode: 'PICKUP',
        stockLocationId: 'location_1',
      }),
      expect.anything()
    );
  });
  it('uses configured capacity and preserves unknown rather than inventing a limit', async () => {
    mount();
    select();
    expect(screen.getByText(/Configured guests: Unknown/)).toBeInTheDocument();
    change('Maximum concurrent guests', '80');
    fireEvent.submit(form('Branch capacity'));
    await waitFor(() =>
      expect(mocks.capacity).toHaveBeenCalledWith(
        { branchId: 'branch_1', maxConcurrentHeadcount: 80 },
        expect.anything()
      )
    );
  });
  it('distinguishes planned money and missing actual cost without claiming receipts', () => {
    mount();
    select();
    expect(screen.getAllByText('Planned deposit').length).toBeGreaterThan(0);
    expect(screen.getByText(/not a recorded receipt/)).toBeInTheDocument();
    expect(screen.getByText(/Actual cost: unknown/)).toBeInTheDocument();
  });
  it('retains the lifecycle key on ambiguous failure and creates a new key for a new deliberate command', async () => {
    mocks.transition.mockRejectedValue(new Error('Response lost'));
    mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await screen.findByText('Response lost');
    const first = mocks.transition.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(2));
    expect(mocks.transition.mock.calls[1][0]).toEqual(first);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Keep current status' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep current status' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(3));
    expect(mocks.transition.mock.calls[2][0].idempotencyKey).not.toEqual(first.idempotencyKey);
  });
  it('disables confirmed edits while retaining explicit preparation and cancellation', () => {
    client.setQueryData(['detail', orderA.id], {
      ...orderA,
      status: 'CONFIRMED',
    });
    mount();
    select();
    expect(screen.getByRole('button', { name: 'Edit order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save booking' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move to in production' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });
  it('blocks confirmation after approval invalidation and unknown or exceeded capacity', () => {
    client.setQueryData(['detail', orderA.id], {
      ...orderA,
      status: 'QUOTED',
      revision: 2,
    });
    mount();
    select();
    expect(screen.getByRole('button', { name: 'Move to confirmed' })).toBeDisabled();
    expect(screen.getByText(/Current quote approval required/).closest('p')!).toBeInTheDocument();
  });
  it.each(['AVAILABLE', 'UNKNOWN', 'EXCEEDED'])(
    'requires current approval and AVAILABLE capacity (%s)',
    (capacityStatus) => {
      const quote = {
        id: 'quote_1',
        revision: 1,
        snapshot: {
          currency: 'USD',
          quotedTotal: '1200',
          headcount: 40,
          fulfillmentMode: 'PICKUP',
          bookingStartsAt: '2026-10-07T13:00:00Z',
          bookingEndsAt: '2026-10-07T15:00:00Z',
          lines: [
            { id: 'frozen_line', description: 'Frozen lunch', portions: '40', unitPrice: '30' },
          ],
          extraCosts: [],
          requirements: [],
          missing: [],
        },
      };
      mocks.quotes.mockReturnValue(query([quote]));
      mocks.availability.mockReturnValue(
        query({ capacityStatus, maxConcurrentHeadcount: 80, peakHeadcount: 40 })
      );
      client.setQueryData(['detail', orderA.id], {
        ...orderA,
        status: 'QUOTED',
        approvedQuoteRevisionId: 'quote_1',
        bookingStartsAt: quote.snapshot.bookingStartsAt,
        bookingEndsAt: quote.snapshot.bookingEndsAt,
        fulfillmentMode: 'PICKUP',
        stockLocationId: 'location_1',
      });
      mount();
      select();
      const confirm = screen.getByRole('button', { name: 'Move to confirmed' });
      if (capacityStatus === 'AVAILABLE') expect(confirm).toBeEnabled();
      else expect(confirm).toBeDisabled();
      expect(screen.getByText('Frozen lunch')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approved' })).toBeDisabled();
    }
  );
  it('publishes only with configured currency and approves an explicit current frozen revision', async () => {
    mocks.quotes.mockReturnValue(
      query([
        {
          id: 'quote_2',
          revision: 1,
          snapshot: {
            currency: 'USD',
            quotedTotal: '1200',
            headcount: 40,
            lines: [],
            requirements: [],
            extraCosts: [],
            missing: ['Rice'],
          },
        },
      ])
    );
    mount();
    select();
    expect(screen.getByText(/Missing costs: Rice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve quote revision' }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith(
        { orderId: 'order_a', quoteRevisionId: 'quote_2' },
        expect.anything()
      )
    );
  });
});

describe('CateringConsole calendar dates in a non-UTC browser zone', () => {
  // `eventDate` is a `@db.Date` column and `serviceTime` a `@db.Time`: the server stores
  // the UTC calendar day / clock time of the Date it receives, and every read formats the
  // UTC fields back. Parsing the typed value as *local* midnight (the regression) sent
  // 2026-11-06T19:00Z from Asia/Karachi, so the ledger showed the day before.
  const originalZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'Asia/Karachi';
    vi.resetAllMocks();
    mocks.payments.mockReturnValue(query({ evidence: [], currency: 'USD' }));
    mocks.approvals.mockReturnValue(query([]));
    mocks.consumption.mockReturnValue(query({ reconciliationRequired: false, movements: [] }));
    mocks.availability.mockReturnValue(query({ capacityStatus: 'UNKNOWN' }));
    mocks.quotes.mockReturnValue(query([]));
    mocks.locations.mockReturnValue(query([]));
    mocks.detail.mockImplementation(async ({ orderId }: { orderId: string }) =>
      orderId === orderA.id ? orderA : orderB
    );
    mocks.requirements.mockResolvedValue([]);
    mocks.costs.mockResolvedValue({});
    mocks.create.mockResolvedValue(orderA);
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
  });
  afterEach(() => {
    cleanup();
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });
  it('runs in a zone east of UTC, so a local-midnight parse would move the day', () => {
    expect(new Date('2026-11-07T00:00:00').getTimezoneOffset()).toBe(-300);
  });
  it('submits the entered event date and service time as UTC calendar values', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New order' }));
    const dialog = screen.getByRole('dialog', { name: 'Create catering order' });
    fireEvent.change(within(dialog).getByLabelText('Event name'), {
      target: { value: 'Mehndi dinner — Rana family' },
    });
    fireEvent.change(within(dialog).getByLabelText('Event date'), {
      target: { value: '2026-11-07' },
    });
    fireEvent.change(within(dialog).getByLabelText('Service time'), {
      target: { value: '19:30' },
    });
    fireEvent.change(within(dialog).getByLabelText('Headcount'), { target: { value: '120' } });
    fireEvent.submit(within(dialog).getByLabelText('Event name').closest('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    const [payload] = mocks.create.mock.calls[0]!;
    expect(payload.eventDate.toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(payload.serviceTime.toISOString()).toBe('1970-01-01T19:30:00.000Z');
  });
  it('round-trips a stored UTC calendar day and clock time into the editor unchanged', () => {
    client.setQueryData(['detail', orderA.id], {
      ...orderA,
      eventDate: '2026-11-07T00:00:00.000Z',
      serviceTime: '1970-01-01T19:30:00.000Z',
    });
    mount();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Edit order' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit catering order' });
    expect(dialog).toHaveTextContent('Founders dinner · 2026-11-07');
    expect(within(dialog).getByLabelText('Event date')).toHaveValue('2026-11-07');
    expect(within(dialog).getByLabelText('Service time')).toHaveValue('19:30');
  });
  it('filters the ledger by the entered calendar days, not their local midnights', async () => {
    mount();
    change('Event date from', '2026-11-07');
    change('Event date to', '2026-11-14');
    await waitFor(() =>
      expect(mocks.listInput).toHaveBeenLastCalledWith(
        expect.objectContaining({
          eventDateFrom: new Date('2026-11-07T00:00:00.000Z'),
          eventDateTo: new Date('2026-11-14T23:59:59.999Z'),
        })
      )
    );
  });
});

describe('Persisted catering evidence', () => {
  const movement = {
    originalMovementId: 'movement_1',
    stockItemId: 'stock_1',
    locationId: 'location_1',
    canonicalUnit: { id: 'kg', name: 'Kilogram', abbreviation: 'kg' },
    consumed: '5',
    allocated: '2',
    remaining: '3',
    dispositions: [],
  };
  beforeEach(() => {
    vi.resetAllMocks();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(['detail', orderA.id], { ...orderA, status: 'CANCELLED' });
    client.setQueryData(['requirements', orderA.id], requirements);
    client.setQueryData(['costs', orderA.id], costs);
    mocks.availability.mockReturnValue(query({ capacityStatus: 'UNKNOWN' }));
    mocks.quotes.mockReturnValue(query([]));
    mocks.locations.mockReturnValue(query([]));
    mocks.payments.mockReturnValue(
      query({
        approvedQuoteTotal: null,
        plannedDepositAmount: '200',
        recordedReceipts: '100',
        recordedRefunds: '20',
        netPaid: '80',
        refundableBalance: '80',
        amountDue: null,
        currency: 'USD',
        evidence: [
          {
            id: 'receipt_old',
            quoteRevisionId: 'quote_historical',
            kind: 'DEPOSIT',
            amount: '100',
            currency: 'USD',
            source: 'OPERATOR_ATTESTED',
            originalEvidenceId: null,
          },
        ],
      })
    );
    mocks.approvals.mockReturnValue(
      query([
        {
          id: 'approval_1',
          orderRevision: 1,
          quoteRevisionId: 'quote_historical',
          actorStaffProfileId: 'staff_1',
          createdAt: new Date('2026-10-01T00:00:00Z'),
        },
      ])
    );
    mocks.consumption.mockReturnValue(
      query({ reconciliationRequired: false, movements: [movement] })
    );
    mocks.disposition.mockResolvedValue({});
  });
  afterEach(cleanup);
  it('shows persisted money and historical quote linkage without collecting credentials', async () => {
    mount();
    select();
    expect(
      await screen.findByText(/Operator-attested — not provider-verified/)
    ).toBeInTheDocument();
    expect(screen.getAllByText('USD 80', { selector: 'dd' })).toHaveLength(2);
    expect(screen.getByText(/Receipt reference: receipt_old/)).toHaveTextContent(
      'quote_historical'
    );
    expect(screen.getByRole('button', { name: 'Refund this receipt' })).toBeDisabled();
    expect(screen.getByText(/no authenticated enrolled-terminal session/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/device secret|session token|actor id/i)
    ).not.toBeInTheDocument();
    const approval = screen.getByText(/Order revision 1 · Quote reference/);
    expect(approval).toHaveTextContent('1 Oct 2026');
    expect(approval).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}T/);
  });
  it('caps canonical quantity and preserves replay key across failed disposition retry', async () => {
    mocks.disposition.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({});
    mount();
    select();
    await screen.findByRole('form', { name: 'Record physical disposition' });
    change('Original consumption', 'movement_1');
    change('Canonical quantity', '3.000001');
    change('Disposition reason', 'Unused ingredients');
    fireEvent.submit(form('Record physical disposition'));
    expect(mocks.disposition).not.toHaveBeenCalled();
    expect(screen.getByText(/no greater than remaining/)).toBeInTheDocument();
    change('Canonical quantity', '3');
    fireEvent.submit(form('Record physical disposition'));
    await screen.findByText(/Connection lost/);
    const first = mocks.disposition.mock.calls[0][0];
    fireEvent.submit(form('Record physical disposition'));
    await screen.findByText('Physical disposition recorded.');
    expect(mocks.disposition.mock.calls[1][0]).toEqual(first);
    expect(first).toMatchObject({
      orderId: orderA.id,
      originalMovementId: 'movement_1',
      kind: 'UNUSED_RETURN',
      quantity: '3',
    });
    expect(first.idempotencyKey).toBeTruthy();
    expect(mocks.invalidate).toHaveBeenCalled();
  });
  it('blocks legacy reversal allocations and shows canonical quantities', async () => {
    mocks.consumption.mockReturnValue(
      query({ reconciliationRequired: true, movements: [{ ...movement, remaining: null }] })
    );
    mount();
    select();
    expect(await screen.findByText(/Legacy reversal requires reconciliation/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record disposition' })).toBeDisabled();
    expect(
      screen.getByText(/Consumed 5; allocated 2; remaining Unavailable Kilogram/)
    ).toBeInTheDocument();
  });
  it('fails closed on consumption errors with a retry action', async () => {
    mocks.consumption.mockReturnValue({
      ...query(undefined),
      error: new Error('Permission denied'),
    });
    mount();
    select();
    expect(
      await screen.findByText(/Consumption history unavailable: Permission denied/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry consumption history' })).toBeEnabled();
    expect(
      screen.queryByRole('form', { name: 'Record physical disposition' })
    ).not.toBeInTheDocument();
  });
});

describe('Catering enrolled money commands', () => {
  const session = {
    expires: '2099-01-01T00:00:00Z',
    user: {
      id: 'user_1',
      organizationId: 'org_1',
      organizationStatus: 'ACTIVE',
      status: 'ACTIVE',
      role: 'ADMIN',
      department: 'OPERATIONS',
    },
  };
  const receipt = {
    id: 'receipt_old',
    quoteRevisionId: 'quote_historical',
    kind: 'DEPOSIT',
    amount: '100',
    currency: 'USD',
    source: 'OPERATOR_ATTESTED',
    originalEvidenceId: null,
  };
  const summary = {
    approvedQuoteTotal: '1200',
    plannedDepositAmount: '200',
    recordedReceipts: '100',
    recordedRefunds: '0',
    netPaid: '100',
    refundableBalance: '100',
    amountDue: '1100',
    currency: 'USD',
    evidence: [receipt],
  };
  const operators = [
    { staffProfileId: 'staff_1', displayName: 'Mina', role: 'Manager', canApprove: true },
    { staffProfileId: 'staff_2', displayName: 'Bilal', role: 'Manager', canApprove: true },
  ];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  function transport(
    extra?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined,
    branchId = 'branch_1'
  ) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = String(input);
      const response = extra?.(path, init);
      if (response) return response;
      if (path.endsWith('/establish'))
        return json({
          sessionToken: 'test-only-session',
          session: { id: 'session_1', state: 'LOCKED' },
          device: {
            id: 'device_1',
            organizationId: 'org_1',
            branchId,
            name: 'Catering desk',
            branchName: 'Central',
          },
        });
      if (path.endsWith('/operators')) return json({ operators });
      if (path.endsWith('/unlock') || path.endsWith('/switch'))
        return json({
          session: {
            id: 'session_1',
            state: 'UNLOCKED',
            activeStaffProfileId: JSON.parse(String(init?.body)).staffProfileId,
          },
        });
      if (path.endsWith('/lock'))
        return json({ session: { id: 'session_1', state: 'LOCKED', activeStaffProfileId: null } });
      if (path.endsWith('/money')) return json({ evidenceId: 'evidence_1', replayed: false });
      throw new Error(`Unexpected catering request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  async function unlock() {
    fireEvent.click(screen.getByRole('button', { name: 'Connect enrolled terminal' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Unlock terminal' })).toBeEnabled()
    );
    change('Operator PIN', '1234');
    fireEvent.submit(form('Unlock catering terminal'));
    await screen.findByRole('button', { name: 'Lock terminal' });
  }
  function fill(amount = '10') {
    change('Payment amount', amount);
    change('Evidence source', 'Bank transfer');
    change('Evidence reference', 'transfer-1');
  }
  const moneyCalls = (fetch: ReturnType<typeof transport>) =>
    fetch.mock.calls.filter(([path]) => String(path).endsWith('/money'));
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.staffSession.mockReturnValue({ status: 'authenticated', data: session });
    mocks.refreshSession.mockResolvedValue(session);
    mocks.invalidate.mockResolvedValue(undefined);
    mocks.payments.mockReturnValue(query(summary));
    mocks.approvals.mockReturnValue(query([]));
    mocks.consumption.mockReturnValue(query({ reconciliationRequired: false, movements: [] }));
    mocks.availability.mockReturnValue(query({ capacityStatus: 'UNKNOWN' }));
    mocks.locations.mockReturnValue(query([]));
    mocks.quotes.mockReturnValue(
      query([
        {
          id: 'quote_current',
          revision: 1,
          snapshot: {
            currency: 'USD',
            quotedTotal: '1200',
            headcount: 40,
            missing: [],
            lines: [],
            extraCosts: [],
            requirements: [],
          },
          approval: { id: 'approval_1' },
        },
      ])
    );
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    for (const order of [orderA, orderB]) {
      client.setQueryData(['detail', order.id], {
        ...order,
        approvedQuoteRevisionId: 'quote_current',
      });
      client.setQueryData(['requirements', order.id], requirements);
      client.setQueryData(['costs', order.id], costs);
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('requires staff and enrolled terminal separately, without menu or outbox loading', async () => {
    const fetch = transport();
    mount();
    select();
    await screen.findByRole('form', { name: 'Record catering money' });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record receipt evidence' })).toBeDisabled();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await screen.findByText('Payment evidence recorded.');
    expect(moneyCalls(fetch)).toHaveLength(1);
    const init = moneyCalls(fetch)[0][1]!;
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({
      cateringOrderId: 'order_a',
      quoteRevisionId: 'quote_current',
      kind: 'DEPOSIT',
      amount: '10',
      currency: 'USD',
      source: 'OPERATOR_ATTESTED',
      externalEvidenceSource: 'Bank transfer',
      externalEvidenceReference: 'transfer-1',
    });
    expect(
      fetch.mock.calls.every(([path]) => /\/terminal\/|\/catering\/money/.test(String(path)))
    ).toBe(true);
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('caps receipts using amount due, not the planned deposit; records cash balance separately', async () => {
    const fetch = transport();
    mount();
    select();
    await unlock();
    fill('1100.01');
    fireEvent.submit(form('Record catering money'));
    expect(await screen.findByText(/positive amount no greater/)).toBeInTheDocument();
    expect(moneyCalls(fetch)).toHaveLength(0);
    change('Payment amount', '1100');
    change('Receipt kind', 'BALANCE');
    change('Evidence type', 'CASH');
    change('Open drawer session reference', 'drawer_1');
    fireEvent.submit(form('Record catering money'));
    await screen.findByText('Payment evidence recorded.');
    const body = JSON.parse(String(moneyCalls(fetch)[0][1]?.body));
    expect(body).toMatchObject({
      kind: 'BALANCE',
      amount: '1100',
      source: 'CASH',
      drawerSessionId: 'drawer_1',
    });
    expect(body).not.toHaveProperty('externalEvidenceReference');
  });
  it('refunds cancelled orders against the immutable original receipt and historical quote', async () => {
    client.setQueryData(['detail', orderA.id], {
      ...orderA,
      status: 'CANCELLED',
      approvedQuoteRevisionId: 'quote_current',
    });
    mocks.payments.mockReturnValue(
      query({ ...summary, approvedQuoteTotal: null, amountDue: null })
    );
    const fetch = transport();
    mount();
    select();
    await unlock();
    expect(screen.getByRole('button', { name: 'Record receipt evidence' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refund this receipt' }));
    fill('100');
    fireEvent.submit(form('Record catering money'));
    await screen.findByText('Payment evidence recorded.');
    expect(JSON.parse(String(moneyCalls(fetch)[0][1]?.body))).toMatchObject({
      kind: 'REFUND',
      originalEvidenceId: 'receipt_old',
      quoteRevisionId: 'quote_historical',
      amount: '100',
    });
    expect(mocks.disposition).not.toHaveBeenCalled();
  });
  it('freezes one deliberate intent through duplicate clicks, unknown outcome and changed server totals', async () => {
    const gate = deferred<Response>();
    let count = 0;
    const fetch = transport((path) =>
      path.endsWith('/money')
        ? ++count === 1
          ? gate.promise
          : json({ evidenceId: 'evidence_1', replayed: true })
        : undefined
    );
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    fireEvent.submit(form('Record catering money'));
    await waitFor(() => expect(moneyCalls(fetch)).toHaveLength(1));
    expect(screen.getByLabelText('Payment amount')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeDisabled();
    await act(async () => gate.resolve(json({ error: 'Response lost after commit' }, 503)));
    await screen.findByText(/Outcome unknown/);
    mocks.payments.mockReturnValue(query({ ...summary, amountDue: '0', approvedQuoteTotal: null }));
    change('Filter by status', 'DRAFT');
    fireEvent.click(screen.getByRole('button', { name: 'Retry same payment command' }));
    await screen.findByText('Previously recorded evidence confirmed.');
    const calls = moneyCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
    expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(calls[0][1]?.headers).get('Idempotency-Key')
    );
    expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeEnabled();
  });
  it('retains the exact unknown money command through list permission denial and recovery', async () => {
    let count = 0;
    const fetch = transport((path) =>
      path.endsWith('/money')
        ? ++count === 1
          ? json({ error: 'Response lost after commit' }, 503)
          : json({ evidenceId: 'evidence_1', replayed: true })
        : undefined
    );
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await screen.findByText(/Outcome unknown/);
    mocks.list.mockReturnValue({
      ...query([orderA, orderB]),
      error: { data: { code: 'FORBIDDEN' } },
    });
    change('Filter by status', 'DRAFT');
    await screen.findByText('You do not have permission to view catering orders.');
    expect(
      screen.queryByRole('button', { name: 'Retry same payment command' })
    ).not.toBeInTheDocument();
    expect(moneyCalls(fetch)).toHaveLength(1);
    mocks.list.mockReturnValue(query([orderA, orderB]));
    act(() =>
      client.setQueryData(['detail', orderA.id], {
        ...orderA,
        approvedQuoteRevisionId: 'quote_current',
        notes: 'Restored access',
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same payment command' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeDisabled();
    expect(screen.getByLabelText('Payment amount')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same payment command' }));
    await screen.findByText('Previously recorded evidence confirmed.');
    const calls = moneyCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
    expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(calls[0][1]?.headers).get('Idempotency-Key')
    );
    expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeEnabled();
  });
  it('preserves failed input; changing a rejected command creates a new key', async () => {
    let count = 0;
    const fetch = transport((path) =>
      path.endsWith('/money') && ++count === 1 ? json({ error: 'OVERPAYMENT' }, 409) : undefined
    );
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await screen.findByText(/OVERPAYMENT/);
    expect(screen.getByLabelText('Payment amount')).toHaveValue('10');
    expect(screen.getByLabelText('Evidence reference')).toHaveValue('transfer-1');
    change('Payment amount', '9');
    fireEvent.submit(form('Record catering money'));
    await screen.findByText('Payment evidence recorded.');
    const calls = moneyCalls(fetch);
    expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).not.toBe(
      new Headers(calls[0][1]?.headers).get('Idempotency-Key')
    );
  });
  it.each(['tenant', 'role', 'revoked', 'inactive'] as const)(
    'rejects freshly changed staff %s before money transport',
    async (changeType) => {
      const fetch = transport();
      mount();
      select();
      await unlock();
      fill();
      const user = {
        ...session.user,
        ...(changeType === 'tenant'
          ? { organizationId: 'other-org' }
          : changeType === 'role'
            ? { role: 'STAFF' }
            : changeType === 'revoked'
              ? { sessionRevoked: true }
              : { status: 'INACTIVE' }),
      };
      mocks.refreshSession.mockResolvedValue({ ...session, user });
      fireEvent.submit(form('Record catering money'));
      await screen.findByText(/Inputs retained/);
      expect(moneyCalls(fetch)).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Connect enrolled terminal' })).toBeInTheDocument();
      expect(screen.getByLabelText('Payment amount')).toHaveValue('10');
    }
  );
  it('denies a terminal enrolled to another branch', async () => {
    const fetch = transport(undefined, 'branch_2');
    mount();
    select();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect enrolled terminal' }));
    await screen.findByText(/belongs to another organization or branch/);
    expect(screen.getByRole('button', { name: 'Unlock terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record receipt evidence' })).toBeDisabled();
    expect(moneyCalls(fetch)).toHaveLength(0);
  });
  it('keeps an unresolved command with its original operator and permits retry only after that operator returns', async () => {
    let count = 0;
    const fetch = transport((path) =>
      path.endsWith('/money') && ++count === 1 ? json({ error: 'Unknown outcome' }, 503) : undefined
    );
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await screen.findByText(/Outcome unknown/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    change('Operator', 'staff_2');
    change('Operator PIN', '2222');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
    await screen.findByText(/Return to the original staff account/);
    expect(screen.getByRole('button', { name: 'Retry same payment command' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    change('Operator', 'staff_1');
    change('Operator PIN', '1234');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same payment command' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry same payment command' }));
    await screen.findByText('Payment evidence recorded.');
    const calls = moneyCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]?.body).toBe(calls[0][1]?.body);
    expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(calls[0][1]?.headers).get('Idempotency-Key')
    );
  });
  it('allows the Auth.js loading transition while blocking operator changes during a money request', async () => {
    const gate = deferred<typeof session>();
    mocks.refreshSession.mockReturnValue(gate.promise);
    const fetch = transport();
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());
    mocks.staffSession.mockReturnValue({ status: 'loading', data: session });
    change('Filter by status', 'DRAFT');
    expect(screen.getByRole('button', { name: 'Lock terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch operator' })).toBeDisabled();
    await act(async () => gate.resolve(session));
    await screen.findByText('Payment evidence recorded.');
    expect(moneyCalls(fetch)).toHaveLength(1);
  });
  it('rejects an event branch change while staff revalidation is in flight', async () => {
    const gate = deferred<typeof session>();
    mocks.refreshSession.mockReturnValue(gate.promise);
    const fetch = transport();
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());
    act(() =>
      client.setQueryData(['detail', orderA.id], {
        ...orderA,
        branchId: 'branch_2',
        approvedQuoteRevisionId: 'quote_current',
      })
    );
    await screen.findByText(/belongs to another organization or branch/);
    await act(async () => gate.resolve(session));
    await screen.findByText(/Inputs retained/);
    expect(moneyCalls(fetch)).toHaveLength(0);
  });
  it('does not discard an unknown command after a later permission rejection', async () => {
    let count = 0;
    const fetch = transport((path) =>
      path.endsWith('/money')
        ? json(
            { error: ++count === 1 ? 'Response lost' : 'CAPABILITY_DENIED' },
            count === 1 ? 503 : 403
          )
        : undefined
    );
    mount();
    select();
    await unlock();
    fill();
    fireEvent.submit(form('Record catering money'));
    await screen.findByText(/Outcome unknown/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same payment command' }));
    await screen.findByText(/CAPABILITY_DENIED.*Outcome unknown/);
    expect(screen.getByLabelText('Payment amount')).toHaveValue('10');
    expect(screen.getByLabelText('Payment amount')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Select event Team lunch/ })).toBeDisabled();
    const calls = moneyCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1][1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(calls[0][1]?.headers).get('Idempotency-Key')
    );
  });
  it.each(['unauthenticated', 'expired'] as const)(
    'cannot connect money context with an %s staff session',
    async (state) => {
      mocks.staffSession.mockReturnValue(
        state === 'unauthenticated'
          ? { status: state, data: null }
          : { status: 'authenticated', data: { ...session, expires: '2020-01-01T00:00:00Z' } }
      );
      const fetch = transport();
      mount();
      select();
      expect(
        await screen.findByRole('button', { name: 'Connect enrolled terminal' })
      ).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Record receipt evidence' })).toBeDisabled();
      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
