import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({ transition: vi.fn(), invalidate: vi.fn() }));
const order = {
  id: 'order_1',
  branchId: 'branch_1',
  customerId: null,
  eventName: 'Founders dinner',
  eventDate: new Date('2026-09-20T00:00:00Z'),
  serviceTime: null,
  headcount: 40,
  venueAddress: 'Atrium',
  deliveryAddressId: null,
  status: 'DRAFT' as const,
  quotedTotal: '1200',
  depositAmount: '200',
  notes: null,
  createdByStaffId: null,
  lines: [],
  extraCosts: [],
  delivery: null,
  events: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  organizationId: 'org_1',
};
function query(data: unknown) {
  return { data, error: null, isLoading: false, refetch: vi.fn() };
}
function mutation(mutate = vi.fn()) {
  return { mutate, isPending: false };
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantCatering: { invalidate: mocks.invalidate } }),
    restaurantStaff: {
      listBranches: {
        useQuery: () => query([{ id: 'branch_1', name: 'Central', active: true, isDefault: true }]),
      },
      listDirectory: {
        useQuery: () => query([{ id: 'staff_1', displayName: 'Mina Driver', role: 'Driver' }]),
      },
    },
    restaurantCatalog: {
      listProducts: { useQuery: () => query([{ id: 'product_1', name: 'Lunch box' }]) },
      listRecipes: {
        useQuery: () =>
          query([
            {
              id: 'recipe_1',
              name: 'Harvest lunch',
              activeVersionId: 'version_1',
              portionCount: 20,
            },
          ]),
      },
      listRecipeCosts: {
        useQuery: () => query([{ recipeId: 'recipe_1', costPerPortion: '4.25' }]),
      },
    },
    restaurantDelivery: {
      listCustomers: { useQuery: () => query({ customers: [], nextCursor: null }) },
      listAddresses: { useQuery: () => query([]) },
    },
    restaurantCatering: {
      list: { useQuery: () => query([order]) },
      get: { useQuery: () => query(order) },
      productionRequirements: {
        useQuery: () =>
          query([
            {
              ingredientId: 'ingredient_1',
              ingredientName: 'Rice',
              baseUnitId: 'kg',
              stockItemId: null,
              quantityInBaseUnit: '5',
            },
          ]),
      },
      costSummary: {
        useQuery: () =>
          query({
            recipeCost: '170',
            extraCost: '30',
            totalCost: '200',
            quotedTotal: '1200',
            margin: '1000',
            marginPercent: '83.333',
          }),
      },
      create: { useMutation: () => mutation() },
      update: { useMutation: () => mutation() },
      addLine: { useMutation: () => mutation() },
      removeLine: { useMutation: () => mutation() },
      addExtraCost: { useMutation: () => mutation() },
      removeExtraCost: { useMutation: () => mutation() },
      setDelivery: { useMutation: () => mutation() },
      transition: { useMutation: () => mutation(mocks.transition) },
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

describe('CateringConsole', () => {
  beforeEach(() => {
    mocks.transition.mockReset();
  });
  it('labels filters and exposes the keyboard-selectable order', () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <CateringConsole />
      </EntitlementsProvider>
    );
    expect(screen.getByRole('heading', { name: 'Filters', level: 2 })).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by branch')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('row', { name: /Founders dinner/ }), { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Founders dinner' })).toBeInTheDocument();
    expect(screen.getByLabelText('Product or recipe')).toHaveTextContent('Harvest lunch');
  });
  it('requires confirmation before a status transition', () => {
    render(
      <EntitlementsProvider value={entitlements}>
        <CateringConsole />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByRole('row', { name: /Founders dinner/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to quoted' }));
    expect(screen.getByRole('dialog', { name: 'Confirm status change' })).toBeInTheDocument();
    expect(mocks.transition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(mocks.transition).toHaveBeenCalledWith({ orderId: 'order_1', to: 'QUOTED' });
  });
});
