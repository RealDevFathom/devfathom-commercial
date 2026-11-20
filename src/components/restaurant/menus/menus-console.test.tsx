import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { MenusSnapshot } from './menus-console';

const mocks = vi.hoisted(() => ({
  effectiveMenu: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => {
  const procedures = new Proxy(
    {},
    {
      get: (_target, procedure: string) =>
        procedure === 'effectiveMenu'
          ? { useQuery: mocks.effectiveMenu }
          : { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    }
  );
  return { trpc: { restaurantCatalog: procedures, restaurantMenus: procedures } };
});

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { RestaurantMenusConsole } from './menus-console';

const snapshot: MenusSnapshot = {
  brands: [{ id: 'brand_1', name: 'House', status: 'ACTIVE', isDefault: true }],
  branches: [
    {
      id: 'branch_1',
      name: 'Central',
      timezone: 'UTC',
      active: true,
      isDefault: true,
    },
  ],
  products: [
    {
      id: 'product_1',
      name: 'Burger',
      status: 'ACTIVE',
      variants: [{ id: 'variant_1', productId: 'product_1', name: 'Double' }],
    },
  ],
  menus: [
    {
      id: 'menu_1',
      brandId: 'brand_1',
      name: 'All day',
      description: null,
      sections: [
        {
          id: 'section_1',
          menuId: 'menu_1',
          name: 'Mains',
          sortOrder: 0,
          items: [
            {
              id: 'item_1',
              sectionId: 'section_1',
              productId: 'product_1',
              variantId: null,
              displayName: null,
              sortOrder: 0,
            },
          ],
        },
      ],
    },
  ],
  priceLists: [],
  publications: [
    {
      id: 'publication_1',
      branchId: 'branch_1',
      menuId: 'menu_1',
      priceListId: null,
      status: 'PUBLISHED',
      channels: ['DINE_IN'],
      publishedAt: '2026-08-18T00:00:00.000Z',
      retiredAt: null,
      windows: [],
      exceptions: [],
      itemOverrides: [],
    },
  ],
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

function renderConsole(
  props: Partial<React.ComponentProps<typeof RestaurantMenusConsole>> = {},
  enabled = true
) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <RestaurantMenusConsole snapshot={snapshot} canRead canWrite canPrice canPublish {...props} />
    </EntitlementsProvider>
  );
}

describe('Restaurant menus console', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effectiveMenu.mockReturnValue({
      data: null,
      error: null,
      isFetching: false,
    });
  });

  it('gates the console when restaurant-menu is disabled', () => {
    renderConsole({}, false);

    expect(screen.getByText('Menu and Costing module disabled')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Brands/ })).not.toBeInTheDocument();
  });

  it('shows permission denial without operational controls', () => {
    renderConsole({
      snapshot: null,
      canRead: false,
      canWrite: false,
      canPrice: false,
      canPublish: false,
    });

    expect(screen.getByText('Menu access unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add brand' })).not.toBeInTheDocument();
  });

  it('offers supported channels and queries effectiveMenu with channel and instant', () => {
    renderConsole();

    fireEvent.click(screen.getByRole('tab', { name: 'Effective preview' }));
    expect(screen.getAllByRole('option', { hidden: true, name: 'DELIVERY' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: false })])
    );
    fireEvent.change(selectFieldControl(screen.getByLabelText('Preview channel', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'TAKEAWAY' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Preview instant', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2026-08-18T12:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load effective menu' }));

    const enabledCall = mocks.effectiveMenu.mock.calls.find((call) => call[1]?.enabled);
    expect(enabledCall?.[0]).toEqual({
      publicationId: 'publication_1',
      channel: 'TAKEAWAY',
      at: new Date('2026-08-18T12:30'),
    });
  });

  it('allows delivery in publication channel controls', () => {
    renderConsole();

    fireEvent.click(screen.getByRole('tab', { name: /Publications/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));

    expect(
      screen.getAllByLabelText('DELIVERY', { selector: ':not([data-select-field-native][aria-hidden="true"])' }).every((control) => !control.hasAttribute('disabled'))
    ).toBe(true);
    expect(screen.getByLabelText('DINE IN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeEnabled();
    expect(screen.getByLabelText('TAKEAWAY', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeEnabled();
  });

  it('renders price-list money with two decimal places', () => {
    renderConsole({
      snapshot: {
        ...snapshot,
        priceLists: [
          {
            id: 'price_list_1',
            name: 'Standard',
            isDefault: true,
            versions: [
              {
                id: 'version_1',
                priceListId: 'price_list_1',
                versionNumber: 1,
                effectiveFrom: '2026-08-18T00:00:00.000Z',
                status: 'DRAFT',
                activatedAt: null,
                supersededAt: null,
                entries: [
                  {
                    id: 'entry_1',
                    priceListVersionId: 'version_1',
                    productId: 'product_1',
                    variantId: null,
                    price: '950.00',
                  },
                  {
                    id: 'entry_2',
                    priceListVersionId: 'version_1',
                    productId: 'product_1',
                    variantId: 'variant_1',
                    price: '12.50',
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole('tab', { name: /Price lists/ }));

    expect(screen.getByText('950.00')).toBeVisible();
    expect(screen.getByText('12.50')).toBeVisible();
  });
});
