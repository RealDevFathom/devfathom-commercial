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
 * The Agency vertical's module registry stays in `prisma/production-bootstrap.ts`
 * (`PLATFORM_MODULES`); this catalog does not duplicate it. What lives here for
 * Agency is only its vertical identity and the compatibility rule.
 */

export type { OrganizationVertical };

export const AGENCY: OrganizationVertical = 'AGENCY';
export const RESTAURANT: OrganizationVertical = 'RESTAURANT';

// ---------------------------------------------------------------------------
// §2 / §2.1 — Vertical definitions
// ---------------------------------------------------------------------------

export type VerticalDefinition = {
  vertical: OrganizationVertical;
  /** UI label shown for the "Organization type" decision (§2). */
  label: string;
  description: string;
};

export const VERTICALS: Record<OrganizationVertical, VerticalDefinition> = {
  AGENCY: {
    vertical: 'AGENCY',
    label: 'Agency',
    description: 'Projects, clients, agency finance, HR, and collaboration.',
  },
  RESTAURANT: {
    vertical: 'RESTAURANT',
    label: 'Restaurant',
    description: 'Branches, POS, menu, inventory, SOP, loyalty, and insights.',
  },
};

export const ALL_VERTICALS: readonly OrganizationVertical[] = ['AGENCY', 'RESTAURANT'];

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

export function departmentsForVertical(
  vertical: OrganizationVertical
): readonly DepartmentDefinition[] {
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
  return vertical === RESTAURANT ? 'FRONT_OF_HOUSE' : 'LEADERSHIP';
}

// ---------------------------------------------------------------------------
// §6 — Commercial restaurant module map (ten modules)
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
    countedUnit: 'Active SOP template families, not immutable historical versions',
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
  'payments',
  'cash',
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
  'orders:void',
  'orders:discount',
  'orders:complimentary',
  'payments:collect',
  'payments:refund',
  'cash:open',
  'cash:adjust',
  'cash:close',
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
   * bootstrap admin role. All entries are provisional (Phase 0 / D10). */
  capabilities: readonly string[];
};

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
      'orders:void',
      'orders:discount',
      'orders:complimentary',
      'payments:collect',
      'payments:refund',
      'cash:open',
      'cash:adjust',
      'cash:close',
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
      'customers:read',
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
      'customers:read',
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
    ],
  },
  {
    key: 'server',
    name: 'Server',
    isSystem: true,
    // M4-L1 (additive): a server takes orders on the floor.
    capabilities: ['pos:operate', 'orders:read', 'orders:take', 'menu:read'],
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
    capabilities: ['reports:financial', 'reports:operational', 'payments:refund'],
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
    capabilities: [...FLOOR_BASELINE, ...RUNS_A_REGISTER],
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
    capabilities: [
      ...FLOOR_BASELINE,
      ...MANAGES_A_BRANCH,
      'restaurant:configure',
      'branches:manage',
      'devices:revoke',
      'menu:write',
      'menu:import',
      'reports:financial',
      'workforce:rates',
    ],
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
      'sop.templates.max': 25,
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
      'sop.templates.max': 100,
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
      'sop.templates.max': 1000,
      'sop.evidenceRetentionDays': 1095,
      'loyalty.activeCustomers.max': 1000000,
      'integrations.connections.max': 100,
      'restaurantInsights.retentionMonths': 60,
    },
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — the compatibility surface consumers must call
// ---------------------------------------------------------------------------

/** Commercial modules belonging to a vertical. Agency modules are owned by the
 * platform module registry (production-bootstrap `PLATFORM_MODULES`), so this
 * returns them only for the restaurant vertical. */
export function modulesForVertical(vertical: OrganizationVertical): readonly CommercialModule[] {
  return vertical === 'RESTAURANT' ? RESTAURANT_MODULES : [];
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
  return RESTAURANT_PACKAGES.filter((pkg) => pkg.vertical === vertical);
}

export function packageByKey(key: string): PackageDefinition | undefined {
  return RESTAURANT_PACKAGES.find((pkg) => pkg.key === key);
}

export function roleTemplatesForVertical(vertical: OrganizationVertical): readonly RoleTemplate[] {
  return vertical === 'RESTAURANT' ? RESTAURANT_ROLE_TEMPLATES : [];
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
  return vertical === 'RESTAURANT' ? RESTAURANT_LIMIT_KEYS : [];
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
