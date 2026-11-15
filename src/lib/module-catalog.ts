import {
  AGENCY_MODULES,
  HOSPITALITY_MODULES,
  PHARMACY_MODULES,
  RESTAURANT_MODULES,
  type OrganizationVertical,
} from '@/lib/vertical-catalog';

export type ModuleBand = 'BASELINE' | 'PLATFORM' | 'VERTICAL_CORE' | 'VERTICAL_OPTIONAL';

export type ModuleDefinition = {
  key: string;
  name: string;
  category: string;
  routePrefix: string;
  band: ModuleBand;
  vertical: OrganizationVertical | null;
  mandatory: boolean;
};

const sharedModules = [
  ['dashboard', 'Dashboard', 'Core', '/dashboard', 'BASELINE'],
  ['admin', 'Administration', 'Core', '/organization', 'BASELINE'],
  ['notifications', 'Notifications', 'Communication', '/notifications', 'BASELINE'],
  ['chat', 'Chat', 'Collaboration', '/chat', 'PLATFORM'],
  ['meetings', 'Meetings', 'Collaboration', '/meetings', 'PLATFORM'],
  ['notes', 'Notes', 'Knowledge', '/notes', 'PLATFORM'],
  ['email', 'Email', 'Communication', '/email', 'PLATFORM'],
  ['hr', 'HR', 'People', '/hr', 'PLATFORM'],
  ['reviews', 'Performance reviews', 'People', '/reviews', 'PLATFORM'],
  ['api', 'API access', 'Developer', '/organization/api', 'PLATFORM'],
  ['webhooks', 'Webhooks', 'Developer', '/organization/webhooks', 'PLATFORM'],
  ['audit', 'Audit logs', 'Security', '/audit-logs', 'PLATFORM'],
  ['branding', 'White-label branding', 'Configuration', '/organization/branding', 'PLATFORM'],
  ['domains', 'Custom domains', 'Configuration', '/organization/domains', 'PLATFORM'],
  ['identity', 'Enterprise SSO', 'Security', '/organization/authentication', 'PLATFORM'],
  ['scim', 'SCIM provisioning', 'Security', '/organization/provisioning', 'PLATFORM'],
  ['data', 'Data controls', 'Governance', '/organization/data', 'PLATFORM'],
  ['pharmacy-core', 'Pharmacy Core', 'Pharmacy', '/pharmacy', 'PLATFORM'],
  ['pharmacy-dispensing', 'Pharmacy Dispensing', 'Pharmacy', '/pharmacy/prescriptions', 'PLATFORM'],
] as const;

/** The single registry used by catalog sync, entitlement resolution, and UI compatibility. */
export const MODULE_CATALOG: readonly ModuleDefinition[] = [
  ...sharedModules.map(([key, name, category, routePrefix, band]) => ({
    key,
    name,
    category,
    routePrefix,
    band,
    vertical: null,
    mandatory: band === 'BASELINE',
  })),
  ...AGENCY_MODULES.map((module) => ({
    ...module,
    band: module.mandatory ? ('VERTICAL_CORE' as const) : ('VERTICAL_OPTIONAL' as const),
  })),
  ...RESTAURANT_MODULES.map((module) => ({
    ...module,
    band: module.mandatory ? ('VERTICAL_CORE' as const) : ('VERTICAL_OPTIONAL' as const),
  })),
  ...PHARMACY_MODULES.map((module) => ({
    ...module,
    band: module.mandatory ? ('VERTICAL_CORE' as const) : ('VERTICAL_OPTIONAL' as const),
  })),
  ...HOSPITALITY_MODULES.map((module) => ({
    ...module,
    band: module.mandatory ? ('VERTICAL_CORE' as const) : ('VERTICAL_OPTIONAL' as const),
  })),
];

const MODULES_BY_KEY = new Map(MODULE_CATALOG.map((module) => [module.key, module]));

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
    source: 'BASELINE' | 'PACKAGE' | 'CONTRACT' | 'OVERRIDE' | 'NONE';
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
export function verticalForModuleKey(key: string): OrganizationVertical | null {
  return MODULES_BY_KEY.get(key)?.vertical ?? null;
}

export function moduleDefinitionForKey(key: string): ModuleDefinition | undefined {
  return MODULES_BY_KEY.get(key);
}

/**
 * Receipt layouts and KOT/KDS/receipt routing belong only to the vertical that
 * owns Restaurant Core. A module grant cannot admit another vertical, and a
 * missing tenant vertical must fail closed. Role and procedure checks remain
 * separate requirements at their existing enforcement points.
 */
export function supportsRestaurantPrintSettings(
  vertical: string | null | undefined
): boolean {
  return vertical != null && vertical === verticalForModuleKey('restaurant-core');
}

/**
 * Is a module key granted to an organization holding `enabledModules`?
 *
 * BASELINE modules (dashboard, admin, notifications) are always on for every
 * organization in every vertical — the catalog marks them `mandatory` and
 * `resolveOrganizationEntitlements` reports them with source `BASELINE`, never
 * from a package, contract or override. Consumers therefore ask this rather
 * than testing `enabledModules.includes(...)` directly, so an always-on module
 * cannot be hidden by a caller that passes only the commercially granted keys.
 * Every other band (PLATFORM and VERTICAL_*) is granted only by the resolved
 * entitlement list, so this stays fail-closed for everything that is sold.
 */
export function isModuleGranted(moduleKey: string, enabledModules: readonly string[]): boolean {
  return MODULES_BY_KEY.get(moduleKey)?.band === 'BASELINE' || enabledModules.includes(moduleKey);
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
  restaurantBranches: 'restaurant-core', // WHA-908 tenant branch administration
  // Scheduling and terminal eligibility are foundational Restaurant Core. Optional
  // attendance, breaks, swaps and exports fail closed inside their procedures.
  restaurantShifts: 'restaurant-core',
  // M2-L3: back-office terminal-device administration. Device trust and terminal
  // sessions are foundational to running any restaurant terminal, so they gate on
  // the mandatory Restaurant Core module (BUILD-ASSUMPTIONS), not an optional add-on.
  restaurantDevices: 'restaurant-core',
  restaurantCatalog: 'restaurant-menu', // M3-L2 canonical catalog + costing substrate
  // R-lane (WHA-194): OCR menu import produces catalog rows, a draft menu and
  // draft prices, so it gates on the same "Menu and Costing" module the catalog
  // and menu surfaces do rather than introducing a module of its own.
  restaurantMenuImport: 'restaurant-menu',
  // M3-L3: menus, price lists and branch-menu publications gate on the optional
  // "Menu and Costing" module (`restaurant-menu`) — the module whose licensed
  // purpose is exactly this surface (BUILD-ASSUMPTIONS).
  restaurantMenus: 'restaurant-menu',
  restaurantPromotions: 'restaurant-menu',
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
  restaurantTax: 'restaurant-pos',
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
  restaurantDelivery: 'restaurant-core',
  restaurantLoyalty: 'restaurant-loyalty',
  restaurantInsights: 'restaurant-insights',
  restaurantDashboard: 'restaurant-core',
  // Essentials reports consume each licensed source independently; the route itself
  // belongs to mandatory Restaurant Core, not separately licensed Insights.
  restaurantReports: 'restaurant-core',
  restaurantGrowth: 'restaurant-core',
  pharmacyMedicine: 'pharmacy-core',
  // PLAT-02/03: the onboarding checklist, branch regulatory profile and
  // activation status are the pharmacy workspace's own front door — mandatory
  // Pharmacy Core, not a separately licensed console.
  pharmacyOnboarding: 'pharmacy-core',
  // PH-PUR (PUR-01..05): suppliers, requisitions, quotes, purchase orders and
  // goods receiving are licensed as Pharmacy Procurement, separately from the
  // mandatory medicine identity in Core — the registry key is
  // `pharmacy-procurement` (vertical-catalog), not `pharmacy-core`.
  pharmacyPurchasing: 'pharmacy-procurement',
  // DEV-752: pack-photo batch/expiry suggestions on the receiving bench.
  pharmacyPackLabel: 'pharmacy-procurement',
  // PH-INV (INV-01..04): the batch/lot stock ledger is licensed as Pharmacy
  // Inventory, separately from the mandatory medicine identity in Core.
  pharmacyInventory: 'pharmacy-inventory',
  pharmacyOwnerImport: 'pharmacy-inventory',
  pharmacyPrescriptions: 'pharmacy-dispensing',
  pharmacyDispensing: 'pharmacy-dispensing',
  pharmacySafety: 'pharmacy-safety',
  // DEV-751: pharmacy procedures run on the shared SOP engine but are licensed
  // as Pharmacy Safety. Never `restaurant-sop`: a restaurant licence must not
  // open the pharmacy SOP surface, and a pharmacy package does not sell it.
  pharmacySop: 'pharmacy-safety',
  pharmacySales: 'pharmacy-counter',
  pharmacyBranchAssignments: 'pharmacy-core',
  // #979: the rail's capability read belongs to every pharmacy workspace.
  pharmacyAccess: 'pharmacy-core',
  pharmacyCameras: 'pharmacy-core',
  pharmacyMarketing: 'pharmacy-crm',
  pharmacyFinance: 'pharmacy-finance',
  // CEO-JVCORE-20261025: manual journal vouchers are Pharmacy Finance bookkeeping.
  pharmacyGeneralJournal: 'pharmacy-finance',
  pharmacyOffline: 'pharmacy-counter',
  pharmacyOrdering: 'pharmacy-counter',
  // DEV-753: the owner switch for supplier compliance checks belongs to the
  // purchasing lane it governs.
  pharmacySupplierCompliance: 'pharmacy-procurement',
  hotelProperty: 'hotel-core',
  // H1-07 (MEAL-01): the meal plans a property sells are commercial
  // configuration every hospitality tenant holds, so they gate on the mandatory
  // Hotel Core module; the per-procedure capability is `hotel:rates`.
  hotelRates: 'hotel-core',
};

/**
 * Shared-shell notification access belongs to the authenticated tenant session,
 * not to HR. Exact full-path allowlist; the rest of the `team` namespace still
 * resolves to the HR module (WHA-305). Keep this private so other modules cannot
 * mutate the authorization allowlist at runtime.
 */
const ENTITLEMENT_INDEPENDENT_TEAM_NOTIFICATION_PROCEDURES: ReadonlySet<string> = new Set([
  'team.getNotifications',
  'team.markNotificationRead',
  'team.markAllNotificationsRead',
]);

/**
 * Procedures that act only on the caller's own account: profile, password,
 * sessions and notification preferences, i.e. everything the Settings page
 * offers every signed-in member. The account is part of every workspace in
 * every vertical (the `/settings` route is not licensed), so these are never
 * gated on a module even though they live in the `team` namespace that the
 * `hr` module otherwise licenses. `team.getById` is listed because the
 * Settings profile card reads the caller through it; its resolver re-applies
 * the `hr` licence for any member other than the caller.
 */
export const ACCOUNT_PROCEDURES: ReadonlySet<string> = new Set([
  'team.getById',
  'team.updateProfile',
  'team.changePassword',
  'team.signOutEverywhere',
  'team.mySignIns',
  'team.getNotificationPrefs',
  'team.updateNotificationPrefs',
]);

const PROCEDURE_MODULE_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  'pharmacyPrescriptions.counterPatients': ['pharmacy-dispensing'],
  'pharmacyPrescriptions.counterPatientPanel': ['pharmacy-dispensing'],
};

export function alternativeModulesForProcedure(path: string): readonly string[] {
  return Object.hasOwn(PROCEDURE_MODULE_ALTERNATIVES, path)
    ? PROCEDURE_MODULE_ALTERNATIVES[path]
    : [];
}

export function moduleForProcedure(path: string): string | null {
  // Inviting workspace users is baseline administration in every vertical.
  if (path === 'team.inviteMember') return 'admin';
  if (
    ACCOUNT_PROCEDURES.has(path) ||
    ENTITLEMENT_INDEPENDENT_TEAM_NOTIFICATION_PROCEDURES.has(path)
  ) {
    return null;
  }
  if (Object.hasOwn(PROCEDURE_MODULE_ALTERNATIVES, path)) return 'pharmacy-counter';
  if (
    /^pharmacyFinance\.(perpetualValuation|grossMargin|leakageReport|marginComparison|financialStatements)$/.test(
      path
    )
  ) {
    return 'pharmacy-reports';
  }
  const namespace = path.split('.')[0] ?? '';
  return Object.hasOwn(PROCEDURE_MODULES, namespace) ? PROCEDURE_MODULES[namespace] : null;
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
  ['/hotel/settings', 'hotel-core'],
  // R-lane (WHA-210): the OCR menu-import review console. Listed before the
  // restaurant core catch-all because `moduleForPath` takes the first prefix match.
  ['/restaurant/menu-import', 'restaurant-menu'],
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
  ['/restaurant/delivery', 'restaurant-core'],
  ['/restaurant/catering', 'restaurant-core'],
  ['/restaurant/orders', 'restaurant-pos'],
  ['/restaurant/money', 'restaurant-pos'],
  ['/restaurant/tax', 'restaurant-pos'],
  ['/restaurant/inventory', 'restaurant-inventory'],
  ['/restaurant/purchasing', 'restaurant-purchasing'],
  // `/restaurant/sop/admin` shares the SOP module; the extra admin/capability
  // check on that surface is authorization, not entitlement.
  ['/restaurant/sop', 'restaurant-sop'],
  ['/restaurant/loyalty', 'restaurant-loyalty'],
  ['/restaurant/insights', 'restaurant-insights'],
  ['/restaurant/reports', 'restaurant-core'],
  ['/restaurant/growth', 'restaurant-core'],
  ['/restaurant/catalog', 'restaurant-menu'],
  ['/restaurant/menus', 'restaurant-menu'],
  ['/restaurant/promotions', 'restaurant-menu'],
  // Core-owned back-office surfaces, then the `/restaurant` core catch-all —
  // the vertical catalog owns the `/restaurant` route prefix via
  // `restaurant-core` (mandatory for every restaurant organization).
  // PH-PUR (WHA-1196): the purchasing and receiving consoles. Same key as the
  // `pharmacyPurchasing` procedure map above, so hiding the surface and
  // rejecting the direct route can never disagree with rejecting the call. No
  // `/pharmacy` catch-all is listed: the other pharmacy surfaces are licensed
  // separately and a catch-all would gate them all on `pharmacy-core`.
  ['/pharmacy/purchasing', 'pharmacy-procurement'],
  ['/pharmacy/inventory', 'pharmacy-inventory'],
  ['/pharmacy/accounts/balance-sheet', 'pharmacy-reports'],
  ['/pharmacy/accounts/general-journal', 'pharmacy-finance'],
  ['/pharmacy/finance', 'pharmacy-finance'],
  ['/pharmacy/reports', 'pharmacy-reports'],
  ['/pharmacy/medicines', 'pharmacy-core'],
  ['/pharmacy/settings/branches', 'pharmacy-core'],
  ['/pharmacy/marketing', 'pharmacy-crm'],
  ['/pharmacy/loyalty', 'pharmacy-crm'],
  ['/pharmacy/khata', 'pharmacy-counter'],
  ['/pharmacy/cameras', 'pharmacy-core'],
  ['/pharmacy/sop', 'pharmacy-safety'],
  ['/pharmacy/orders', 'pharmacy-counter'],
  ['/restaurant/staff/roster', 'restaurant-core'],
  ['/restaurant/staff', 'restaurant-core'],
  ['/restaurant/devices', 'restaurant-core'],
  ['/restaurant/notifications', 'restaurant-core'],
  ['/restaurant', 'restaurant-core'],
];

/** Resolve the module that owns a route. Dashboard is a baseline module for every vertical. */
export function moduleForPath(pathname: string, _vertical?: OrganizationVertical): string | null {
  // Invitations are baseline administration; member detail and HR remain licensed.
  if (pathname === '/team') return moduleForProcedure('team.inviteMember');
  void _vertical; // Retained for source compatibility; baseline dashboard no longer dispatches.
  const moduleKey =
    ROUTE_MODULES.find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )?.[1] ?? null;
  return moduleKey;
}

// ---------------------------------------------------------------------------
// WHA-264 — entitlement requirements (module + limit catalog driven)
// ---------------------------------------------------------------------------

/**
 * A declarative entitlement requirement, expressed ONLY in terms of the
 * server-owned catalogs: commercial module keys (`vertical-catalog`
 * `RESTAURANT_MODULES`) and limit keys (`RESTAURANT_LIMIT_KEYS`).
 *
 * A requirement never names a commercial package. Packages are one of several
 * ways an organization acquires modules and limits (a contract or an override
 * grants the same shapes, see `resolveOrganizationEntitlements`), so gating on a
 * package key would deny an organization that legitimately holds the underlying
 * entitlement and would break the moment the package matrix is repriced.
 */
export type EntitlementRequirement = {
  /** Every listed module key must be ENABLED on the organization. */
  modules: readonly string[];
  /**
   * Every listed limit key must be granted with at least `atLeast`. A limit key
   * the organization was never granted counts as `0` — absence is denial, so a
   * requirement fails closed.
   */
  limits: ReadonlyArray<{ key: string; atLeast: number }>;
};

/** The subset of `EntitlementView` a requirement is evaluated against. */
export type EntitlementSnapshot = Pick<EntitlementView, 'enabledModules' | 'limits'>;

export type EntitlementRequirementResult = {
  allowed: boolean;
  /** Required module keys the organization does not have enabled. */
  missingModules: string[];
  /** Required limit keys granted below the requirement (absent counts as 0). */
  unmetLimits: Array<{ key: string; required: number; granted: number }>;
};

/**
 * Evaluate a requirement against an organization's resolved entitlements.
 * Pure and fail-closed: an unknown module key or an ungranted limit key denies.
 */
export function evaluateEntitlementRequirement(
  entitlements: EntitlementSnapshot,
  requirement: EntitlementRequirement
): EntitlementRequirementResult {
  const missingModules = requirement.modules.filter(
    (key) => !entitlements.enabledModules.includes(key)
  );
  const unmetLimits = requirement.limits
    .map((limit) => ({
      key: limit.key,
      required: limit.atLeast,
      granted: entitlements.limits[limit.key] ?? 0,
    }))
    .filter((limit) => limit.granted < limit.required);

  return {
    allowed: missingModules.length === 0 && unmetLimits.length === 0,
    missingModules,
    unmetLimits,
  };
}

// ---------------------------------------------------------------------------
// WHA-264 — SOP depth catalog
// ---------------------------------------------------------------------------

/**
 * The SOP feature depths the product sells. Every restaurant package includes
 * the `restaurant-sop` module, so module presence alone only separates "SOP at
 * all" from "no SOP" — the depth *within* the module is expressed by the limit
 * catalog, which is what the requirements below read.
 */
export type SopDepthCapability =
  | 'sop.execution'
  | 'sop.evidence'
  | 'sop.verification'
  | 'sop.waiver'
  | 'sop.escalation'
  | 'sop.crossBranchReporting'
  | 'sop.retentionExport';

/**
 * Evidence retention long enough to survive a full audit cycle. Manager
 * verification, rejection, co-authorized waiver and the sha256 proof trail are
 * only meaningful when the decision and the artifact it was made against are
 * still retained when an auditor arrives, so the whole proof family gates on
 * this one catalog limit rather than on a tier name.
 */
export const AUDIT_EVIDENCE_RETENTION_DAYS = 365;

/**
 * Multi-year statutory retention. Exporting an evidence archive and reporting
 * over historical periods are only offered where the contracted retention
 * window actually spans multiple years.
 */
export const STATUTORY_EVIDENCE_RETENTION_DAYS = 1_095;

/** Cross-BRANCH reporting is meaningless below two licensed branches. */
export const MULTI_BRANCH_MIN_LOCATIONS = 2;

/** Analytics retention that spans more than the operating year. */
export const MULTI_YEAR_ANALYTICS_RETENTION_MONTHS = 36;

/** At least one licensed external connection for escalation fan-out. */
export const MIN_INTEGRATION_CONNECTIONS = 1;

/**
 * The SOP depth → catalog requirement table. This table is the ONLY place that
 * decides how deep an organization's SOP surface goes; every consumer asks it
 * rather than branching on a package, a plan name or an organization id.
 */
export const SOP_DEPTH_REQUIREMENTS: Readonly<Record<SopDepthCapability, EntitlementRequirement>> =
  {
    /** Run an occurrence: start, complete steps, submit, read the branch board. */
    'sop.execution': {
      modules: ['restaurant-sop'],
      limits: [],
    },
    /** Attach sha256-addressed proof to an occurrence or one of its steps. */
    'sop.evidence': {
      modules: ['restaurant-sop'],
      limits: [{ key: 'sop.evidenceRetentionDays', atLeast: AUDIT_EVIDENCE_RETENTION_DAYS }],
    },
    /** Manager verify / reject of a submitted occurrence. */
    'sop.verification': {
      modules: ['restaurant-sop'],
      limits: [{ key: 'sop.evidenceRetentionDays', atLeast: AUDIT_EVIDENCE_RETENTION_DAYS }],
    },
    /** Co-authorized waiver — a second manager excuses an occurrence. */
    'sop.waiver': {
      modules: ['restaurant-sop'],
      limits: [{ key: 'sop.evidenceRetentionDays', atLeast: AUDIT_EVIDENCE_RETENTION_DAYS }],
    },
    /**
     * Escalation chains. Fan-out is delivered over the organization's licensed
     * external connections, so escalation gates on the Integrations module and on
     * having at least one connection in the limit catalog.
     */
    'sop.escalation': {
      modules: ['restaurant-sop', 'restaurant-integrations'],
      limits: [{ key: 'integrations.connections.max', atLeast: MIN_INTEGRATION_CONNECTIONS }],
    },
    /** Compliance reporting/analytics rolled up across branches. */
    'sop.crossBranchReporting': {
      modules: ['restaurant-sop', 'restaurant-insights'],
      limits: [
        { key: 'restaurant.locations.max', atLeast: MULTI_BRANCH_MIN_LOCATIONS },
        {
          key: 'restaurantInsights.retentionMonths',
          atLeast: MULTI_YEAR_ANALYTICS_RETENTION_MONTHS,
        },
      ],
    },
    /** Long-horizon retention and evidence-archive export. */
    'sop.retentionExport': {
      modules: ['restaurant-sop', 'restaurant-insights'],
      limits: [
        { key: 'sop.evidenceRetentionDays', atLeast: STATUTORY_EVIDENCE_RETENTION_DAYS },
        {
          key: 'restaurantInsights.retentionMonths',
          atLeast: MULTI_YEAR_ANALYTICS_RETENTION_MONTHS,
        },
      ],
    },
  };

/** Human label used in denial messages; never a package or plan name. */
const SOP_DEPTH_LABELS: Readonly<Record<SopDepthCapability, string>> = {
  'sop.execution': 'SOP execution',
  'sop.evidence': 'SOP evidence capture',
  'sop.verification': 'SOP manager verification',
  'sop.waiver': 'SOP co-authorized waiver',
  'sop.escalation': 'SOP escalation',
  'sop.crossBranchReporting': 'cross-branch SOP reporting',
  'sop.retentionExport': 'SOP retention and export',
};

export function evaluateSopDepth(
  entitlements: EntitlementSnapshot,
  capability: SopDepthCapability
): EntitlementRequirementResult {
  return evaluateEntitlementRequirement(entitlements, SOP_DEPTH_REQUIREMENTS[capability]);
}

export function hasSopDepth(
  entitlements: EntitlementSnapshot,
  capability: SopDepthCapability
): boolean {
  return evaluateSopDepth(entitlements, capability).allowed;
}

/**
 * Denial message for a failed SOP depth check. Reports the catalog keys the
 * organization is short of — no package name, and nothing about any other
 * tenant.
 */
export function sopDepthDenialMessage(
  capability: SopDepthCapability,
  result: EntitlementRequirementResult
): string {
  const reasons: string[] = [];
  if (result.missingModules.length > 0) {
    reasons.push(`requires the ${result.missingModules.join(', ')} module(s)`);
  }
  for (const limit of result.unmetLimits) {
    reasons.push(`requires ${limit.key} of at least ${limit.required} (granted ${limit.granted})`);
  }
  const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  return `${SOP_DEPTH_LABELS[capability]} is not included in this organization's entitlements${detail}.`;
}
