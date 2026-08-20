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

const PROCEDURE_MODULES: Record<string, string> = {
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
  // M6-L2: inventory operations console — stock on hand, movement ledger, physical
  // counts, transfers, wastage and low-stock rules — gate on the POS module
  // (`restaurant-pos`), the licensed surface that runs inventory and procurement.
  restaurantInventory: 'restaurant-pos',
  // M6-L3: purchasing & suppliers console — suppliers, purchase-order lifecycle,
  // goods receiving and supplier returns — gate on the POS module
  // (`restaurant-pos`), the licensed surface that runs procurement and inventory.
  restaurantPurchasing: 'restaurant-pos',
  // M7-L2: background-operations console — scheduler queue browse, job execution
  // history, dead-letter review + requeue, transactional-outbox status and webhook
  // inbox — gate on the SOP/automation module (`restaurant-sop`), the licensed
  // surface whose scheduler runtime this console observes.
  restaurantJobs: 'restaurant-sop',
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

const ROUTE_MODULES: Array<[string, string]> = [
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
];

export function moduleForPath(pathname: string): string | null {
  return (
    ROUTE_MODULES.find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )?.[1] ?? null
  );
}
