import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  recipeCost: {
    data: null as unknown,
    error: { message: 'Missing exact conversion from tbsp to gram for Flour.' },
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  },
  createProduct: vi.fn(),
  addRecipeLineSubstitute: vi.fn(),
  removeRecipeLineSubstitute: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantCatalog: { getRecipeCost: { invalidate: mocks.invalidate } } }),
    restaurantCatalog: new Proxy(
      {
        getRecipeCost: { useQuery: () => mocks.recipeCost },
      },
      {
        get: (target, procedure: string) =>
          procedure in target
            ? target[procedure as keyof typeof target]
            : {
                useMutation: () => ({
                  mutate:
                    procedure === 'createProduct'
                      ? mocks.createProduct
                      : procedure === 'addRecipeLineSubstitute'
                        ? mocks.addRecipeLineSubstitute
                        : procedure === 'removeRecipeLineSubstitute'
                          ? mocks.removeRecipeLineSubstitute
                          : mocks.mutate,
                  isPending: false,
                }),
              },
      }
    ),
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantCatalogConsole, type CatalogSnapshot } from './catalog-console';

const entitlement: EntitlementView = {
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: ['restaurant-menu'],
  modules: [
    {
      key: 'restaurant-menu',
      name: 'Menu and Costing',
      enabled: true,
      source: 'PACKAGE',
      seatLimit: null,
      expiresAt: null,
    },
  ],
  limits: {},
};

const snapshot: CatalogSnapshot = {
  categories: [],
  modifierGroups: [],
  allergens: [],
  units: [{ id: 'unit_1', name: 'Gram', abbreviation: 'g' }],
  conversions: [],
  ingredients: [
    { id: 'ingredient_1', name: 'Flour', baseUnitId: 'unit_1', referenceCost: '1', allergens: [] },
    {
      id: 'ingredient_2',
      name: 'Rice flour',
      baseUnitId: 'unit_1',
      referenceCost: '2',
      allergens: [],
    },
    {
      id: 'ingredient_3',
      name: 'Corn flour',
      baseUnitId: 'unit_1',
      referenceCost: '3',
      allergens: [],
    },
  ],
  products: [
    {
      id: 'combo_1',
      categoryId: null,
      type: 'COMBO',
      status: 'ACTIVE',
      name: 'Lunch deal',
      description: null,
      sortOrder: 0,
      variants: [],
      modifierGroups: [],
      allergens: [],
      comboComponentGroups: [
        {
          id: 'combo_group_1',
          comboProductId: 'combo_1',
          name: 'Choose a side',
          minChoose: 1,
          maxChoose: 2,
          sortOrder: 3,
          options: [
            {
              id: 'combo_option_1',
              componentGroupId: 'combo_group_1',
              productId: 'item_1',
              variantId: null,
              priceDelta: '150',
              sortOrder: 0,
            },
          ],
        },
      ],
    },
    {
      id: 'item_1',
      categoryId: null,
      type: 'ITEM',
      status: 'ACTIVE',
      name: 'Fries',
      description: null,
      sortOrder: 1,
      variants: [],
      modifierGroups: [],
      allergens: [],
      comboComponentGroups: [],
    },
  ],
  recipes: [
    {
      id: 'recipe_1',
      productId: 'item_1',
      variantId: null,
      name: 'Fries recipe',
      versions: [
        {
          id: 'version_1',
          recipeId: 'recipe_1',
          versionNumber: 1,
          status: 'DRAFT',
          yieldQuantity: null,
          yieldUnitId: null,
          portionCount: 1,
          notes: null,
          activatedAt: null,
          supersededAt: null,
          lines: [
            {
              id: 'line_1',
              recipeVersionId: 'version_1',
              ingredientId: 'ingredient_1',
              subRecipeId: null,
              quantity: '100',
              unitId: 'unit_1',
              sortOrder: 0,
              approvedSubstitutes: [{ id: 'substitute_1', substituteIngredientId: 'ingredient_2' }],
            },
          ],
        },
      ],
    },
  ],
};

function renderCatalog(enabled = true) {
  const value = enabled
    ? entitlement
    : {
        ...entitlement,
        enabledModules: [],
        modules: [{ ...entitlement.modules[0]!, enabled: false }],
      };
  return render(
    <EntitlementsProvider value={value}>
      <RestaurantCatalogConsole snapshot={snapshot} canRead canWrite />
    </EntitlementsProvider>
  );
}

describe('RestaurantCatalogConsole gap recovery flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.recipeCost, {
      data: null,
      error: { message: 'Missing exact conversion from tbsp to gram for Flour.' },
      isLoading: false,
      isError: true,
    });
  });

  it('gates the console when restaurant-menu is disabled', () => {
    renderCatalog(false);

    expect(screen.getByText('Menu and Costing module disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
  });

  it('creates a catalog item with an explicit product type', () => {
    renderCatalog();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add product' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Add product' });
    fireEvent.change(within(dialog).getByLabelText('Product name'), {
      target: { value: 'House burger' },
    });
    fireEvent.change(
      selectFieldControl(
        within(dialog).getByLabelText('Product type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      ),
      {
        target: { value: 'COMBO' },
      }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add product' }));

    expect(mocks.createProduct).toHaveBeenCalledWith({
      name: 'House burger',
      description: null,
      categoryId: null,
      sortOrder: 0,
      type: 'COMBO',
    });
  });

  it('creates a plain catalog item through the existing router', () => {
    renderCatalog();
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
      type: 'ITEM',
    });
  });

  it('shows recipe costs, branch food-cost percentage, and missing ingredients', () => {
    Object.assign(mocks.recipeCost, {
      data: {
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
      },
      isError: false,
    });
    renderCatalog();
    fireEvent.click(screen.getByRole('tab', { name: /Recipes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage versions' }));

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('Missing cost')).toBeInTheDocument();
    expect(screen.getByText('Truffle')).toBeInTheDocument();
    expect(screen.getByText('30% at 10')).toBeInTheDocument();
  });

  it('shows existing combo choice cardinality, components, price delta, and authoring actions', () => {
    renderCatalog();
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[0]);

    expect(screen.getByRole('heading', { name: 'Combo choices' })).toBeInTheDocument();
    expect(screen.getByText('Choose 1–2 · Order 3')).toBeInTheDocument();
    expect(screen.getAllByText('Fries').length).toBeGreaterThan(0);
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add component option' })).toBeEnabled();
    expect(screen.getByText(/Combos cannot be added to menus or ordered/)).toBeInTheDocument();
  });

  it('confirms before removing a combo component option', () => {
    renderCatalog();
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Remove Fries?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove option' }));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: 'combo_option_1' });
  });

  it('shows approved substitutes and attaches and removes them from draft ingredient lines', () => {
    renderCatalog();
    fireEvent.click(screen.getByRole('tab', { name: /Recipes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage versions' }));

    expect(screen.getByText('Rice flour')).toBeInTheDocument();
    const substitutePicker = screen.getByLabelText('Approved substitute ingredient', {
      selector: ':not([data-select-field-native][aria-hidden="true"])',
    });
    fireEvent.change(selectFieldControl(substitutePicker), { target: { value: 'ingredient_3' } });
    fireEvent.submit(substitutePicker.closest('form')!);
    expect(mocks.addRecipeLineSubstitute).toHaveBeenCalledWith({
      recipeLineId: 'line_1',
      substituteIngredientId: 'ingredient_3',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Rice flour' }));
    expect(mocks.removeRecipeLineSubstitute).toHaveBeenCalledWith({ id: 'substitute_1' });
  });

  it('preserves the actionable costing error and directs the operator to corrective catalog data', () => {
    renderCatalog();
    fireEvent.click(screen.getByRole('tab', { name: /Recipes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage versions' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Missing exact conversion from tbsp to gram for Flour.');
    expect(alert).toHaveTextContent('Ingredients and Units / Conversions');
    expect(within(alert).getByRole('button', { name: 'Recalculate' })).toBeEnabled();
  });
});
