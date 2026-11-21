import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';

import NotificationsPage from '@/app/(app)/restaurant/notifications/page';
import PurchasingPage from '@/app/(app)/restaurant/purchasing/page';
import ReportsPage from '@/app/(app)/restaurant/reports/page';
import RestaurantSopAdminPage from '@/app/(app)/restaurant/sop/admin/sop-admin';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import { GrowthReviewPanel } from '@/components/restaurant/growth/growth-review-panel';
import { PrintRoutingSection } from '@/components/restaurant/print-routing-section';
import { RestaurantTaxConsole } from '@/components/restaurant/restaurant-tax-console';
import { PageHeader } from '@/components/ui/page-header';
import type { GrowthView } from '@/lib/restaurant/growth-review-contract';
import { PAKISTAN_TAX_PROFILE_CATALOG } from '@/lib/restaurant/pakistan-tax-profiles';

const branches = [
  {
    id: 'branch-a',
    name: 'Garden branch',
    active: true,
    isDefault: true,
    timezone: 'Asia/Karachi',
  },
  {
    id: 'branch-b',
    name: 'Riverside branch',
    active: true,
    isDefault: false,
    timezone: 'Asia/Karachi',
  },
];
const locations = branches.map((branch, index) => ({
  id: `fixture-gap-location-${index}`,
  branchId: branch.id,
  name: `${branch.name} stock room`,
}));
const stockItems = [
  {
    id: 'fixture-gap-stock-rice',
    canonicalUnitId: 'fixture-gap-unit-kg',
    ingredient: { name: 'Example basmati rice' },
  },
];
const supplier = {
  id: 'fixture-gap-supplier',
  name: 'Example food supplier',
  contactName: null,
  email: null,
  phone: null,
};
const order = {
  id: 'fixture-gap-purchase-order',
  branchId: branches[0]!.id,
  locationId: locations[0]!.id,
  reference: 'Example approved purchase',
  status: 'APPROVED',
  supplierId: supplier.id,
  supplierName: supplier.name,
  createdAt: new Date('2026-11-20T09:00:00.000Z'),
  expectedDate: null,
  receiptCount: 0,
  receipts: [],
  lines: [
    {
      id: 'fixture-gap-order-line',
      stockItemId: stockItems[0]!.id,
      unitId: 'fixture-gap-unit-kg',
      orderedQuantity: '10',
      receivedQuantityCanonical: '0',
      unitCost: '200.00',
    },
  ],
};
const actor = {
  session: { expires: '2099-01-01', user: { id: 'fixture-user', organizationId: 'fixture-org' } },
  organization: { id: 'fixture-org', slug: 'isolated-example', status: 'ACTIVE' },
  support: null,
};

/** Server boundaries used only by these three presentation pages; no mutation is exposed. */
export const gapRestaurantCan = async () => true;
export const gapRestaurantSubject = (user: { id: string }) => ({ id: user.id });
export const gapRestaurantHasModule = () => true;
export const gapRestaurantActor = async () => actor;
export const gapRestaurantStaffActor = async () => ({
  staffProfileId: 'fixture-staff',
  branchIds: branches.map((b) => b.id),
});
export const gapRestaurantContext = async () => ({
  ...actor,
  requestMeta: { ip: null },
  entitlements: {
    enabledModules: ['restaurant-core', 'restaurant-inventory', 'restaurant-purchasing'],
  },
  db: {
    restaurantBranch: { findMany: async () => branches },
    restaurantStockLocation: { findMany: async () => locations },
    restaurantStockItem: { findMany: async () => stockItems },
    restaurantUnit: {
      findMany: async () => [{ id: 'fixture-gap-unit-kg', name: 'Kilogram', abbreviation: 'kg' }],
    },
  },
});
export const gapNotificationChannels = ['IN_APP', 'WEBHOOK', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'];
export const gapNotificationsRouter = {
  createCaller: () => ({
    list: async () => ({ items: [], nextCursor: undefined }),
    unreadCount: async () => ({ count: 0 }),
    getMatrix: async () => ({
      channels: gapNotificationChannels.map((channel) => ({
        channel,
        enabled: channel === 'IN_APP',
      })),
    }),
    webhookStatus: async () => ({
      config: null,
      deadLetters: [],
      deliveries: [],
      deadLetterNextCursor: null,
    }),
  }),
};
export const gapPurchasingRouter = {
  createCaller: () => ({
    listSuppliers: async () => ({ suppliers: [supplier] }),
    listPurchaseOrders: async () => ({ orders: [order] }),
    getPurchaseOrder: async () => order,
  }),
};
const emptyReport = async () => null;
export const gapReportsRouter = {
  createCaller: () => ({
    branches: async () => ({ branches, canAllBranches: true }),
    stockLocations: async () => locations,
    overview: emptyReport,
    payments: emptyReport,
    financialComparison: emptyReport,
    foodCost: emptyReport,
    dishProfitability: emptyReport,
    catering: emptyReport,
    inventory: emptyReport,
    wastage: emptyReport,
    stockMovements: emptyReport,
    purchasing: emptyReport,
    workforceFinancial: emptyReport,
    workforce: emptyReport,
    sop: emptyReport,
  }),
};
export const gapValidateReportRange = () => undefined;
export const gapComparisonWindows = () => undefined;
export const gapCsvCell = () => {
  throw new Error('No export is performed by this isolated fixture.');
};

/** Resolve async server children (including the real Reports suspense child) before mounting. */
async function resolvePresentation(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolvePresentation));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    const component = node.type as (props: unknown) => Promise<ReactNode>;
    return resolvePresentation(await component(node.props));
  }
  if (node.props.children !== undefined) {
    const children = await resolvePresentation(node.props.children);
    // JSX's static sibling arguments stay static after the async child is resolved.
    return Array.isArray(children)
      ? cloneElement(node, {}, ...children)
      : cloneElement(node, {}, children);
  }
  return node;
}
const renderers = {
  notifications: () => NotificationsPage({ searchParams: Promise.resolve({}) }),
  purchasing: () => PurchasingPage({ searchParams: Promise.resolve({}) }),
  reports: () =>
    ReportsPage({
      searchParams: Promise.resolve({
        branch: undefined,
        stockLocation: undefined,
        from: undefined,
        to: undefined,
      }),
    }),
};
function LocalRestaurantPage({ page }: { page: keyof typeof renderers }) {
  const [content, setContent] = useState<ReactNode>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve(renderers[page]())
      .then(resolvePresentation)
      .then((result) => {
        if (active) setContent(result);
      });
    return () => {
      active = false;
    };
  }, [page]);
  return content;
}

const growth: GrowthView = {
  status: 'READY',
  insightId: 'fixture-insight',
  branchId: 'branch-a',
  hash: 'a'.repeat(64),
  version: 1,
  reviews: [],
  projection: {
    currency: 'PKR',
    current: { from: '2026-11-01T00:00:00.000Z', cutoff: '2026-11-08T00:00:00.000Z' },
    comparison: { from: '2026-10-25T00:00:00.000Z', cutoff: '2026-11-01T00:00:00.000Z' },
    recommendations: [
      {
        action: 'LOYALTY_REVIEW',
        evidence: [
          {
            key: 'loyalty_eligible_count',
            period: 'CURRENT',
            value: '12',
            unit: 'COUNT',
            coverage: 'PARTIAL',
          },
        ],
      },
    ],
  },
};
export const gapRestaurantQueryData: Record<string, unknown> = {
  'restaurantSop.listTemplates': [
    {
      id: 'fixture-template',
      name: 'Example opening procedure',
      category: 'Opening',
      description: 'Prepare the branch before service.',
      isActive: true,
      versions: [{ id: 'fixture-sop-version', versionNumber: 1, status: 'PUBLISHED' }],
    },
  ],
  'restaurantSop.listAssignments': [],
  'restaurantSop.listAssignableJobRoles': [
    { id: 'fixture-role-a', name: 'Shift lead' },
    { id: 'fixture-role-b', name: 'Kitchen lead' },
  ],
  'restaurantSop.getVersion': {
    id: 'fixture-sop-version',
    versionNumber: 1,
    status: 'PUBLISHED',
    steps: [],
  },
  'restaurantSop.previewSchedule': null,
  'restaurantTax.configuration': {
    branches,
    profiles: PAKISTAN_TAX_PROFILE_CATALOG,
    activeProfiles: [],
  },
  'restaurantTax.previewCustom': { net: '1000.00', tax: '0.00', gross: '1000.00' },
  'restaurantDevices.listPrinters': [],
};
export const gapRestaurantFetchResponses: Record<string, unknown> = {
  '/api/restaurant/print-bridge': {
    branches: branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      kitchenStations: [
        { id: 'fixture-station-hot', name: 'Hot kitchen' },
        { id: 'fixture-station-cold', name: 'Cold kitchen' },
      ],
      config: {
        branchId: branch.id,
        routes: ['KITCHEN_TICKET', 'BAR_TICKET', 'RECEIPT'].map((documentType) => ({
          documentType,
          stationId: null,
          printerId: 'example-printer',
          enabled: false,
        })),
      },
    })),
  },
};
export const gapRestaurantScreens: Record<string, ReactNode> = {
  'restaurant-notifications': <LocalRestaurantPage page="notifications" />,
  'restaurant-purchasing': <LocalRestaurantPage page="purchasing" />,
  'restaurant-reports': <LocalRestaurantPage page="reports" />,
  'restaurant-procedures': (
    <EntitlementsProvider
      value={{
        organizationId: 'fixture-org',
        vertical: 'RESTAURANT',
        modules: [],
        enabledModules: ['restaurant-sop'],
        limits: { 'sop.templates.max': 10 },
        seatLimit: 100,
        activeSeats: 2,
      }}
    >
      <RestaurantSopAdminPage />
    </EntitlementsProvider>
  ),
  'restaurant-growth': <GrowthReviewPanel view={growth} onReview={async () => growth} />,
  'restaurant-printing': (
    <>
      <PageHeader eyebrow="Restaurant settings" heading="Print routing" />
      <PrintRoutingSection />
    </>
  ),
  'restaurant-tax': <RestaurantTaxConsole />,
};
export const gapRestaurantSources = {
  'restaurant-notifications': ['src/app/(app)/restaurant/notifications/page.tsx'],
  'restaurant-purchasing': [
    'src/app/(app)/restaurant/purchasing/page.tsx',
    'src/app/(app)/restaurant/purchasing/receiving-form.tsx',
  ],
  'restaurant-reports': ['src/app/(app)/restaurant/reports/page.tsx'],
  'restaurant-procedures': ['src/app/(app)/restaurant/sop/admin/sop-admin.tsx'],
  'restaurant-growth': ['src/components/restaurant/growth/growth-review-panel.tsx'],
  'restaurant-printing': ['src/components/restaurant/print-routing-section.tsx'],
  'restaurant-tax': ['src/components/restaurant/restaurant-tax-console.tsx'],
};
