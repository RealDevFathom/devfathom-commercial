import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { CatalogSnapshot } from './catalog-console';

const mocks = vi.hoisted(() => ({
  createProduct: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantCatalog: new Proxy(
      {},
      {
        get: (_target, procedure: string) => ({
          useMutation: () => ({
            mutate: procedure === 'createProduct' ? mocks.createProduct : mocks.mutate,
            isPending: false,
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

  it('renders product descriptions with the AA supporting-text token', () => {
    const productSnapshot: CatalogSnapshot = {
      ...snapshot,
      products: [
        {
          id: 'product_1',
          categoryId: null,
          type: 'ITEM',
          status: 'ACTIVE',
          name: 'House burger',
          description: 'Beef and pickles',
          sortOrder: 0,
          variants: [],
          modifierGroups: [],
          allergens: [],
        },
      ],
    };

    render(
      <EntitlementsProvider value={entitlements(true)}>
        <RestaurantCatalogConsole snapshot={productSnapshot} canRead canWrite />
      </EntitlementsProvider>
    );

    expect(screen.getByText('Beef and pickles')).toHaveClass('text-text-muted');
  });

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
});
