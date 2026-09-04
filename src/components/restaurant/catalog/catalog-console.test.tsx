import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { CatalogSnapshot } from './catalog-console';

const mocks = vi.hoisted(() => ({
  createProduct: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
  invalidateCost: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantCatalog: { getRecipeCost: { invalidate: mocks.invalidateCost } },
    }),
    restaurantCatalog: new Proxy(
      {},
      {
        get: (_target, procedure: string) => ({
          useMutation: () => ({
            mutate: procedure === 'createProduct' ? mocks.createProduct : mocks.mutate,
            isPending: false,
          }),
          useQuery: () => ({
            data:
              procedure === 'getRecipeCost'
                ? {
                    batchCost: '12',
                    costPerPortion: '3',
                    costPerYieldUnit: '6',
                    missing: ['Truffle'],
                    priceComparisons: [
                      {
                        branchId: 'branch_1',
                        branchName: 'Downtown',
                        price: '10',
                        foodCostPercent: '30',
                      },
                    ],
                  }
                : undefined,
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
          }),
        }),
      }
    ),
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantCatalogConsole } from './catalog-console';

const snapshot: CatalogSnapshot = {
  categories: [],
  products: [],
  modifierGroups: [],
  allergens: [],
  units: [],
  conversions: [],
  ingredients: [],
  recipes: [],
};

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-menu'] : [],
    modules: [
      {
        key: 'restaurant-menu',
        name: 'Menu and Costing',
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
      <RestaurantCatalogConsole snapshot={snapshot} canRead canWrite />
    </EntitlementsProvider>
  );
}

describe('Restaurant catalog console', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gates the console when restaurant-menu is disabled', () => {
    renderConsole(false);

    expect(screen.getByText('Menu and Costing module disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
  });

  it('creates a plain catalog item through the existing router', () => {
    renderConsole();

    fireEvent.click(screen.getAllByRole('button', { name: 'Add product' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Add product' });
    fireEvent.change(within(dialog).getByLabelText('Product name'), {
      target: { value: 'House burger' },
    });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Beef and pickles' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add product' }));

    expect(mocks.createProduct).toHaveBeenCalledWith({
      name: 'House burger',
      description: 'Beef and pickles',
      categoryId: null,
      sortOrder: 0,
    });
  });

  it('shows recipe costs, branch food-cost percentage, and missing ingredients', () => {
    const recipeSnapshot: CatalogSnapshot = {
      ...snapshot,
      products: [
        {
          id: 'product_1',
          categoryId: null,
          type: 'ITEM',
          status: 'ACTIVE',
          name: 'Pasta',
          description: null,
          sortOrder: 0,
          variants: [],
          modifierGroups: [],
          allergens: [],
        },
      ],
      recipes: [
        {
          id: 'recipe_1',
          productId: 'product_1',
          variantId: null,
          name: 'Pasta batch',
          versions: [
            {
              id: 'version_1',
              recipeId: 'recipe_1',
              versionNumber: 1,
              status: 'ACTIVE',
              yieldQuantity: '2',
              yieldUnitId: null,
              portionCount: 4,
              notes: null,
              activatedAt: null,
              supersededAt: null,
              lines: [],
            },
          ],
        },
      ],
    };
    render(
      <EntitlementsProvider value={entitlements(true)}>
        <RestaurantCatalogConsole snapshot={recipeSnapshot} canRead canWrite />
      </EntitlementsProvider>
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Recipes (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage versions' }));

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('Missing cost')).toBeInTheDocument();
    expect(screen.getByText('Truffle')).toBeInTheDocument();
    expect(screen.getByText('30% at 10')).toBeInTheDocument();
  });
});
