import type { OrganizationVertical } from '@/generated/prisma/enums';

/**
 * §2.3 — THE single server-owned vertical catalog.
 *
 * This module is the one place that knows which packages, modules, roles, and
 * limits belong to which organization vertical. Package assignment, module
 * enablement, route/procedure/API access, navigation, and production bootstrap
 * must consult these definitions and helpers rather than scattering
 * `AGENCY`/`RESTAURANT` conditionals across individual screens and commands.
 * No downstream consumer redefines this data.
 *
 * Restaurant names, categories, capability sets, package contents, and limit
 * values are the conservative provisional defaults recorded while D10 (package/
 * limit matrix) and the Phase 0 decisions remain OPEN. They are stable enough to
 * build against and are revised only here.
 *
 * Both verticals declare their owned core/optional modules here. Shared baseline
 * and platform modules are composed with them by `module-catalog.ts`.
 */

export type { OrganizationVertical };

export const AGENCY: OrganizationVertical = 'AGENCY';
export const RESTAURANT: OrganizationVertical = 'RESTAURANT';
export const PHARMACY: OrganizationVertical = 'PHARMACY';
export const HOSPITALITY: OrganizationVertical = 'HOSPITALITY';

// ---------------------------------------------------------------------------
// §2 / §2.1 — Vertical definitions
// ---------------------------------------------------------------------------

export type VerticalDefinition = {
  vertical: OrganizationVertical;
  /** UI label shown for the "Organization type" decision (§2). */
  label: string;
  description: string;
  firstRunChecklist: readonly FirstRunChecklistDefinition[];
};

export type FirstRunEvidenceKey =
  | 'hasBranch'
  | 'hasProvisionedRoles'
  | 'hasStationOrPrinter'
  | 'hasCatalog'
  | 'hasOpeningStock'
  | 'hasTax'
  | 'hasFirstSale';

export type FirstRunChecklistDefinition = {
  key: 'branch' | 'staff' | 'stations' | 'catalog' | 'tax' | 'first-sale';
  label: string;
  evidence: readonly FirstRunEvidenceKey[];
  optional: boolean;
  doneWhy: string;
  pendingWhy: string;
  doneActionLabel: string;
  pendingActionLabel: string;
  href: string;
};

const RESTAURANT_FIRST_RUN_CHECKLIST = [
  {
    key: 'branch',
    label: 'Branch',
    evidence: ['hasBranch'],
    optional: false,
    doneWhy: 'An active location is ready for daily operations.',
    pendingWhy: 'Your first sale needs an active operating location.',
    doneActionLabel: 'Review branches',
    pendingActionLabel: 'Set up a branch',
    href: '/restaurant/settings/branches',
  },
  {
    key: 'staff',
    label: 'Staff and roles',
    evidence: ['hasProvisionedRoles'],
    optional: false,
    doneWhy: 'The required system roles were provisioned automatically.',
    pendingWhy: 'Provisioned roles keep staff access consistent and least-privileged.',
    doneActionLabel: 'Review staff',
    pendingActionLabel: 'Finish staff setup',
    href: '/restaurant/staff',
  },
  {
    key: 'stations',
    label: 'Stations and printers',
    evidence: ['hasStationOrPrinter'],
    optional: true,
    doneWhy: 'At least one active station, printer route, or counter device is configured.',
    pendingWhy: 'Optional for a test sale; add hardware when this location is ready.',
    doneActionLabel: 'Review devices',
    pendingActionLabel: 'Set up later',
    href: '/restaurant/devices',
  },
  {
    key: 'catalog',
    label: 'Published menu',
    evidence: ['hasCatalog'],
    optional: false,
    doneWhy: 'A published menu gives the register saleable items.',
    pendingWhy: 'Publish a priced menu before opening the register.',
    doneActionLabel: 'Review menus',
    pendingActionLabel: 'Set up a menu',
    href: '/restaurant/menus',
  },
  {
    key: 'tax',
    label: 'Tax',
    evidence: ['hasTax'],
    optional: false,
    doneWhy: 'An active tax profile is available for checkout.',
    pendingWhy: 'Publish the branch tax profile used at checkout.',
    doneActionLabel: 'Review tax',
    pendingActionLabel: 'Set up tax',
    href: '/restaurant/tax',
  },
  {
    key: 'first-sale',
    label: 'First test sale',
    evidence: ['hasFirstSale'],
    optional: false,
    doneWhy: 'A completed sale proves the core checkout path.',
    pendingWhy: 'Complete one test checkout to verify the workspace end to end.',
    doneActionLabel: 'Review sales',
    pendingActionLabel: 'Make a test sale',
    href: '/pos',
  },
] as const satisfies readonly FirstRunChecklistDefinition[];

const PHARMACY_FIRST_RUN_CHECKLIST = [
  {
    key: 'branch',
    label: 'Branch',
    evidence: ['hasBranch'],
    optional: false,
    doneWhy: 'An active location is ready for daily operations.',
    pendingWhy: 'Your first sale needs an active operating location.',
    doneActionLabel: 'Review branches',
    pendingActionLabel: 'Set up a branch',
    href: '/pharmacy/inventory',
  },
  {
    key: 'staff',
    label: 'Staff and roles',
    evidence: ['hasProvisionedRoles'],
    optional: false,
    doneWhy: 'The required system roles were provisioned automatically.',
    pendingWhy: 'Provisioned roles keep staff access consistent and least-privileged.',
    doneActionLabel: 'Review staff',
    pendingActionLabel: 'Finish staff setup',
    href: '/organization',
  },
  {
    key: 'stations',
    label: 'Counter device',
    evidence: ['hasStationOrPrinter'],
    optional: true,
    doneWhy: 'At least one active station, printer route, or counter device is configured.',
    pendingWhy: 'Optional for a test sale; add hardware when this location is ready.',
    doneActionLabel: 'Review devices',
    pendingActionLabel: 'Set up later',
    href: '/settings',
  },
  {
    key: 'catalog',
    label: 'Catalog and opening stock',
    evidence: ['hasCatalog', 'hasOpeningStock'],
    optional: false,
    doneWhy: 'A published medicine and received opening stock are ready to sell.',
    pendingWhy: 'Publish a medicine and receive opening stock before a test sale.',
    doneActionLabel: 'Review Pharmacy setup',
    pendingActionLabel: 'Set up medicines and stock',
    href: '/pharmacy',
  },
  {
    key: 'tax',
    label: 'Tax',
    evidence: ['hasTax'],
    optional: true,
    doneWhy: 'An active tax profile is available for checkout.',
    pendingWhy: 'Pharmacy tax setup is not yet required by the available counter flow.',
    doneActionLabel: 'Review tax',
    pendingActionLabel: 'Review organization',
    href: '/organization',
  },
  {
    key: 'first-sale',
    label: 'First test sale',
    evidence: ['hasFirstSale'],
    optional: false,
    doneWhy: 'A completed sale proves the core checkout path.',
    pendingWhy: 'Complete one test checkout to verify the workspace end to end.',
    doneActionLabel: 'Review sales',
    pendingActionLabel: 'Make a test sale',
    href: '/pharmacy/counter',
  },
] as const satisfies readonly FirstRunChecklistDefinition[];

export const FIRST_RUN_VERTICALS = [RESTAURANT, PHARMACY] as const;

export const VERTICALS: Record<OrganizationVertical, VerticalDefinition> = {
  AGENCY: {
    vertical: 'AGENCY',
    label: 'Agency',
    description: 'Projects, clients, agency finance, HR, and collaboration.',
    firstRunChecklist: [],
  },
  RESTAURANT: {
    vertical: 'RESTAURANT',
    label: 'Restaurant',
    description: 'Branches, POS, menu, inventory, SOP, loyalty, and insights.',
    firstRunChecklist: RESTAURANT_FIRST_RUN_CHECKLIST,
  },
  PHARMACY: {
    vertical: 'PHARMACY',
    label: 'Pharmacy',
    description: 'Counters, dispensing, inventory, procurement, safety, and reporting.',
    firstRunChecklist: PHARMACY_FIRST_RUN_CHECKLIST,
  },
  // H1-01 — the hospitality vertical's own first-run walk is the property
  // onboarding checklist (`src/lib/hotel/onboarding-checklist.ts`), which is
  // evaluated against hotel records rather than the shared restaurant/pharmacy
  // evidence keys. It is therefore deliberately absent from
  // `FIRST_RUN_VERTICALS` and carries an empty shared checklist here, so the
  // dashboard's first-run card never renders half-answered rows for a hotel.
  HOSPITALITY: {
    vertical: 'HOSPITALITY',
    label: 'Hospitality',
    description: 'Properties, reservations, front desk, folio, night audit, and reporting.',
    firstRunChecklist: [],
  },
};

export const ALL_VERTICALS: readonly OrganizationVertical[] = [
  'AGENCY',
  'RESTAURANT',
  'PHARMACY',
  'HOSPITALITY',
];

export type DepartmentDefinition = {
  key: string;
  name: string;
};

export const AGENCY_DEPARTMENTS: readonly DepartmentDefinition[] = [
  { key: 'LEADERSHIP', name: 'Leadership' },
  { key: 'ENGINEERING', name: 'Engineering' },
  { key: 'PRODUCT', name: 'Product' },
  { key: 'QUALITY', name: 'Quality' },
  { key: 'MARKETING', name: 'Marketing' },
  { key: 'DESIGN', name: 'Design' },
];

export const RESTAURANT_DEPARTMENTS: readonly DepartmentDefinition[] = [
  { key: 'KITCHEN', name: 'Kitchen' },
  { key: 'FRONT_OF_HOUSE', name: 'Front of House' },
];

export const PHARMACY_DEPARTMENTS: readonly DepartmentDefinition[] = [
  { key: 'COUNTER', name: 'Counter' },
  { key: 'DISPENSARY', name: 'Dispensary' },
  { key: 'STORE', name: 'Store' },
  { key: 'PROCUREMENT', name: 'Procurement' },
  { key: 'FINANCE', name: 'Finance' },
  { key: 'COMPLIANCE', name: 'Compliance' },
];

/** 06 §2 — the departments the hospitality role templates are filed under. */
export const HOSPITALITY_DEPARTMENTS: readonly DepartmentDefinition[] = [
  { key: 'FRONT_OFFICE', name: 'Front Office' },
  { key: 'HOUSEKEEPING', name: 'Housekeeping' },
  { key: 'MAINTENANCE', name: 'Maintenance' },
  { key: 'FOOD_AND_BEVERAGE', name: 'Food and Beverage' },
  { key: 'SALES_AND_EVENTS', name: 'Sales and Events' },
  { key: 'FINANCE', name: 'Finance' },
];

export function departmentsForVertical(
  vertical: OrganizationVertical
): readonly DepartmentDefinition[] {
  if (vertical === HOSPITALITY) return HOSPITALITY_DEPARTMENTS;
  if (vertical === PHARMACY) return PHARMACY_DEPARTMENTS;
  return vertical === RESTAURANT ? RESTAURANT_DEPARTMENTS : AGENCY_DEPARTMENTS;
}

/**
 * The rows a newly provisioned organization starts with. `User.department` is a
 * composite foreign key onto `organization_departments`, so an organization with
 * an empty catalog cannot hold a single user: provisioning must seed these
 * before it creates the administrator.
 */
export function defaultDepartmentRowsForVertical(
  vertical: OrganizationVertical
): { key: string; name: string; sortOrder: number }[] {
  return departmentsForVertical(vertical).map((department, index) => ({
    key: department.key,
    name: department.name,
    sortOrder: index,
  }));
}

/**
 * The department a newly provisioned organization administrator is filed under.
 * Declared per vertical rather than inferred from catalog ordering: an agency
 * administrator leads, while a restaurant administrator belongs front of house
 * rather than in the kitchen. Always a key present in `departmentsForVertical`.
 */
export function adminDepartmentKeyForVertical(vertical: OrganizationVertical): string {
  if (vertical === HOSPITALITY) return 'FRONT_OFFICE';
  if (vertical === PHARMACY) return 'COUNTER';
  return vertical === RESTAURANT ? 'FRONT_OF_HOUSE' : 'LEADERSHIP';
}

/**
 * The department a non-administrator provisioned from an identity provider
 * (SSO just-in-time, SCIM) is filed under when the directory asserts no
 * department of its own. The sibling of `adminDepartmentKeyForVertical`: an
 * agency's directory user defaults to Engineering, as the pre-WHA-278 hardcoded
 * pair asserted, while a restaurant's belongs front of house rather than in the
 * kitchen. Always a key present in `departmentsForVertical`.
 */
export function memberDepartmentKeyForVertical(vertical: OrganizationVertical): string {
  if (vertical === HOSPITALITY) return 'FRONT_OFFICE';
  if (vertical === PHARMACY) return 'COUNTER';
  return vertical === RESTAURANT ? 'FRONT_OF_HOUSE' : 'ENGINEERING';
}

// ---------------------------------------------------------------------------
// §6 — Vertical-owned commercial module maps
// ---------------------------------------------------------------------------

export type CommercialModule = {
  key: string;
  name: string;
  /** Provisional grouping for navigation/admin listing. */
  category: string;
  /** Route namespace this module owns. Consumers matching a path to a module
   * must prefer the longest matching prefix (`/restaurant/pos` before
   * `/restaurant`). */
  routePrefix: string;
  vertical: OrganizationVertical;
  /** §6.1 — Restaurant Core is mandatory for every restaurant organization. */
  mandatory: boolean;
};

export const AGENCY_MODULES: readonly CommercialModule[] = [
  {
    key: 'agency-core',
    name: 'Agency Core',
    category: 'Core',
    routePrefix: '/agency',
    vertical: 'AGENCY',
    mandatory: true,
  },
  {
    key: 'projects',
    name: 'Projects',
    category: 'Delivery',
    routePrefix: '/projects',
    vertical: 'AGENCY',
    mandatory: false,
  },
  {
    key: 'clients',
    name: 'Clients',
    category: 'Delivery',
    routePrefix: '/clients',
    vertical: 'AGENCY',
    mandatory: false,
  },
  {
    key: 'finance',
    name: 'Finance',
    category: 'Operations',
    routePrefix: '/finance',
    vertical: 'AGENCY',
    mandatory: false,
  },
];

export const RESTAURANT_MODULES: readonly CommercialModule[] = [
  {
    key: 'restaurant-core',
    name: 'Restaurant Core',
    category: 'Core',
    routePrefix: '/restaurant',
    vertical: 'RESTAURANT',
    mandatory: true,
  },
  {
    key: 'restaurant-pos',
    name: 'POS and Fulfilment',
    category: 'Operations',
    routePrefix: '/restaurant/pos',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-menu',
    name: 'Menu and Costing',
    category: 'Menu',
    routePrefix: '/restaurant/menu',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-inventory',
    name: 'Inventory',
    category: 'Inventory',
    routePrefix: '/restaurant/inventory',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-purchasing',
    name: 'Purchasing',
    category: 'Purchasing',
    routePrefix: '/restaurant/purchasing',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-workforce',
    name: 'Restaurant Workforce',
    category: 'People',
    routePrefix: '/restaurant/workforce',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-sop',
    name: 'SOP and Compliance',
    category: 'Compliance',
    routePrefix: '/restaurant/sop',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-loyalty',
    name: 'Customers and Loyalty',
    category: 'Loyalty',
    routePrefix: '/restaurant/loyalty',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-insights',
    name: 'Restaurant Insights',
    category: 'Insights',
    routePrefix: '/restaurant/insights',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
  {
    key: 'restaurant-integrations',
    name: 'Integrations and Devices',
    category: 'Integrations',
    routePrefix: '/restaurant/integrations',
    vertical: 'RESTAURANT',
    mandatory: false,
  },
];

export const PHARMACY_MODULES: readonly CommercialModule[] = [
  ['pharmacy-core', 'Pharmacy Core', 'Core', '/pharmacy'],
  ['pharmacy-counter', 'Pharmacy Counter', 'Operations', '/pharmacy/counter'],
  ['pharmacy-inventory', 'Pharmacy Inventory', 'Inventory', '/pharmacy/inventory'],
  ['pharmacy-procurement', 'Pharmacy Procurement', 'Procurement', '/pharmacy/procurement'],
  ['pharmacy-dispensing', 'Pharmacy Dispensing', 'Clinical', '/pharmacy/dispensing'],
  ['pharmacy-safety', 'Pharmacy Safety', 'Compliance', '/pharmacy/safety'],
  ['pharmacy-finance', 'Pharmacy Finance', 'Finance', '/pharmacy/finance'],
  ['pharmacy-reports', 'Pharmacy Reports', 'Reports', '/pharmacy/reports'],
  ['pharmacy-crm', 'Pharmacy CRM', 'Customers', '/pharmacy/crm'],
].map(([key, name, category, routePrefix], index) => ({
  key,
  name,
  category,
  routePrefix,
  vertical: 'PHARMACY' as const,
  mandatory: index === 0,
}));

/**
 * H1-01 / GTM-01 — the hospitality commercial modules the four packages are
 * composed from. Only `hotel-core` is mandatory: it owns the property registry,
 * the onboarding checklist and the settings surface, which every hospitality
 * organization needs whatever it sells.
 *
 * The keys are chosen so a package can be described exactly as PRD §5.23 words
 * it — Essentials names six operating surfaces, Pro adds six, Chain adds the
 * multi-property CRS, and Venue omits the room modules entirely.
 */
export const HOSPITALITY_MODULES: readonly CommercialModule[] = [
  ['hotel-core', 'Hotel Core', 'Core', '/hotel', true],
  ['hotel-reservations', 'Reservations', 'Operations', '/hotel/reservations', false],
  ['hotel-front-desk', 'Front Desk', 'Operations', '/hotel/front-desk', false],
  ['hotel-folio', 'Folio and Billing', 'Money', '/hotel/folio', false],
  ['hotel-payments', 'Payments', 'Money', '/hotel/payments', false],
  ['hotel-night-audit', 'Night Audit', 'Money', '/hotel/night-audit', false],
  ['hotel-reports', 'Hotel Reports', 'Reports', '/hotel/reports', false],
  ['hotel-channels', 'Channels and Booking Engine', 'Distribution', '/hotel/channels', false],
  ['hotel-upsell', 'Guest Journey and Upsell', 'Guest', '/hotel/upsell', false],
  ['hotel-marketing', 'Hotel Marketing', 'Customers', '/hotel/marketing', false],
  ['hotel-agents', 'Travel Agents', 'Distribution', '/hotel/agents', false],
  ['hotel-maintenance', 'Maintenance', 'Operations', '/hotel/maintenance', false],
  ['hotel-api', 'Partner API and GL', 'Developer', '/hotel/api', false],
  // Chain: cross-property availability and pickup (RPT-02 `central-reservations`).
  ['hotel-crs', 'Central Reservations', 'Chain', '/hotel/central-reservations', false],
  // Venue: banquets carries the catering seam (BQT-04) — the seam is part of this
  // module, not a module of its own, because it has no surface without an event.
  ['hotel-banquets', 'Banquets and Events', 'Events', '/hotel/banquets', false],
].map(([key, name, category, routePrefix, mandatory]) => ({
  key: key as string,
  name: name as string,
  category: category as string,
  routePrefix: routePrefix as string,
  vertical: 'HOSPITALITY' as const,
  mandatory: mandatory as boolean,
}));

// ---------------------------------------------------------------------------
// §7 — Limits and usage (keys + counting contracts)
// ---------------------------------------------------------------------------

export type LimitKeyDefinition = {
  key: string;
  /** The unit counted against this limit (the commercial counting contract). */
  countedUnit: string;
};

export const RESTAURANT_LIMIT_KEYS: readonly LimitKeyDefinition[] = [
  {
    key: 'restaurant.locations.max',
    countedUnit: 'Active restaurant branches inside the organization',
  },
  {
    key: 'restaurant.brands.max',
    countedUnit: 'Active restaurant/virtual brands; ordinary customers receive one default brand',
  },
  { key: 'pos.terminals.max', countedUnit: 'Registered devices allowed to act as POS registers' },
  {
    key: 'pos.registeredDevices.max',
    countedUnit: 'All active POS, KDS, printer-agent, and other trusted restaurant devices',
  },
  {
    key: 'pos.orders.monthly',
    countedUnit:
      'Orders created in the contract billing month, including later-cancelled orders unless the contract says otherwise',
  },
  { key: 'pos.concurrentRegisters.max', countedUnit: 'Simultaneously active register sessions' },
  {
    key: 'restaurant.operators.max',
    countedUnit:
      'Active staff profiles holding an operator credential; separate from global authenticated-user seats',
  },
  { key: 'inventory.stockLocations.max', countedUnit: 'Active branch stock locations' },
  {
    key: 'sop.templates.max',
    countedUnit:
      'Active SOP template families, not immutable historical versions; a high anti-abuse guardrail, not package-tier pricing',
  },
  {
    key: 'sop.evidenceRetentionDays',
    countedUnit: 'Minimum/contracted evidence-retention window, subject to legal requirements',
  },
  {
    key: 'loyalty.activeCustomers.max',
    countedUnit: 'Loyalty accounts active under the contract definition',
  },
  {
    key: 'integrations.connections.max',
    countedUnit: 'Active external provider/account connections, not individual webhook deliveries',
  },
  {
    key: 'restaurantInsights.retentionMonths',
    countedUnit:
      'Detailed restaurant-insight retention; statutory ledgers may require longer retention',
  },
];

/** Agency packages currently meter seats at organization level, not module limits. */
export const AGENCY_LIMIT_KEYS: readonly LimitKeyDefinition[] = [];

export const PHARMACY_LIMIT_KEYS: readonly LimitKeyDefinition[] = [
  { key: 'pharmacy.branches.max', countedUnit: 'Active pharmacy branches' },
  { key: 'pharmacy.counters.max', countedUnit: 'Active dispensing and sales counters' },
  { key: 'pharmacy.users.max', countedUnit: 'Active pharmacy users' },
];

/**
 * GTM-01 — hospitality limits. A property is a branch (PROP-04), so the branch
 * ceiling is what separates a single hotel from a chain; rooms and users meter
 * the size of each one.
 */
export const HOSPITALITY_LIMIT_KEYS: readonly LimitKeyDefinition[] = [
  {
    key: 'hotel.properties.max',
    countedUnit: 'Active properties (branches) inside the organization',
  },
  {
    key: 'hotel.rooms.max',
    countedUnit: 'Sellable units across every property: rooms, beds and apartments',
  },
  { key: 'hotel.users.max', countedUnit: 'Active hospitality users' },
];

export const RESTAURANT_LIMIT_KEY_NAMES: readonly string[] = RESTAURANT_LIMIT_KEYS.map(
  (limit) => limit.key
);

// ---------------------------------------------------------------------------
// §8 — Roles and capabilities (organization-role templates + namespaces)
// ---------------------------------------------------------------------------

/** Capability namespaces used by restaurant role templates (the prefix before
 * the `:` in a `namespace:action` capability). Server authorization stays the
 * source of truth; branch assignment further constrains these (§8). */
export const RESTAURANT_CAPABILITY_NAMESPACES: readonly string[] = [
  'restaurant',
  'branches',
  'pos',
  'orders',
  'catering',
  'payments',
  'cash',
  'money',
  'menu',
  'inventory',
  'purchasing',
  'sop',
  'customers',
  'loyalty',
  'reports',
  'workforce',
  // M2-L1 (additive): staff-operator, device, terminal and co-authorization
  // namespaces. Reconciled against the 14 M1 namespaces above — appended, never
  // renaming or removing an existing one.
  'staff',
  'devices',
  'terminal',
  'coauth',
  // M4-L1 (additive): the kitchen namespace for KDS/KOT operation. `orders:take`
  // reuses the existing `orders` namespace; only `kitchen` is new. Appended, no
  // rename or removal.
  'kitchen',
];

/** The example capability set from §8 (namespace:action), plus the restricted
 * `workforce:rates` from §6.6. Provisional until the Phase 0 capability matrix. */
export const RESTAURANT_CAPABILITIES: readonly string[] = [
  'restaurant:configure',
  'branches:read',
  'branches:manage',
  'pos:operate',
  'orders:read',
  'catering:read',
  'catering:manage',
  'orders:void',
  'orders:discount',
  'orders:complimentary',
  'payments:collect',
  'payments:refund',
  'cash:open',
  'cash:adjust',
  'cash:close',
  'money:read',
  'menu:read',
  'menu:write',
  'inventory:read',
  'inventory:count',
  'inventory:adjust',
  'inventory:waste',
  'purchasing:create',
  'purchasing:approve',
  'sop:complete',
  'sop:verify',
  'sop:manage',
  'customers:read',
  'customers:manage',
  'loyalty:redeem',
  'reports:operational',
  'reports:financial',
  'workforce:rates',
  // M2-L1 (additive): the staff/operator/device/terminal/co-authorization
  // capabilities the M2 surfaces enforce. Additive-only — no existing capability
  // is removed, renamed, or reassigned. Wiring them onto role templates is a
  // downstream decision (L2/L3); L1 only reconciles the capability keys here.
  'staff:manage',
  'devices:manage',
  'devices:revoke',
  'terminal:operate',
  'coauth:approve',
  // M3-L1 (additive, C7): the two menu capabilities the M3 surfaces enforce, on
  // the existing `menu` namespace. `menu:publish` gates branch-menu publications;
  // `menu:price` gates price lists and approved price overrides. Additive-only —
  // no existing capability is removed, renamed, or reassigned; the base
  // `menu:read`/`menu:write` are untouched.
  'menu:publish',
  'menu:price',
  // M4-L1 (additive): `orders:take` gates POS order taking on the existing
  // `orders` namespace; `kitchen:operate` gates KDS/kitchen-ticket operation on
  // the new `kitchen` namespace. Additive-only — no existing capability changes.
  'orders:take',
  'kitchen:operate',
  // R-lane (additive, WHA-194): `menu:import` gates OCR menu import on the
  // existing `menu` namespace. Kept distinct from `menu:write` because a single
  // import creates products, categories and draft prices in bulk from untrusted
  // OCR output. Additive-only — no existing capability changes.
  'menu:import',
];

export type RoleTemplate = {
  key: string;
  name: string;
  /** System role templates are created during onboarding (§9 Step 6). */
  isSystem: boolean;
  /** Capabilities granted by default. `['*']` = full administration, matching the
   * bootstrap admin role, except that wildcards (`*`, `pharmacy:*`) never grant
   * pharmacy:dispense, pharmacy:safety or pharmacy:catalogue-review: those must be
   * granted exactly (separation of duties). A wildcard DENY still revokes them.
   * All entries are provisional (Phase 0 / D10). */
  capabilities: readonly string[];
};

export const AGENCY_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'admin', name: 'Administrator', isSystem: true, capabilities: ['*'] },
  { key: 'member', name: 'Member', isSystem: true, capabilities: [] },
];

export const PHARMACY_CAPABILITIES: readonly string[] = [
  'pharmacy:*',
  'pharmacy:dispense',
  'pharmacy:catalogue-review',
  'pharmacy:manage',
  'pharmacy:counter',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'pharmacy:orders',
  'reports:operational',
  'reports:financial',
  'pharmacy:safety',
];

/** Canonical actions checked by pharmacy workflows, including shared report gates. */
export const PHARMACY_CHECKED_CAPABILITIES = [
  'pharmacy:counter',
  'pharmacy:manage',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'pharmacy:dispense',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
  'pharmacy:orders',
  'reports:operational',
  'reports:financial',
] as const;

export const PHARMACY_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    isSystem: true,
    capabilities: ['pharmacy:*', 'reports:operational', 'reports:financial'],
  },
  {
    // Optional, explicitly assigned proprietor role. Pair with tenant UserRole.ADMIN
    // for business/cashier guards that require literal ADMIN; EMPLOYEE plus this
    // template is not equivalent. Provisioning does not assign it to existing owners.
    // These grants neither verify clinical qualifications nor permit self-review/signing.
    key: 'owner-operator',
    name: 'Owner / Operator',
    isSystem: true,
    capabilities: [
      'reports:operational',
      'reports:financial',
      'pharmacy:orders',
      'pharmacy:dispense',
      'pharmacy:catalogue-review',
      'pharmacy:safety',
    ],
  },
  {
    key: 'pharmacist',
    name: 'Pharmacist',
    isSystem: true,
    capabilities: ['pharmacy:dispense', 'pharmacy:catalogue-review'],
  },
  {
    key: 'manager',
    name: 'Manager',
    isSystem: true,
    capabilities: ['pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement'],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    isSystem: true,
    capabilities: ['pharmacy:counter', 'pharmacy:orders'],
  },
  {
    key: 'procurement',
    name: 'Procurement',
    isSystem: true,
    capabilities: ['pharmacy:procurement'],
  },
  { key: 'inventory', name: 'Inventory', isSystem: true, capabilities: ['pharmacy:inventory'] },
  { key: 'finance', name: 'Finance', isSystem: true, capabilities: ['reports:financial'] },
  { key: 'auditor', name: 'Auditor', isSystem: true, capabilities: ['reports:operational'] },
];

/**
 * H1-01 — the nineteen hospitality capabilities of `06-roles-reports` §1, in the
 * pack's order. Every one is registered in the ABAC catalogue
 * (`src/lib/abac/policies.ts`) with an empty static policy, so it is default-deny
 * until an organization role grants it.
 */
export const HOSPITALITY_CAPABILITIES: readonly string[] = [
  'hotel:reservations',
  'hotel:front-desk',
  'hotel:folio',
  'hotel:folio-adjust',
  'hotel:payments',
  'hotel:refunds',
  'hotel:rates',
  'hotel:availability-override',
  'hotel:housekeeping',
  'hotel:night-audit',
  'hotel:guest-identity',
  'hotel:reports-financial',
  'hotel:channels',
  'hotel:property-admin',
  'hotel:marketing',
  'hotel:agents',
  'hotel:banquets',
  'hotel:maintenance',
  'hotel:api-admin',
];

/** Every hospitality capability lives in one namespace (the `hotel:` prefix). */
export const HOSPITALITY_CAPABILITY_NAMESPACES: readonly string[] = ['hotel'];

/**
 * 06 §2 — the fifteen role templates, one per row of the pack's matrix.
 *
 * **How the matrix is read into capabilities.** The pack marks each cell ● full,
 * ◐ limited, r read-only or ○ none, but the nineteen capabilities are coarse:
 * there is no read-only variant of any of them. So the mapping rule is:
 *
 * - ● grants the capability;
 * - ◐ grants it only where the limitation is enforced by the *procedure*, not by
 *   a narrower capability — identity capture, housekeeping status/tasks, a
 *   technician's own work orders, and housekeeping's folio postings. Each of
 *   those is called out on the template below;
 * - ◐ that is a strict subset of a wider capability (Accounts' AR-only
 *   adjustments, Reservations Agent's payment *links*, Sales' event folios, the
 *   "view" cells on agents) grants **nothing**. Handing over the whole capability
 *   to express a fraction of it is exactly the over-grant the pack warns about;
 * - r and ○ grant nothing.
 *
 * That leaves Read-only Auditor and Partner API key — the two rows the pack names
 * as most likely to be over-granted — holding no capability at all in phase 1.
 * That is deliberate and is pinned by a test: read-only and key-scoped access
 * arrive with their own mechanisms (RPT read models, API-01 key scopes), and
 * until then default-deny is the honest answer rather than a full grant.
 */
export const HOSPITALITY_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner', isSystem: true, capabilities: ['*'] },
  {
    key: 'general-manager',
    name: 'General Manager',
    isSystem: true,
    capabilities: [...HOSPITALITY_CAPABILITIES],
  },
  {
    key: 'front-office-manager',
    name: 'Front Office Manager',
    isSystem: true,
    capabilities: [
      'hotel:reservations',
      'hotel:front-desk',
      'hotel:folio',
      'hotel:folio-adjust',
      'hotel:payments',
      'hotel:refunds',
      'hotel:rates',
      'hotel:availability-override',
      'hotel:night-audit',
      'hotel:guest-identity',
      'hotel:channels',
    ],
  },
  {
    key: 'front-desk-agent',
    name: 'Front Desk Agent',
    isSystem: true,
    // ◐ identity: the capability's own definition is "read identity numbers /
    // images; capture; run verification", and every read it permits is audited,
    // which is the limitation the pack states.
    capabilities: [
      'hotel:reservations',
      'hotel:front-desk',
      'hotel:folio',
      'hotel:payments',
      'hotel:guest-identity',
    ],
  },
  {
    key: 'reservations-agent',
    name: 'Reservations Agent',
    isSystem: true,
    capabilities: ['hotel:reservations'],
  },
  {
    key: 'night-auditor',
    name: 'Night Auditor',
    isSystem: true,
    capabilities: [
      'hotel:front-desk',
      'hotel:folio',
      'hotel:folio-adjust',
      'hotel:payments',
      'hotel:night-audit',
      'hotel:reports-financial',
    ],
  },
  {
    key: 'housekeeping-supervisor',
    name: 'Housekeeping Supervisor',
    isSystem: true,
    // ◐ folio (postings): `hotel:folio` grants catalog charges, which is what a
    // minibar or laundry posting is. Creating a work order from a discrepancy is
    // a housekeeping procedure (05 §3), so no maintenance grant is needed.
    capabilities: ['hotel:folio', 'hotel:housekeeping'],
  },
  {
    key: 'housekeeper',
    name: 'Housekeeper',
    isSystem: true,
    // ◐ status/tasks: the board and task surfaces gate on this one capability;
    // the narrower split lands when the housekeeping lane ships.
    capabilities: ['hotel:housekeeping'],
  },
  {
    key: 'maintenance-technician',
    name: 'Maintenance Technician',
    isSystem: true,
    // ◐ own work orders: assignment scoping is a resolver predicate, not a
    // capability, so the technician holds the capability and sees only their own.
    capabilities: ['hotel:maintenance'],
  },
  {
    key: 'maintenance-manager',
    name: 'Maintenance Manager',
    isSystem: true,
    capabilities: ['hotel:maintenance'],
  },
  {
    key: 'accounts-ar',
    name: 'Accounts / AR',
    isSystem: true,
    capabilities: ['hotel:folio', 'hotel:payments', 'hotel:refunds', 'hotel:reports-financial'],
  },
  {
    key: 'sales-events',
    name: 'Sales / Events',
    isSystem: true,
    capabilities: ['hotel:reservations', 'hotel:banquets'],
  },
  {
    key: 'revenue-marketing-manager',
    name: 'Revenue / Marketing Manager',
    isSystem: true,
    capabilities: ['hotel:rates', 'hotel:channels', 'hotel:marketing', 'hotel:agents'],
  },
  {
    key: 'read-only-auditor',
    name: 'Read-only Auditor',
    isSystem: true,
    // Every cell on this row is r or ○, and no read-only capability variant
    // exists yet. Holding nothing is the faithful reading.
    capabilities: [],
  },
  {
    key: 'partner-api-key',
    name: 'Partner API key',
    isSystem: true,
    // API-01 scopes a key explicitly (key id + branch set + capability list), so
    // the organization-role template grants nothing; the key carries its own scope.
    capabilities: [],
  },
];

export const RESTAURANT_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Owner / Administrator', isSystem: true, capabilities: ['*'] },
  {
    key: 'general-manager',
    name: 'General Manager',
    isSystem: true,
    capabilities: [
      'restaurant:configure',
      'branches:read',
      'branches:manage',
      'pos:operate',
      'orders:read',
      'catering:read',
      'catering:manage',
      'orders:void',
      'orders:discount',
      'orders:complimentary',
      'payments:collect',
      'payments:refund',
      'cash:open',
      'cash:adjust',
      'cash:close',
      'money:read',
      'menu:read',
      'menu:write',
      // M3-L1 (additive, C7): the GM authors and publishes menus and sets prices.
      'menu:publish',
      'menu:price',
      'inventory:read',
      'inventory:count',
      'inventory:adjust',
      'inventory:waste',
      'purchasing:create',
      'purchasing:approve',
      'sop:complete',
      'sop:verify',
      'sop:manage',
      'staff:manage',
      'customers:read',
      'customers:manage',
      'loyalty:redeem',
      'reports:operational',
      'reports:financial',
      // M4-L1 (additive): the GM oversees both floor order-taking and the kitchen.
      'orders:take',
      'kitchen:operate',
    ],
  },
  {
    key: 'branch-manager',
    name: 'Branch Manager',
    isSystem: true,
    capabilities: [
      'branches:read',
      'pos:operate',
      'orders:read',
      'catering:read',
      'catering:manage',
      'orders:void',
      'orders:discount',
      'orders:complimentary',
      'payments:collect',
      'payments:refund',
      'cash:open',
      'cash:adjust',
      'cash:close',
      'menu:read',
      // M3-L1 (additive, C7): the branch manager publishes menus to their branch
      // and applies approved price overrides; they do not author the brand catalog
      // (no menu:write).
      'menu:publish',
      'menu:price',
      'inventory:read',
      'inventory:count',
      'inventory:adjust',
      'inventory:waste',
      'purchasing:create',
      'sop:complete',
      'sop:verify',
      'staff:manage',
      'customers:read',
      'customers:manage',
      'loyalty:redeem',
      'reports:operational',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    isSystem: true,
    capabilities: [
      'pos:operate',
      'orders:read',
      // M4-L1 (additive): a cashier takes orders at the POS.
      'orders:take',
      'payments:collect',
      'cash:open',
      'cash:close',
      'menu:read',
      'customers:read',
    ],
  },
  {
    key: 'server',
    name: 'Server',
    isSystem: true,
    // M4-L1 (additive): a server takes orders on the floor.
    capabilities: ['pos:operate', 'orders:read', 'orders:take', 'menu:read', 'customers:read'],
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    isSystem: true,
    // M4-L1 (additive): kitchen staff operate the KDS.
    capabilities: ['orders:read', 'kitchen:operate', 'menu:read', 'sop:complete'],
  },
  {
    key: 'bar-barista',
    name: 'Bar / Barista',
    isSystem: true,
    // M4-L1 (additive): the bar both takes orders and operates its KDS.
    capabilities: [
      'pos:operate',
      'orders:read',
      'orders:take',
      'kitchen:operate',
      'menu:read',
      'sop:complete',
    ],
  },
  {
    key: 'inventory-controller',
    name: 'Inventory Controller',
    isSystem: true,
    capabilities: [
      'inventory:read',
      'inventory:count',
      'inventory:adjust',
      'inventory:waste',
      'menu:read',
      'reports:operational',
    ],
  },
  {
    key: 'purchasing-officer',
    name: 'Purchasing Officer',
    isSystem: true,
    capabilities: [
      'purchasing:create',
      'purchasing:approve',
      'inventory:read',
      'reports:operational',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    isSystem: true,
    capabilities: ['money:read', 'reports:financial', 'reports:operational', 'payments:refund'],
  },
  {
    key: 'sop-compliance-auditor',
    name: 'SOP / Compliance Auditor',
    isSystem: true,
    capabilities: ['sop:complete', 'sop:verify', 'sop:manage', 'reports:operational'],
  },
];

// ---------------------------------------------------------------------------
// §8 (cont.) — JOB-ROLE profiles: the vertical-supplied floor templates
// ---------------------------------------------------------------------------
//
// TWO ROLE SURFACES, ONE PERMISSION MODEL PER SUBJECT — and they are not the
// same subject, which is why both lists live here without colliding.
//
//   `RESTAURANT_ROLE_TEMPLATES` above seeds `OrganizationRole` — the BACK-OFFICE
//   web role of an app `User`. A user has exactly ONE (`User.organizationRoleId`
//   is singular).
//
//   `RESTAURANT_JOB_ROLE_TEMPLATES` below seeds `RestaurantJobRole` — the FLOOR
//   DUTY of a `RestaurantStaffProfile`, who need not have a web login at all and
//   holds MANY, per branch.
//
// The keys `cashier`, `server` and `kitchen` deliberately appear in both lists:
// they name the same real-world job on two different subjects, stored in two
// different tables, and neither resolution path ever reads the other's rows. No
// third permission model is introduced by this file.
//
// WHY NO `['*']` HERE. The organization-role `owner` template uses the `'*'`
// wildcard; the job-role side must not, and `owner` below is enumerated instead.
// Job-role resolution is plain set membership, and a per-person DENY has to be
// able to subtract a NAMED capability from what a role granted. A wildcard is
// not subtractable — denying `payments:refund` against `'*'` would be a silent
// no-op. Enumerating keeps every grant deniable.
//
// Capabilities are drawn only from {@link RESTAURANT_CAPABILITIES}; a template
// naming a capability outside that list is a governance failure, not a feature.

export type JobRoleTemplate = {
  key: string;
  name: string;
  description: string;
  /** Capabilities the role grants by default. Enumerated — never `['*']`. */
  capabilities: readonly string[];
};

/** Capabilities every floor role carries: read the menu and complete an SOP. */
const FLOOR_BASELINE: readonly string[] = ['menu:read', 'sop:complete'];

/** Order-taking at a register or on the floor. */
const TAKES_ORDERS: readonly string[] = ['pos:operate', 'orders:read', 'orders:take'];

/** Handles the drawer: opens it, takes money, closes it. Deliberately excludes
 * `orders:discount` and `payments:refund` — those are supervisor powers, and a
 * cashier who legitimately needs one gets a DIRECT grant, per person. */
const RUNS_A_REGISTER: readonly string[] = [
  ...TAKES_ORDERS,
  'payments:collect',
  'cash:open',
  'cash:close',
];

/** Everything a shift supervisor may do on the floor. */
const SUPERVISES_A_SHIFT: readonly string[] = [
  ...RUNS_A_REGISTER,
  'cash:adjust',
  'orders:void',
  'orders:discount',
  'payments:refund',
  'coauth:approve',
  'kitchen:operate',
  'inventory:read',
  'inventory:count',
  'customers:read',
  'loyalty:redeem',
  'reports:operational',
  'sop:verify',
];

/** Everything a branch manager may do: supervise, plus run the branch. */
const MANAGES_A_BRANCH: readonly string[] = [
  ...SUPERVISES_A_SHIFT,
  'branches:read',
  'orders:complimentary',
  'inventory:adjust',
  'inventory:waste',
  'purchasing:create',
  'purchasing:approve',
  'menu:publish',
  'menu:price',
  'staff:manage',
  'devices:manage',
  'terminal:operate',
  'sop:manage',
];

export const RESTAURANT_JOB_ROLE_TEMPLATES: readonly JobRoleTemplate[] = [
  {
    key: 'barista',
    name: 'Barista',
    description: 'Prepares beverages at the bar station and works its ticket rail.',
    capabilities: [...FLOOR_BASELINE, ...TAKES_ORDERS, 'kitchen:operate'],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    description: 'Operates the register and handles guest checkout.',
    capabilities: [...FLOOR_BASELINE, ...RUNS_A_REGISTER, 'customers:read'],
  },
  {
    key: 'server',
    name: 'Server',
    description: 'Takes orders at the table and looks after the guest through the meal.',
    capabilities: [...FLOOR_BASELINE, ...TAKES_ORDERS, 'customers:read'],
  },
  {
    key: 'kitchen',
    name: 'Kitchen / Line Cook',
    description: 'Works the kitchen line and prep stations against the KDS.',
    capabilities: [
      ...FLOOR_BASELINE,
      'orders:read',
      'kitchen:operate',
      'inventory:read',
      'inventory:waste',
    ],
  },
  {
    key: 'host',
    name: 'Host',
    description: 'Greets and seats guests, and manages the waitlist. Handles no money.',
    capabilities: [...FLOOR_BASELINE, 'orders:read', 'customers:read'],
  },
  {
    key: 'shift-supervisor',
    name: 'Shift Supervisor',
    description: 'Runs the floor for one shift: approves voids, discounts and refunds.',
    capabilities: [...FLOOR_BASELINE, ...SUPERVISES_A_SHIFT],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs the branch: staffing, purchasing, menu publication and compliance.',
    capabilities: [...FLOOR_BASELINE, ...MANAGES_A_BRANCH],
  },
  {
    key: 'owner',
    name: 'Owner',
    description: 'Owns the business: configuration, money, devices and pay rates.',
    capabilities: [...RESTAURANT_CAPABILITIES],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Reconciles takings and approves purchasing. Never operates the floor.',
    capabilities: [
      'orders:read',
      'payments:refund',
      'cash:adjust',
      'purchasing:approve',
      'reports:operational',
      'reports:financial',
    ],
  },
  {
    key: 'delivery-rider',
    name: 'Delivery Rider',
    description: 'Carries orders to the guest and may collect payment on delivery.',
    capabilities: [...FLOOR_BASELINE, 'orders:read', 'payments:collect', 'customers:read'],
  },
];

// ---------------------------------------------------------------------------
// §13 — Preliminary commercial packages (three keys)
// ---------------------------------------------------------------------------

export type PackageDefinition = {
  key: string;
  name: string;
  vertical: OrganizationVertical;
  /** Module keys included by the package (§13). */
  moduleKeys: readonly string[];
  /** Conservative default limit values (§7 keys). Provisional (D10); Essentials
   * pins `restaurant.locations.max = 1`. */
  defaultLimits: Readonly<Record<string, number>>;
};

const ESSENTIALS_MODULES: readonly string[] = [
  'restaurant-core',
  'restaurant-pos',
  'restaurant-menu',
  'restaurant-inventory',
  'restaurant-workforce',
  'restaurant-sop',
];

const OPERATIONS_MODULES: readonly string[] = [
  ...ESSENTIALS_MODULES,
  'restaurant-purchasing',
  'restaurant-loyalty',
  'restaurant-insights',
  'restaurant-integrations',
];

const ENTERPRISE_MODULES: readonly string[] = RESTAURANT_MODULES.map((module) => module.key);

/** Operational safety ceiling shared by every package; SOP template count is not tier-priced. */
export const SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL = 1000;

export const RESTAURANT_PACKAGES: readonly PackageDefinition[] = [
  {
    key: 'restaurant-essentials',
    name: 'Restaurant Essentials',
    vertical: 'RESTAURANT',
    moduleKeys: ESSENTIALS_MODULES,
    defaultLimits: {
      'restaurant.locations.max': 1,
      'restaurant.brands.max': 1,
      'pos.terminals.max': 2,
      'pos.registeredDevices.max': 4,
      'pos.orders.monthly': 5000,
      'pos.concurrentRegisters.max': 2,
      'restaurant.operators.max': 10,
      'inventory.stockLocations.max': 1,
      'sop.templates.max': SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL,
      'sop.evidenceRetentionDays': 90,
    },
  },
  {
    key: 'restaurant-operations',
    name: 'Restaurant Operations',
    vertical: 'RESTAURANT',
    moduleKeys: OPERATIONS_MODULES,
    defaultLimits: {
      'restaurant.locations.max': 5,
      'restaurant.brands.max': 3,
      'pos.terminals.max': 10,
      'pos.registeredDevices.max': 25,
      'pos.orders.monthly': 50000,
      'pos.concurrentRegisters.max': 10,
      'restaurant.operators.max': 100,
      'inventory.stockLocations.max': 10,
      'sop.templates.max': SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL,
      'sop.evidenceRetentionDays': 365,
      'loyalty.activeCustomers.max': 25000,
      'integrations.connections.max': 10,
      'restaurantInsights.retentionMonths': 24,
    },
  },
  {
    key: 'restaurant-enterprise',
    name: 'Restaurant Enterprise',
    vertical: 'RESTAURANT',
    moduleKeys: ENTERPRISE_MODULES,
    // Enterprise quantities are contracted per SOW; these are conservative
    // non-zero ceilings, not a promise of self-service scale.
    defaultLimits: {
      'restaurant.locations.max': 100,
      'restaurant.brands.max': 25,
      'pos.terminals.max': 250,
      'pos.registeredDevices.max': 1000,
      'pos.orders.monthly': 1000000,
      'pos.concurrentRegisters.max': 250,
      'restaurant.operators.max': 2500,
      'inventory.stockLocations.max': 250,
      'sop.templates.max': SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL,
      'sop.evidenceRetentionDays': 1095,
      'loyalty.activeCustomers.max': 1000000,
      'integrations.connections.max': 100,
      'restaurantInsights.retentionMonths': 60,
    },
  },
];

const PHARMACY_ESSENTIALS_MODULES = [
  'pharmacy-core',
  'pharmacy-counter',
  'pharmacy-inventory',
  'pharmacy-procurement',
  'pharmacy-finance',
  'pharmacy-reports',
] as const;
const PHARMACY_PROFESSIONAL_MODULES = [
  ...PHARMACY_ESSENTIALS_MODULES,
  'pharmacy-dispensing',
  'pharmacy-safety',
  'pharmacy-crm',
] as const;

export const PHARMACY_PACKAGES: readonly PackageDefinition[] = [
  {
    key: 'pharmacy-essentials',
    name: 'Pharmacy Essentials',
    vertical: 'PHARMACY',
    moduleKeys: PHARMACY_ESSENTIALS_MODULES,
    defaultLimits: {
      'pharmacy.branches.max': 1,
      'pharmacy.counters.max': 2,
      'pharmacy.users.max': 10,
    },
  },
  {
    key: 'pharmacy-professional',
    name: 'Pharmacy Professional',
    vertical: 'PHARMACY',
    moduleKeys: PHARMACY_PROFESSIONAL_MODULES,
    defaultLimits: {
      'pharmacy.branches.max': 5,
      'pharmacy.counters.max': 10,
      'pharmacy.users.max': 50,
    },
  },
  {
    key: 'pharmacy-chain',
    name: 'Pharmacy Chain',
    vertical: 'PHARMACY',
    moduleKeys: PHARMACY_MODULES.map((module) => module.key),
    defaultLimits: {
      'pharmacy.branches.max': 100,
      'pharmacy.counters.max': 500,
      'pharmacy.users.max': 2500,
    },
  },
];

// GTM-01 — the four hospitality packages, expressed through the module/limit
// model and nothing else. Essentials names the six operating surfaces of PRD
// §5.23 on top of mandatory Hotel Core; Pro adds the six growth surfaces; Chain
// adds multi-property central reservations; Venue is the odd one out and is a
// *different* set rather than a wider one — it sells banquets and the catering
// seam and deliberately carries no room modules (MODE-05).
const HOSPITALITY_ESSENTIALS_MODULES = [
  'hotel-core',
  'hotel-reservations',
  'hotel-front-desk',
  'hotel-folio',
  'hotel-payments',
  'hotel-night-audit',
  'hotel-reports',
] as const;

const HOSPITALITY_PRO_MODULES = [
  ...HOSPITALITY_ESSENTIALS_MODULES,
  'hotel-channels',
  'hotel-upsell',
  'hotel-marketing',
  'hotel-agents',
  'hotel-maintenance',
  'hotel-api',
] as const;

const HOSPITALITY_CHAIN_MODULES = [...HOSPITALITY_PRO_MODULES, 'hotel-crs'] as const;

/**
 * MODE-05: "a VENUE property has no availability days". The package therefore
 * omits reservations, front desk, channels, upsell and the CRS, and keeps only
 * what an events business bills and closes with.
 */
const HOSPITALITY_VENUE_MODULES = [
  'hotel-core',
  'hotel-banquets',
  'hotel-folio',
  'hotel-payments',
  'hotel-night-audit',
  'hotel-reports',
] as const;

export const HOSPITALITY_PACKAGES: readonly PackageDefinition[] = [
  {
    key: 'hotel-essentials',
    name: 'Hotel Essentials',
    vertical: 'HOSPITALITY',
    moduleKeys: HOSPITALITY_ESSENTIALS_MODULES,
    defaultLimits: {
      'hotel.properties.max': 1,
      'hotel.rooms.max': 50,
      'hotel.users.max': 15,
    },
  },
  {
    key: 'hotel-pro',
    name: 'Hotel Pro',
    vertical: 'HOSPITALITY',
    moduleKeys: HOSPITALITY_PRO_MODULES,
    defaultLimits: {
      'hotel.properties.max': 3,
      'hotel.rooms.max': 250,
      'hotel.users.max': 75,
    },
  },
  {
    key: 'hotel-chain',
    name: 'Hotel Chain',
    vertical: 'HOSPITALITY',
    moduleKeys: HOSPITALITY_CHAIN_MODULES,
    defaultLimits: {
      'hotel.properties.max': 100,
      'hotel.rooms.max': 10000,
      'hotel.users.max': 2500,
    },
  },
  {
    key: 'hotel-venue',
    name: 'Hotel Venue',
    vertical: 'HOSPITALITY',
    moduleKeys: HOSPITALITY_VENUE_MODULES,
    defaultLimits: {
      // A venue sells function space, not room-nights; the room ceiling is zero
      // rather than absent, so an accidental room purchase is refused by the
      // limit rather than by a mode conditional in application code.
      'hotel.properties.max': 1,
      'hotel.rooms.max': 0,
      'hotel.users.max': 25,
    },
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — the compatibility surface consumers must call
// ---------------------------------------------------------------------------

/** Commercial modules owned by a vertical. */
export function modulesForVertical(vertical: OrganizationVertical): readonly CommercialModule[] {
  if (vertical === 'HOSPITALITY') return HOSPITALITY_MODULES;
  if (vertical === 'PHARMACY') return PHARMACY_MODULES;
  return vertical === 'RESTAURANT' ? RESTAURANT_MODULES : AGENCY_MODULES;
}

/** The mandatory modules a vertical must enable (§6.1: Restaurant Core). */
export function mandatoryModulesForVertical(
  vertical: OrganizationVertical
): readonly CommercialModule[] {
  return modulesForVertical(vertical).filter((module) => module.mandatory);
}

export function restaurantModuleByKey(key: string): CommercialModule | undefined {
  return RESTAURANT_MODULES.find((module) => module.key === key);
}

export function isRestaurantModuleKey(key: string): boolean {
  return RESTAURANT_MODULES.some((module) => module.key === key);
}

/** Commercial packages offered for a vertical (§2.3 onboarding filter). Agency
 * packages are not modeled here; only their compatibility rule is. */
export function packagesForVertical(vertical: OrganizationVertical): readonly PackageDefinition[] {
  return [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES].filter(
    (pkg) => pkg.vertical === vertical
  );
}

export function packageByKey(key: string): PackageDefinition | undefined {
  return [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES].find(
    (pkg) => pkg.key === key
  );
}

/** The §7 limit key that caps a vertical's licensed users. The `defaultSeats`
 * a package offers at onboarding is this ceiling, so a Pharmacy Chain offers
 * 2500 seats rather than the schema's single-seat default. */
const SEAT_LIMIT_METRIC_BY_VERTICAL: Partial<Record<OrganizationVertical, string>> = {
  RESTAURANT: 'restaurant.operators.max',
  PHARMACY: 'pharmacy.users.max',
  HOSPITALITY: 'hotel.users.max',
};

/**
 * The default licensed-seat ceiling a package is offered with: its vertical's
 * active-user limit. Returns `undefined` for a vertical whose seats are not
 * catalog-modeled here (Agency), so a caller can fall back to the column
 * default rather than pin a wrong number.
 */
export function packageDefaultSeats(pkg: PackageDefinition): number | undefined {
  const metric = SEAT_LIMIT_METRIC_BY_VERTICAL[pkg.vertical];
  return metric ? pkg.defaultLimits[metric] : undefined;
}

export function roleTemplatesForVertical(vertical: OrganizationVertical): readonly RoleTemplate[] {
  if (vertical === 'HOSPITALITY') return HOSPITALITY_ROLE_TEMPLATES;
  if (vertical === 'PHARMACY') return PHARMACY_ROLE_TEMPLATES;
  return vertical === 'RESTAURANT' ? RESTAURANT_ROLE_TEMPLATES : AGENCY_ROLE_TEMPLATES;
}

/**
 * The floor job-role profiles a vertical supplies. These seed
 * `RestaurantJobRole` rows per organization; see {@link roleTemplatesForVertical}
 * for the separate back-office `OrganizationRole` templates.
 */
export function jobRoleTemplatesForVertical(
  vertical: OrganizationVertical
): readonly JobRoleTemplate[] {
  return vertical === 'RESTAURANT' ? RESTAURANT_JOB_ROLE_TEMPLATES : [];
}

export function limitKeysForVertical(
  vertical: OrganizationVertical
): readonly LimitKeyDefinition[] {
  if (vertical === 'HOSPITALITY') return HOSPITALITY_LIMIT_KEYS;
  if (vertical === 'PHARMACY') return PHARMACY_LIMIT_KEYS;
  return vertical === 'RESTAURANT' ? RESTAURANT_LIMIT_KEYS : AGENCY_LIMIT_KEYS;
}

/**
 * §2.3 / D10 — package compatibility is a single `vertical` enum column match.
 * A package may be assigned to an organization only when their verticals are
 * equal. This is the server-side rule; callers must consult it even when a UI
 * has already filtered the choices.
 */
export function isPackageCompatibleWithVertical(
  packageVertical: OrganizationVertical,
  organizationVertical: OrganizationVertical
): boolean {
  return packageVertical === organizationVertical;
}

/**
 * Server-side guard: throw when a package's vertical does not match the
 * organization's vertical (§2.3 — reject a mismatched package even if a crafted
 * request bypasses the UI). Returns void on success so it reads as an assertion.
 */
export function assertPackageCompatibleWithVertical(
  packageVertical: OrganizationVertical,
  organizationVertical: OrganizationVertical
): void {
  if (!isPackageCompatibleWithVertical(packageVertical, organizationVertical)) {
    throw new Error(
      `Package vertical ${packageVertical} is not compatible with organization vertical ${organizationVertical}.`
    );
  }
}
