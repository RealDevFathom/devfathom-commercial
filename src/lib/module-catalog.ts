import { isRestaurantModuleKey, type OrganizationVertical } from '@/lib/vertical-catalog';

export type EntitlementView = {
  organizationId: string;
  /**
   * §2.3 — the organization's operating vertical, surfaced additively so
   * downstream consumers can branch on it via the L1 catalog instead of
   * re-deriving it. Optional to keep the shape strictly additive: every
   * pre-existing `EntitlementView` literal (including agency tests) stays valid,
   * while `resolveOrganizationEntitlements` always populates it.
   */
  vertical?: OrganizationVertical;
  seatLimit: number;
  activeSeats: number;
  enabledModules: string[];
  modules: Array<{
    key: string;
    name: string;
    enabled: boolean;
    source: 'PACKAGE' | 'CONTRACT' | 'OVERRIDE' | 'NONE';
    seatLimit: number | null;
    expiresAt: string | null;
  }>;
  limits: Record<string, number>;
};

/**
 * §2.3 / §6 — the vertical that owns a platform-module key. Restaurant module
 * keys are defined by the single server-owned vertical catalog; every other
 * catalog module belongs to the AGENCY platform registry. The enablement guard
 * consults this rather than branching on the vertical inline, so the key list
 * lives only in the catalog.
 */
export function verticalForModuleKey(key: string): OrganizationVertical {
  return isRestaurantModuleKey(key) ? 'RESTAURANT' : 'AGENCY';
}

export const PROCEDURE_MODULES: Record<string, string> = {
  dashboard: 'dashboard',
  projects: 'projects',
  trelloImport: 'projects',
  finance: 'finance',
  clients: 'clients',
  chat: 'chat',
  team: 'hr',
  teamStats: 'hr',
  resignations: 'hr',
  reviews: 'reviews',
  meetings: 'meetings',
  apiTokens: 'api',
  notes: 'notes',
  audit: 'audit',
  email: 'email',
  webhooks: 'webhooks',
  restaurantStaff: 'restaurant-core', // M2-L2 back-office staff & operator-credential surface
  // M2-L3: back-office terminal-device administration. Device trust and terminal
  // sessions are foundational to running any restaurant terminal, so they gate on
  // the mandatory Restaurant Core module (BUILD-ASSUMPTIONS), not an optional add-on.
  restaurantDevices: 'restaurant-core',
  restaurantCatalog: 'restaurant-menu', // M3-L2 canonical catalog + costing substrate
  // M3-L3: menus, price lists and branch-menu publications gate on the optional
  // "Menu and Costing" module (`restaurant-menu`) — the module whose licensed
  // purpose is exactly this surface (BUILD-ASSUMPTIONS).
  restaurantMenus: 'restaurant-menu',
  // M4-L3: floors, tables, server sections and kitchen stations gate on the POS
  // module (`restaurant-pos`) — the module whose licensed purpose is running the
  // service floor and kitchen (BUILD-ASSUMPTIONS).
  restaurantFloor: 'restaurant-pos',
  // M4-L2: orders, kitchen tickets and the back-office order read model gate on the
  // POS module (`restaurant-pos`) — the module whose licensed purpose is running
  // service orders and the kitchen (BUILD-ASSUMPTIONS).
  restaurantOrders: 'restaurant-pos',
  // M5-L2: back-office bill reads — splits/comps/receipts and per-order settlement
  // state — gate on the POS module (`restaurant-pos`), the licensed surface that
  // runs settlement.
  restaurantBills: 'restaurant-pos',
  // M5-L3: back-office cash reads — drawer sessions/movement ledgers and daily
  // closes/correction chains — gate on the POS module (`restaurant-pos`), the same
  // licensed surface that runs settlement and cash accountability.
  restaurantCash: 'restaurant-pos',
  // M5-L4: back-office payments reads — tenders, refunds and the payment event
  // trail — gate on the POS module (`restaurant-pos`), the licensed surface that
  // runs checkout and settlement.
  restaurantPayments: 'restaurant-pos',
  // WHA-138 Lane A: inventory operations — stock on hand, movement ledger,
  // physical counts, transfers, wastage and low-stock rules — gate on the
  // vertical catalog's own Inventory module (`restaurant-inventory`), not on
  // POS: a purchasing-only or back-office tenant runs inventory without ever
  // licensing the register.
  restaurantInventory: 'restaurant-inventory',
  // WHA-138 Lane A: purchasing & suppliers — suppliers, purchase-order
  // lifecycle, goods receiving and supplier returns — gate on the catalog's
  // Purchasing module (`restaurant-purchasing`), the key the packages actually
  // sell for this surface.
  restaurantPurchasing: 'restaurant-purchasing',
  // M7-L2: background-operations console — scheduler queue browse, job execution
  // history, dead-letter review + requeue, transactional-outbox status and webhook
  // inbox — gate on the SOP/automation module (`restaurant-sop`), the licensed
  // surface whose scheduler runtime this console observes.
  restaurantJobs: 'restaurant-sop',
  // M7-L3: SOP authoring console — templates, versions, steps, branch assignments
  // and schedule preview — gate on the SOP & Compliance module (`restaurant-sop`),
  // whose licensed purpose is exactly this surface (vertical-catalog).
  restaurantSop: 'restaurant-sop',
  // M7-L4: SOP execution console — branch board, lifecycle commands, evidence,
  // verification (verify/reject/waive), escalation acknowledgement.
  restaurantSopExecution: 'restaurant-sop',
  restaurantNotifications: 'restaurant-core',
  restaurantCustomers: 'restaurant-loyalty',
  restaurantLoyalty: 'restaurant-loyalty',
  restaurantInsights: 'restaurant-insights',
};

export function moduleForProcedure(path: string): string | null {
  return PROCEDURE_MODULES[path.split('.')[0] ?? ''] ?? null;
}

export function moduleForApiScope(scope: string): string | null {
  const domain = scope.split(':')[0];
  if (domain === 'tasks' || domain === 'projects') return 'projects';
  if (domain === 'team') return 'hr';
  return (
    {
      clients: 'clients',
      finance: 'finance',
      meetings: 'meetings',
    }[domain] ?? null
  );
}

/**
 * WHA-138 Lane A / plan §3 — the central route → module catalog. Order matters:
 * `moduleForPath` returns the FIRST entry whose prefix matches, so a specific
 * restaurant surface (`/restaurant/inventory`) must precede the `/restaurant`
 * core catch-all. Exported so navigation derives module ownership from this
 * catalog instead of repeating module strings in the sidebar.
 */
export const ROUTE_MODULES: ReadonlyArray<readonly [string, string]> = [
  ['/projects', 'projects'],
  ['/clients', 'clients'],
  ['/notes', 'notes'],
  ['/meetings', 'meetings'],
  ['/chat', 'chat'],
  ['/finance', 'finance'],
  ['/team/stats', 'hr'],
  ['/team', 'hr'],
  ['/reviews', 'reviews'],
  ['/hr', 'hr'],
  ['/audit-logs', 'audit'],
  ['/email', 'email'],
  ['/dashboard', 'dashboard'],
  // Restaurant terminal surfaces (device-authenticated pages outside the tenant
  // AppShell; the same module also gates their REST transport in terminal-auth).
  ['/pos', 'restaurant-pos'],
  ['/kds', 'restaurant-pos'],
  // Restaurant back-office consoles — §3 route table. Same keys as the tRPC
  // procedure map above so hiding a nav entry and rejecting the direct route
  // can never disagree.
  ['/restaurant/floor', 'restaurant-pos'],
  ['/restaurant/orders', 'restaurant-pos'],
  ['/restaurant/money', 'restaurant-pos'],
  ['/restaurant/inventory', 'restaurant-inventory'],
  ['/restaurant/purchasing', 'restaurant-purchasing'],
  // `/restaurant/sop/admin` shares the SOP module; the extra admin/capability
  // check on that surface is authorization, not entitlement.
  ['/restaurant/sop', 'restaurant-sop'],
  ['/restaurant/loyalty', 'restaurant-loyalty'],
  ['/restaurant/insights', 'restaurant-insights'],
  ['/restaurant/catalog', 'restaurant-menu'],
  ['/restaurant/menus', 'restaurant-menu'],
  // Core-owned back-office surfaces, then the `/restaurant` core catch-all —
  // the vertical catalog owns the `/restaurant` route prefix via
  // `restaurant-core` (mandatory for every restaurant organization).
  ['/restaurant/staff', 'restaurant-core'],
  ['/restaurant/devices', 'restaurant-core'],
  ['/restaurant/notifications', 'restaurant-core'],
  ['/restaurant', 'restaurant-core'],
];

/**
 * Resolve the module that owns a route. §3 — the Dashboard surface is
 * vertical-dispatched: for a RESTAURANT organization `/dashboard` belongs to
 * mandatory `restaurant-core` (restaurant packages never include the Agency
 * `dashboard` module, which would strand the default login destination on a
 * disabled-module screen). Callers that cannot supply a vertical keep the
 * legacy Agency behavior.
 */
export function moduleForPath(pathname: string, vertical?: OrganizationVertical): string | null {
  const moduleKey =
    ROUTE_MODULES.find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )?.[1] ?? null;
  if (moduleKey === 'dashboard' && vertical === 'RESTAURANT') return 'restaurant-core';
  return moduleKey;
}
