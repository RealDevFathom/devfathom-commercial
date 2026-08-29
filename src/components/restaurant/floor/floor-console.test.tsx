import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  floors: { data: [] as unknown[], error: null as unknown, isLoading: false },
  sections: { data: [] as unknown[], error: null as unknown, isLoading: false },
  stations: { data: [] as unknown[], error: null as unknown, isLoading: false },
  floorCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  sectionCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  stationCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  createFloor: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
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
});
