import { useEffect, useState, type ReactNode } from 'react';

import InventoryPage from '@/app/(app)/restaurant/inventory/page';

const locations = [
  { id: 'fixture-stock-kitchen', name: 'Main kitchen' },
  { id: 'fixture-stock-store', name: 'Dry store' },
];
const stockItems = [
  { id: 'fixture-stock-rice', ingredient: { name: 'Example basmati rice' } },
  { id: 'fixture-stock-flour', ingredient: { name: 'Example plain flour' } },
];
const count = {
  id: 'fixture-stock-count',
  locationId: locations[0]!.id,
  status: 'DRAFT',
  reference: 'Example opening count',
  countedAt: new Date('2026-11-20T09:00:00.000Z'),
  submittedAt: null,
  postedAt: null,
  _count: { lines: 0 },
  lines: [],
};
const transfer = {
  id: 'fixture-stock-transfer',
  reference: 'Example kitchen transfer',
  status: 'DRAFT',
  sourceLocationId: locations[1]!.id,
  destinationLocationId: locations[0]!.id,
  _count: { lines: 0 },
};
const actor = {
  session: { expires: '2099-01-01', user: { id: 'fixture-owner', organizationId: 'fixture-org' } },
  organization: { id: 'fixture-org', slug: 'isolated-example', status: 'ACTIVE' },
  support: null,
};

/** The runner substitutes these only for imports made by the actual inventory page. */
export const inventoryCan = async () => true;
export const inventorySubjectFromSession = (user: { id: string }) => ({ id: user.id });
export const inventoryHasModule = () => true;
export const inventoryResolveTenantActor = async () => actor;
export const inventoryCreateTRPCContext = async () => ({
  ...actor,
  entitlements: { enabledModules: ['restaurant-inventory'] },
  db: {
    restaurantStockLocation: { findMany: async () => locations },
    restaurantStockItem: { findMany: async () => stockItems },
    restaurantStockCount: { findFirst: async () => count },
  },
});
export const inventoryRouter = {
  createCaller: () => ({
    listStockOnHand: async () => [],
    evaluateLowStockRules: async () => [],
    listStockMovements: async () => ({ items: [] }),
    listStockCounts: async () => ({ items: [count] }),
    listStockTransfers: async () => ({ items: [transfer] }),
  }),
};

/** Resolve the real server component locally. No form is submitted and no server is contacted. */
export function InventoryPageFixture() {
  const [page, setPage] = useState<ReactNode>(null);
  useEffect(() => {
    let active = true;
    void InventoryPage({ searchParams: Promise.resolve({}) }).then((result) => {
      if (active) setPage(result);
    });
    return () => {
      active = false;
    };
  }, []);
  return page;
}

export const inventoryPageScreens: Record<string, ReactNode> = {
  'restaurant-inventory': <InventoryPageFixture />,
};
export const inventoryPageSources = {
  'restaurant-inventory': ['src/app/(app)/restaurant/inventory/page.tsx'],
};
