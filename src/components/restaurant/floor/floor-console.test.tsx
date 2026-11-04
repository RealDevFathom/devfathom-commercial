import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  floors: { data: [] as unknown[], error: null as unknown, isLoading: false },
  sections: { data: [] as unknown[], error: null as unknown, isLoading: false },
  stations: { data: [] as unknown[], error: null as unknown, isLoading: false },
  access: { data: { canManage: true }, error: null as unknown, isLoading: false },
  floorCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  sectionCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  stationCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  createFloor: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
  products: [
    { id: 'product_1', name: 'Chicken Karahi' },
    { id: 'product_2', name: 'Mango Lassi' },
  ],
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantCatalog: {
      listProducts: { useQuery: () => ({ data: mocks.products, error: null, isLoading: false }) },
      listCategories: { useQuery: () => ({ data: [], error: null, isLoading: false }) },
    },
    restaurantStaff: {
      listBranches: {
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
          error: null,
          isLoading: false,
        }),
      },
      listDirectory: {
        useQuery: () => ({
          data: [{ id: 'staff_1', displayName: 'Shift Lead', role: 'Server' }],
          error: null,
          isLoading: false,
        }),
      },
    },
    useUtils: () => ({
      restaurantFloor: {
        listFloors: { invalidate: mocks.invalidate },
        listSections: { invalidate: mocks.invalidate },
        listStations: { invalidate: mocks.invalidate },
      },
    }),
    restaurantFloor: new Proxy(
      {
        access: {
          useQuery: () => mocks.access,
        },
        listFloors: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.floorCalls.push({ input, enabled: options.enabled });
            return mocks.floors;
          },
        },
        listSections: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.sectionCalls.push({ input, enabled: options.enabled });
            return mocks.sections;
          },
        },
        listStations: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            mocks.stationCalls.push({ input, enabled: options.enabled });
            return mocks.stations;
          },
        },
      },
      {
        get: (target, procedure: string) =>
          procedure in target
            ? target[procedure as keyof typeof target]
            : {
                useMutation: () => ({
                  mutate: procedure === 'createFloor' ? mocks.createFloor : mocks.mutate,
                  isPending: false,
                }),
              },
      }
    ),
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { FloorConsole } from './floor-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-pos'] : [],
    modules: [
      {
        key: 'restaurant-pos',
        name: 'Restaurant POS',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  };
}

function renderConsole(enabled = true) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <FloorConsole />
    </EntitlementsProvider>
  );
}

describe('FloorConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.floors.data = [];
    mocks.stations.data = [];
    mocks.access.data = { canManage: true };
    mocks.floorCalls.length = 0;
    mocks.sectionCalls.length = 0;
    mocks.stationCalls.length = 0;
  });

  it('gates all reads by entitlement, branch, and business date', () => {
    const disabled = renderConsole(false);
    expect(mocks.floorCalls.at(-1)?.enabled).toBe(false);
    expect(mocks.sectionCalls.at(-1)?.enabled).toBe(false);
    expect(mocks.stationCalls.at(-1)?.enabled).toBe(false);
    expect(screen.getByText('Restaurant POS module disabled')).toBeInTheDocument();
    disabled.unmount();

    renderConsole();
    expect(mocks.floorCalls.at(-1)?.enabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(mocks.floorCalls.at(-1)).toEqual({
      input: { branchId: 'branch_1', includeInactive: false },
      enabled: true,
    });
    expect(mocks.stationCalls.at(-1)?.enabled).toBe(true);
    expect(mocks.sectionCalls.at(-1)?.enabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Business date'), {
      target: { value: '2026-08-19' },
    });
    expect(mocks.sectionCalls.at(-1)).toEqual({
      input: { branchId: 'branch_1', businessDate: '2026-08-19', includeInactive: false },
      enabled: true,
    });
  });

  it('shows the floor label without its raw ID and preserves the mutation ID', () => {
    const floorId = 'floor_raw_1620';
    mocks.floors.data = [
      { id: floorId, name: 'Garden Terrace', sortOrder: 3, active: true, tables: [] },
    ];
    const { container } = renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });

    expect(screen.getByText('Garden Terrace · sort 3')).toBeVisible();
    expect(container).not.toHaveTextContent(floorId);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit floor' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit floor' }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      id: floorId,
      name: 'Garden Terrace',
      sortOrder: 3,
      active: true,
    });
  });

  it('creates a floor with the exact router payload', () => {
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add floor' }));
    const dialog = screen.getByRole('dialog', { name: 'Add floor' });
    fireEvent.change(within(dialog).getByLabelText('Floor name'), {
      target: { value: 'Patio' },
    });
    fireEvent.change(within(dialog).getByLabelText('Sort order'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add floor' }));

    expect(mocks.createFloor).toHaveBeenCalledWith({
      branchId: 'branch_1',
      name: 'Patio',
      sortOrder: 3,
    });
  });

  it('renders an authoritative read-only view without mutation controls', () => {
    mocks.access.data = { canManage: false };
    mocks.floors.data = [
      { id: 'floor_1', name: 'Dining room', sortOrder: 0, active: true, tables: [] },
    ];
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });

    expect(screen.getByText('Read-only floor')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add floor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add table' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('does not offer Make default for an inactive station', () => {
    mocks.stations.data = [
      {
        id: 'station_1',
        name: 'Old pass',
        active: false,
        isDefault: false,
        routingRules: [],
      },
    ];
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(screen.queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
  });

  it('searches active catalog labels and submits the selected product invisibly', () => {
    mocks.stations.data = [
      {
        id: 'station_1',
        name: 'Hot Kitchen',
        active: true,
        isDefault: true,
        routingRules: [],
      },
    ];
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = screen.getByRole('dialog', { name: 'Add routing rule' });
    fireEvent.change(within(dialog).getByPlaceholderText('Search products'), {
      target: { value: 'karahi' },
    });
    const product = within(dialog).getByLabelText('Product');
    expect(within(product).getByRole('option', { name: 'Chicken Karahi' })).toBeVisible();
    expect(within(product).queryByRole('option', { name: 'Mango Lassi' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/product or category id/i)).not.toBeInTheDocument();
  });
});
