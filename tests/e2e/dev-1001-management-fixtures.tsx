import { confirmationCatalogSnapshot } from './dev-1001-operations-flow-fixtures';
import type { ReactNode } from 'react';
import { menuImportScreen, menuImportQueryData } from './dev-1001-menu-import-fixture';
import { MoneyConsole } from '@/components/restaurant/money/money-console';
import { CateringConsole } from '@/components/restaurant/catering/catering-console';
import { OrdersConsole } from '@/components/restaurant/orders/orders-console';
import { DeliveryConsole } from '@/components/restaurant/delivery/delivery-console';
import { KdsBoard } from '@/components/restaurant/kds/kds-board';
import {
  RestaurantCatalogConsole,
  type CatalogSnapshot,
} from '@/components/restaurant/catalog/catalog-console';
import {
  RestaurantMenusConsole,
  type MenusSnapshot,
} from '@/components/restaurant/menus/menus-console';
import { RestaurantStaffConsole } from '@/components/restaurant/restaurant-staff-console';
import { RestaurantRosterConsole } from '@/components/restaurant/restaurant-roster-console';
import { RestaurantDevicesConsole } from '@/components/restaurant/restaurant-devices-console';
import { PromotionsConsole } from '@/components/restaurant/promotions/promotions-console';
import { FloorConsole } from '@/components/restaurant/floor/floor-console';
import { LoyaltyConsole } from '@/components/restaurant/loyalty/loyalty-console';
import { PharmacyRegulatoryProfileForm } from '@/components/pharmacy/regulatory-profile-form';
import { PageHeader } from '@/components/ui/page-header';

const branches = [
  {
    id: 'branch-a',
    name: 'Garden branch',
    timezone: 'Asia/Karachi',
    active: true,
    isDefault: true,
  },
];
const catalog: CatalogSnapshot = {
  categories: [],
  products: [],
  modifierGroups: [],
  allergens: [],
  units: [],
  conversions: [],
  ingredients: [],
  recipes: [],
};
const menus: MenusSnapshot = {
  brands: [{ id: 'brand-a', name: 'Example kitchen', status: 'ACTIVE', isDefault: true }],
  branches,
  products: [],
  menus: [],
  priceLists: [],
  publications: [],
};

export const managementScreens: Record<string, ReactNode> = {
  'restaurant-menu-import': menuImportScreen,
  'restaurant-money': <MoneyConsole canReadFinance initialTab="terminal" />,
  'restaurant-catering': <CateringConsole currency="PKR" />,
  'restaurant-orders': <OrdersConsole />,
  'restaurant-delivery': <DeliveryConsole />,
  'restaurant-kds': <KdsBoard />,
  'restaurant-catalog': (
    <RestaurantCatalogConsole
      snapshot={
        new URLSearchParams(location.search).get('state') === 'confirmation'
          ? confirmationCatalogSnapshot
          : catalog
      }
      canRead
      canWrite
    />
  ),
  'restaurant-menus': (
    <RestaurantMenusConsole snapshot={menus} canRead canWrite canPrice canPublish />
  ),
  'restaurant-staff': <RestaurantStaffConsole />,
  'restaurant-roster': <RestaurantRosterConsole />,
  'restaurant-devices': <RestaurantDevicesConsole />,
  'restaurant-promotions': <PromotionsConsole />,
  'restaurant-floor': <FloorConsole />,
  'restaurant-loyalty': <LoyaltyConsole />,
  'pharmacy-regulatory': (
    <>
      <PageHeader eyebrow="Pharmacy setup" heading="Premises and licences" />
      <PharmacyRegulatoryProfileForm
        initial={{
          branches: [
            {
              id: 'branch-a',
              name: 'Garden branch',
              addressLine: '12 Example Road',
              city: 'Lahore',
              provinceCode: 'PK-PB',
            },
          ],
          selectedBranchId: 'branch-a',
          jurisdictions: [],
          versions: [],
        }}
      />
    </>
  ),
};
export const managementQueryData: Record<string, unknown> = {
  ...menuImportQueryData,
  'restaurantOrders.listOrders': { orders: [], nextCursor: null },
  'restaurantDelivery.listCustomers': { customers: [] },
  'restaurantPayments.getTenderTypeTotals': null,
  'restaurantStaff.listBranches': branches,
  'restaurantFloor.access': {
    canRead: true,
    canWrite: true,
    canManage: true,
    canManageFloors: true,
    canManageSections: true,
    canManageStations: true,
  },
  'restaurantPromotions.list': [],
  'restaurantPromotions.pickerOptions': {
    products: [],
    categories: [],
    branches,
    currencies: ['PKR'],
    currency: 'PKR',
  },
  'pharmacyOnboarding.pharmacistCoverage': {
    windows: [],
    revision: 1,
    liveSaleHoursCheck: false,
    timeZone: 'Asia/Karachi',
  },
  'restaurantShifts.myRoster': { shifts: [], clockEvents: [], timeOff: [], swaps: [] },
  'restaurantShifts.managerRoster': [],
};
