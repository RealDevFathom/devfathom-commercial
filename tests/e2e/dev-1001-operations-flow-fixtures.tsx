import type { CatalogSnapshot } from '@/components/restaurant/catalog/catalog-console';

/** Synthetic presentation data only. Scope each map to its named screen. */
const operators = [
  { id: 'fixture-shift-operator-a', displayName: 'Amina Example', status: 'ACTIVE' },
  { id: 'fixture-shift-operator-b', displayName: 'Bilal Example', status: 'ACTIVE' },
];
const stations = [
  {
    id: 'fixture-kitchen-main',
    branchId: 'branch-a',
    name: 'Main kitchen',
    active: true,
    isDefault: true,
    routingRules: [],
  },
  {
    id: 'fixture-kitchen-drinks',
    branchId: 'branch-a',
    name: 'Drinks station',
    active: true,
    isDefault: false,
    routingRules: [],
  },
];

export const operationsFlowQueryData: Record<string, Record<string, unknown>> = {
  'restaurant-roster': { 'restaurantStaff.list': operators },
  'restaurant-devices': { 'restaurantFloor.listStations': stations },
  'restaurant-floor': {
    'restaurantFloor.listStations': stations,
    'restaurantCatalog.listProducts': [
      { id: 'fixture-routing-product-a', name: 'Example vegetable wrap', status: 'ACTIVE' },
      { id: 'fixture-routing-product-b', name: 'Example fresh lemonade', status: 'ACTIVE' },
    ],
    'restaurantCatalog.listCategories': [
      { id: 'fixture-routing-category-a', name: 'Example mains' },
      { id: 'fixture-routing-category-b', name: 'Example drinks' },
    ],
  },
};

/** The real archive confirmation may be opened and cancelled, never confirmed. */
export const confirmationCatalogSnapshot: CatalogSnapshot = {
  categories: [],
  products: [
    {
      id: 'fixture-archive-product',
      categoryId: null,
      type: 'ITEM',
      status: 'ACTIVE',
      name: 'Example seasonal soup',
      description: 'Local presentation fixture for archive confirmation.',
      sortOrder: 0,
      variants: [],
      modifierGroups: [],
      comboComponentGroups: [],
      allergens: [],
    },
  ],
  modifierGroups: [],
  allergens: [],
  units: [],
  conversions: [],
  ingredients: [],
  recipes: [],
};

/** UI preparation instructions for the runner, using existing component actions. */
export const operationsFlowPreparation = {
  'restaurant-roster': {
    branch: 'branch-a',
    button: 'Schedule shift',
    dialog: 'Schedule shift',
    visibleMigratedControls: ['Operator'],
  },
  'restaurant-devices': {
    button: 'Enroll device',
    dialog: 'Enroll this browser',
    branch: 'branch-a',
    deviceKind: 'Kitchen display',
    visibleMigratedControls: ['Device kind', 'KDS station'],
  },
  'restaurant-floor': {
    branch: 'branch-a',
    button: 'Add rule',
    buttonIndex: 0,
    dialog: 'Add routing rule',
    visibleMigratedControls: ['Target type', 'Product'],
  },
  confirmation: {
    screen: 'restaurant-catalog',
    button: 'Archive',
    dialog: 'Archive Example seasonal soup?',
    cancel: 'Cancel',
  },
} as const;
