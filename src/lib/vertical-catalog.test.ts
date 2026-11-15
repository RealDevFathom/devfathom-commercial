import { describe, expect, it } from 'vitest';

import { capabilityMatches } from '@/lib/abac/capabilities';

import {
  PHARMACY_SOP_TEMPLATE_GRANTS,
  ALL_VERTICALS,
  AGENCY_MODULES,
  AGENCY_ROLE_TEMPLATES,
  AGENCY_DEPARTMENTS,
  PHARMACY_CAPABILITIES,
  PHARMACY_DEPARTMENTS,
  PHARMACY_LIMIT_KEYS,
  PHARMACY_MODULES,
  PHARMACY_PACKAGES,
  PHARMACY_ROLE_TEMPLATES,
  RESTAURANT_DEPARTMENTS,
  RESTAURANT_CAPABILITIES,
  RESTAURANT_CAPABILITY_NAMESPACES,
  RESTAURANT_LIMIT_KEYS,
  RESTAURANT_MODULES,
  RESTAURANT_PACKAGES,
  RESTAURANT_JOB_ROLE_TEMPLATES,
  RESTAURANT_ROLE_TEMPLATES,
  SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL,
  VERTICALS,
  adminDepartmentKeyForVertical,
  assertPackageCompatibleWithVertical,
  defaultDepartmentRowsForVertical,
  departmentsForVertical,
  memberDepartmentKeyForVertical,
  isPackageCompatibleWithVertical,
  isRestaurantModuleKey,
  jobRoleTemplatesForVertical,
  limitKeysForVertical,
  mandatoryModulesForVertical,
  modulesForVertical,
  packageByKey,
  packageDefaultSeats,
  HOSPITALITY_PACKAGES,
  packagesForVertical,
  restaurantModuleByKey,
  roleTemplatesForVertical,
} from './vertical-catalog';

describe('vertical definitions (§2)', () => {
  it('defines the registered verticals with UI labels', () => {
    expect(ALL_VERTICALS).toEqual(['AGENCY', 'RESTAURANT', 'PHARMACY', 'HOSPITALITY']);
    expect(VERTICALS.AGENCY.label).toBe('Agency');
    expect(VERTICALS.RESTAURANT.label).toBe('Restaurant');
    expect(VERTICALS.PHARMACY.label).toBe('Pharmacy');
    expect(VERTICALS.HOSPITALITY.label).toBe('Hospitality');
  });
});

describe('vertical department defaults', () => {
  it('keeps agency defaults on the agency vertical', () => {
    expect(departmentsForVertical('AGENCY')).toEqual(AGENCY_DEPARTMENTS);
    expect(AGENCY_DEPARTMENTS.map((department) => department.key)).toContain('ENGINEERING');
  });

  it('uses restaurant defaults without agency leakage', () => {
    expect(departmentsForVertical('RESTAURANT')).toEqual(RESTAURANT_DEPARTMENTS);
    expect(RESTAURANT_DEPARTMENTS).toEqual([
      { key: 'KITCHEN', name: 'Kitchen' },
      { key: 'FRONT_OF_HOUSE', name: 'Front of House' },
    ]);
    expect(RESTAURANT_DEPARTMENTS.map((department) => department.key)).not.toContain('ENGINEERING');
  });

  // WHA-290 — the identity paths derive a department instead of taking one, so
  // both declared defaults must be keys the vertical's own catalog contains.
  it('declares provisioning defaults that exist in each vertical catalog', () => {
    for (const vertical of ALL_VERTICALS) {
      const keys = departmentsForVertical(vertical).map((department) => department.key);
      expect(keys).toContain(adminDepartmentKeyForVertical(vertical));
      expect(keys).toContain(memberDepartmentKeyForVertical(vertical));
    }
  });

  it('keeps the pre-WHA-278 agency pair and gives a restaurant a floor department', () => {
    expect(adminDepartmentKeyForVertical('AGENCY')).toBe('LEADERSHIP');
    expect(memberDepartmentKeyForVertical('AGENCY')).toBe('ENGINEERING');
    expect(adminDepartmentKeyForVertical('RESTAURANT')).toBe('FRONT_OF_HOUSE');
    expect(memberDepartmentKeyForVertical('RESTAURANT')).toBe('FRONT_OF_HOUSE');
  });

  it('numbers default rows in catalog order for every vertical', () => {
    for (const vertical of ALL_VERTICALS) {
      expect(defaultDepartmentRowsForVertical(vertical)).toEqual(
        departmentsForVertical(vertical).map((department, index) => ({
          key: department.key,
          name: department.name,
          sortOrder: index,
        }))
      );
    }
  });
});

describe('pharmacy registry (PLAT-01)', () => {
  it('registers the core, optional modules, limits, departments and roles', () => {
    expect(PHARMACY_MODULES).toHaveLength(9);
    expect(
      PHARMACY_MODULES.filter((module) => module.mandatory).map((module) => module.key)
    ).toEqual(['pharmacy-core']);
    expect(PHARMACY_MODULES.every((module) => module.routePrefix.startsWith('/pharmacy'))).toBe(
      true
    );
    expect(PHARMACY_LIMIT_KEYS.map((limit) => limit.key)).toEqual([
      'pharmacy.branches.max',
      'pharmacy.counters.max',
      'pharmacy.users.max',
    ]);
    expect(PHARMACY_DEPARTMENTS.map((department) => department.name)).toEqual([
      'Counter',
      'Dispensary',
      'Store',
      'Procurement',
      'Finance',
      'Compliance',
    ]);
    expect(PHARMACY_ROLE_TEMPLATES.map((role) => role.key)).toEqual([
      'owner',
      'owner-operator',
      'pharmacist',
      'manager',
      'cashier',
      'procurement',
      'inventory',
      'finance',
      'auditor',
    ]);
    expect(
      PHARMACY_ROLE_TEMPLATES.flatMap((role) => role.capabilities).every((capability) =>
        PHARMACY_CAPABILITIES.includes(capability)
      )
    ).toBe(true);
  });

  it('composes Essentials, Professional and Chain per the pharmacy catalog', () => {
    expect(PHARMACY_PACKAGES.map((pkg) => pkg.name)).toEqual([
      'Pharmacy Essentials',
      'Pharmacy Professional',
      'Pharmacy Chain',
    ]);
    expect(PHARMACY_PACKAGES[0]?.moduleKeys).toEqual([
      'pharmacy-core',
      'pharmacy-counter',
      'pharmacy-inventory',
      'pharmacy-procurement',
      'pharmacy-finance',
      'pharmacy-reports',
    ]);
    expect(PHARMACY_PACKAGES[1]?.moduleKeys).toEqual([
      ...PHARMACY_PACKAGES[0]!.moduleKeys,
      'pharmacy-dispensing',
      'pharmacy-safety',
      'pharmacy-crm',
    ]);
    expect(PHARMACY_PACKAGES[2]?.moduleKeys).toEqual(PHARMACY_MODULES.map((module) => module.key));
  });

  it('offers each pharmacy package its active-user ceiling as default seats', () => {
    expect(PHARMACY_PACKAGES.map((pkg) => packageDefaultSeats(pkg))).toEqual([10, 50, 2500]);
  });
});

describe('package default seats', () => {
  it('reads the per-vertical active-user limit', () => {
    for (const pkg of [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES]) {
      const seats = packageDefaultSeats(pkg);
      expect(typeof seats).toBe('number');
      expect(seats).toBeGreaterThan(0);
    }
  });

  it('matches the catalog user ceilings exactly', () => {
    expect(RESTAURANT_PACKAGES.map((pkg) => packageDefaultSeats(pkg))).toEqual([10, 100, 2500]);
    expect(HOSPITALITY_PACKAGES.map((pkg) => packageDefaultSeats(pkg))).toEqual([15, 75, 2500, 25]);
  });
});

describe('restaurant module map (§6)', () => {
  it('lists exactly the ten commercial modules', () => {
    expect(RESTAURANT_MODULES).toHaveLength(10);
  });

  it('every module has a name, category, and /restaurant route prefix', () => {
    for (const mod of RESTAURANT_MODULES) {
      expect(mod.name.length).toBeGreaterThan(0);
      expect(mod.category.length).toBeGreaterThan(0);
      expect(mod.vertical).toBe('RESTAURANT');
      expect(mod.routePrefix.startsWith('/restaurant')).toBe(true);
    }
  });

  it('uses unique module keys and route prefixes', () => {
    const keys = RESTAURANT_MODULES.map((module) => module.key);
    const routes = RESTAURANT_MODULES.map((module) => module.routePrefix);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('marks Restaurant Core as the single mandatory module (§6.1)', () => {
    const mandatory = RESTAURANT_MODULES.filter((module) => module.mandatory);
    expect(mandatory.map((module) => module.key)).toEqual(['restaurant-core']);
  });

  it('modulesForVertical returns each vertical registry', () => {
    expect(modulesForVertical('RESTAURANT')).toEqual(RESTAURANT_MODULES);
    expect(modulesForVertical('AGENCY')).toEqual(AGENCY_MODULES);
  });

  it('mandatoryModulesForVertical returns Restaurant Core for RESTAURANT', () => {
    expect(mandatoryModulesForVertical('RESTAURANT').map((m) => m.key)).toEqual([
      'restaurant-core',
    ]);
    expect(mandatoryModulesForVertical('AGENCY').map((m) => m.key)).toEqual(['agency-core']);
  });

  it('resolves modules by key', () => {
    expect(restaurantModuleByKey('restaurant-pos')?.name).toBe('POS and Fulfilment');
    expect(restaurantModuleByKey('nope')).toBeUndefined();
    expect(isRestaurantModuleKey('restaurant-core')).toBe(true);
    expect(isRestaurantModuleKey('projects')).toBe(false);
  });
});

describe('limit keys (§7)', () => {
  it('defines the thirteen limit keys with counting contracts', () => {
    expect(RESTAURANT_LIMIT_KEYS).toHaveLength(13);
    for (const limit of RESTAURANT_LIMIT_KEYS) {
      expect(limit.countedUnit.length).toBeGreaterThan(0);
    }
    expect(RESTAURANT_LIMIT_KEYS.map((l) => l.key)).toContain('restaurant.locations.max');
  });

  it('limitKeysForVertical is restaurant-only', () => {
    expect(limitKeysForVertical('RESTAURANT')).toEqual(RESTAURANT_LIMIT_KEYS);
    expect(limitKeysForVertical('AGENCY')).toEqual([]);
  });
});

describe('role templates and capabilities (§8)', () => {
  it('defines the eleven role templates', () => {
    expect(RESTAURANT_ROLE_TEMPLATES).toHaveLength(11);
    expect(RESTAURANT_ROLE_TEMPLATES.map((role) => role.key)).toContain('owner');
  });

  it('the owner template holds full administration', () => {
    const owner = RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === 'owner');
    expect(owner?.capabilities).toEqual(['*']);
  });

  it('grants Restaurant Finance only to Owner, General Manager, and Accountant', () => {
    expect(RESTAURANT_CAPABILITIES).toContain('money:read');
    const grants = RESTAURANT_ROLE_TEMPLATES.filter(
      (role) => role.capabilities.includes('*') || role.capabilities.includes('money:read')
    ).map((role) => role.key);
    expect(grants).toEqual(['owner', 'general-manager', 'accountant']);
    for (const role of RESTAURANT_ROLE_TEMPLATES.filter((role) => !grants.includes(role.key))) {
      expect(role.capabilities).not.toContain('money:read');
    }
  });

  it('every non-owner capability is a namespaced action drawn from the catalog', () => {
    for (const role of RESTAURANT_ROLE_TEMPLATES) {
      for (const capability of role.capabilities) {
        if (capability === '*') continue;
        expect(RESTAURANT_CAPABILITIES).toContain(capability);
        const namespace = capability.split(':')[0];
        expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain(namespace);
      }
    }
  });

  it('grants customer management only to intended administrative roles', () => {
    const roleFor = (key: string) => RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === key)!;

    expect(roleFor('owner').capabilities).toContain('*');
    expect(roleFor('general-manager').capabilities).toContain('customers:manage');
    expect(roleFor('branch-manager').capabilities).toContain('customers:manage');
    for (const role of RESTAURANT_ROLE_TEMPLATES.filter(
      (candidate) => !['owner', 'general-manager', 'branch-manager'].includes(candidate.key)
    )) {
      expect(role.capabilities).not.toContain('customers:manage');
    }
  });

  it('grants staff management explicitly only to General Manager and Branch Manager', () => {
    const grants = RESTAURANT_ROLE_TEMPLATES.filter((role) =>
      role.capabilities.includes('staff:manage')
    ).map((role) => role.key);

    expect(grants).toEqual(['general-manager', 'branch-manager']);
  });

  it('roleTemplatesForVertical returns each vertical template catalog', () => {
    expect(roleTemplatesForVertical('RESTAURANT')).toEqual(RESTAURANT_ROLE_TEMPLATES);
    expect(roleTemplatesForVertical('AGENCY')).toEqual(AGENCY_ROLE_TEMPLATES);
  });

  it('every catalog capability draws its namespace from the namespace list', () => {
    const namespaces = new Set(RESTAURANT_CAPABILITY_NAMESPACES);
    for (const capability of RESTAURANT_CAPABILITIES) {
      expect(namespaces.has(capability.split(':')[0]!)).toBe(true);
    }
  });

  it('capability keys and namespaces are unique (no duplicate reconciliation)', () => {
    expect(new Set(RESTAURANT_CAPABILITIES).size).toBe(RESTAURANT_CAPABILITIES.length);
    expect(new Set(RESTAURANT_CAPABILITY_NAMESPACES).size).toBe(
      RESTAURANT_CAPABILITY_NAMESPACES.length
    );
  });
});

describe('B1/WHA-285 job-role profiles (§8 cont.)', () => {
  it('supplies the ten floor job-role templates', () => {
    expect(RESTAURANT_JOB_ROLE_TEMPLATES).toHaveLength(10);
  });

  it('jobRoleTemplatesForVertical is restaurant-only', () => {
    expect(jobRoleTemplatesForVertical('RESTAURANT')).toEqual(RESTAURANT_JOB_ROLE_TEMPLATES);
    expect(jobRoleTemplatesForVertical('AGENCY')).toEqual([]);
  });

  it('draws every job-role capability from the catalog, and never uses `*`', () => {
    // The ORGANIZATION-role owner template may use `*`; a job role may not, because
    // a per-person DENY has to be able to subtract a named capability from it.
    for (const role of RESTAURANT_JOB_ROLE_TEMPLATES) {
      for (const capability of role.capabilities) {
        expect(capability).not.toBe('*');
        expect(RESTAURANT_CAPABILITIES).toContain(capability);
        expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain(capability.split(':')[0]);
      }
    }
  });

  it('keeps the two §8 template lists separate objects', () => {
    // Job roles key a staff profile; organization roles key an app user. Shared
    // keys are the same job on different subjects, never the same record.
    expect(RESTAURANT_JOB_ROLE_TEMPLATES).not.toBe(RESTAURANT_ROLE_TEMPLATES);
    expect(RESTAURANT_ROLE_TEMPLATES.some((role) => role.key === 'shift-supervisor')).toBe(false);
    expect(RESTAURANT_JOB_ROLE_TEMPLATES.some((role) => role.key === 'general-manager')).toBe(
      false
    );
  });
});

describe('M2-L1 capability reconciliation (additive-only)', () => {
  it('adds exactly the five M2-L1 capability keys', () => {
    for (const capability of [
      'staff:manage',
      'devices:manage',
      'devices:revoke',
      'terminal:operate',
      'coauth:approve',
    ]) {
      expect(RESTAURANT_CAPABILITIES).toContain(capability);
    }
  });

  it('adds the staff/devices/terminal/coauth namespaces', () => {
    for (const namespace of ['staff', 'devices', 'terminal', 'coauth']) {
      expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain(namespace);
    }
  });

  it('preserves the 14 M1 namespaces (no removal or rename)', () => {
    for (const namespace of [
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
    ]) {
      expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain(namespace);
    }
  });
});

describe('M3-L1 capability reconciliation (additive-only, C7)', () => {
  it('adds exactly the two M3 menu capability keys on the existing menu namespace', () => {
    for (const capability of ['menu:publish', 'menu:price']) {
      expect(RESTAURANT_CAPABILITIES).toContain(capability);
      expect(capability.split(':')[0]).toBe('menu');
    }
    // The namespace pre-exists (M1) — no new namespace is introduced.
    expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain('menu');
  });

  it('preserves the base menu capabilities (no rename or removal)', () => {
    for (const capability of ['menu:read', 'menu:write']) {
      expect(RESTAURANT_CAPABILITIES).toContain(capability);
    }
  });

  it('grants the M3 menu capabilities to owner (via *), GM, and branch-manager only', () => {
    const roleFor = (key: string) => RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === key)!;

    // Owner holds full administration (['*']) and is not enumerated per-capability.
    expect(roleFor('owner').capabilities).toEqual(['*']);

    for (const key of ['general-manager', 'branch-manager']) {
      expect(roleFor(key).capabilities).toContain('menu:publish');
      expect(roleFor(key).capabilities).toContain('menu:price');
    }

    // The additive wiring is scoped: operational roles do NOT gain publish/price.
    for (const key of ['cashier', 'server', 'kitchen', 'bar-barista', 'inventory-controller']) {
      expect(roleFor(key).capabilities).not.toContain('menu:publish');
      expect(roleFor(key).capabilities).not.toContain('menu:price');
    }
  });
});

describe('M4-L1 capability reconciliation (additive-only)', () => {
  const roleFor = (key: string) => RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === key)!;

  it('adds exactly the two M4 capability keys', () => {
    for (const capability of ['orders:take', 'kitchen:operate']) {
      expect(RESTAURANT_CAPABILITIES).toContain(capability);
    }
  });

  it('adds the kitchen namespace; orders reuses the existing namespace', () => {
    expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain('kitchen');
    expect('orders:take'.split(':')[0]).toBe('orders');
    expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain('orders');
  });

  it('preserves the M2 namespaces (no removal or rename)', () => {
    for (const namespace of ['staff', 'devices', 'terminal', 'coauth']) {
      expect(RESTAURANT_CAPABILITY_NAMESPACES).toContain(namespace);
    }
  });

  it('grants order-taking to owner (via *), GM, cashier, server, and bar', () => {
    expect(roleFor('owner').capabilities).toEqual(['*']);
    for (const key of ['general-manager', 'cashier', 'server', 'bar-barista']) {
      expect(roleFor(key).capabilities).toContain('orders:take');
    }
  });

  it('grants kitchen operation to owner (via *), GM, kitchen, and bar', () => {
    for (const key of ['general-manager', 'kitchen', 'bar-barista']) {
      expect(roleFor(key).capabilities).toContain('kitchen:operate');
    }
  });

  it('scopes the wiring: unrelated roles gain neither capability', () => {
    for (const key of [
      'accountant',
      'inventory-controller',
      'purchasing-officer',
      'sop-compliance-auditor',
    ]) {
      expect(roleFor(key).capabilities).not.toContain('orders:take');
      expect(roleFor(key).capabilities).not.toContain('kitchen:operate');
    }
    // A cashier takes orders but does not operate the kitchen; kitchen staff the reverse.
    expect(roleFor('cashier').capabilities).not.toContain('kitchen:operate');
    expect(roleFor('kitchen').capabilities).not.toContain('orders:take');
  });
});

describe('optional pharmacy Owner / Operator', () => {
  it('offers exactly fifteen explicit grants accepted by the pharmacy capability catalog', () => {
    const templates = roleTemplatesForVertical('PHARMACY').filter(
      (role) => role.key === 'owner-operator'
    );
    expect(templates).toEqual([
      {
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
          'pharmacy:procurement',
          'pharmacy:inventory',
          'pharmacy:counter',
          'pharmacy:close',
          'pharmacy:manage',
          'pharmacy:procurement-approve',
          'sop:manage',
          'sop:complete',
          'sop:verify',
        ],
      },
    ]);
    for (const capability of templates[0]!.capabilities) {
      expect(PHARMACY_CAPABILITIES).toContain(capability);
      expect(capability).toMatch(/^(reports|pharmacy|sop):[a-z-]+$/);
    }
    for (const vertical of ['AGENCY', 'RESTAURANT'] as const) {
      expect(roleTemplatesForVertical(vertical).map((role) => role.key)).not.toContain(
        'owner-operator'
      );
    }
  });

  it('preserves all eight standard roles and their intended grants', () => {
    expect(
      PHARMACY_ROLE_TEMPLATES.filter((role) => role.key !== 'owner-operator').map((role) => ({
        key: role.key,
        // DEV-751 SOP grants are appended separately and pinned below.
        capabilities: role.capabilities.filter((grant) => !grant.startsWith('sop:')),
      }))
    ).toEqual([
      {
        key: 'owner',
        capabilities: ['pharmacy:*', 'reports:operational', 'reports:financial', 'pharmacy:safety'],
      },
      {
        key: 'pharmacist',
        capabilities: ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'],
      },
      {
        key: 'manager',
        capabilities: [
          'pharmacy:manage',
          'pharmacy:orders',
          'pharmacy:procurement',
          'pharmacy:procurement-approve',
        ],
      },
      { key: 'cashier', capabilities: ['pharmacy:counter', 'pharmacy:orders'] },
      { key: 'procurement', capabilities: ['pharmacy:procurement'] },
      { key: 'inventory', capabilities: ['pharmacy:inventory'] },
      { key: 'finance', capabilities: ['reports:operational', 'reports:financial'] },
      { key: 'auditor', capabilities: ['reports:operational'] },
    ]);
  });

  // DEV-519: the pharmacy financial reports (Reports command centre sections,
  // supplier-credit follow-up) are reached through the Reports rail entry and
  // page, which check `reports:operational`. A template granting financial
  // reports must also grant the access those pages check.
  it('grants every financial-reports template the operational reports access its pages check', () => {
    const financial = PHARMACY_ROLE_TEMPLATES.filter((role) =>
      role.capabilities.some((grant) => capabilityMatches(grant, 'reports:financial'))
    );
    expect(financial.map((role) => role.key)).toEqual(
      expect.arrayContaining(['owner', 'owner-operator', 'finance'])
    );
    for (const role of financial) {
      expect(
        role.capabilities.some((grant) => capabilityMatches(grant, 'reports:operational'))
      ).toBe(true);
    }
  });
});

describe('commercial packages (§13)', () => {
  it('defines the three restaurant packages, all restaurant-vertical', () => {
    expect(RESTAURANT_PACKAGES).toHaveLength(3);
    expect(RESTAURANT_PACKAGES.map((pkg) => pkg.key)).toEqual([
      'restaurant-essentials',
      'restaurant-operations',
      'restaurant-enterprise',
    ]);
    for (const pkg of RESTAURANT_PACKAGES) {
      expect(pkg.vertical).toBe('RESTAURANT');
    }
  });

  it('every package includes mandatory Restaurant Core and only real module keys', () => {
    for (const pkg of RESTAURANT_PACKAGES) {
      expect(pkg.moduleKeys).toContain('restaurant-core');
      for (const key of pkg.moduleKeys) {
        expect(isRestaurantModuleKey(key)).toBe(true);
      }
    }
  });

  it('Essentials caps locations at one branch (D10)', () => {
    const essentials = packageByKey('restaurant-essentials');
    expect(essentials?.defaultLimits['restaurant.locations.max']).toBe(1);
  });

  it('package tiers widen: Essentials ⊆ Operations ⊆ Enterprise modules', () => {
    const [essentials, operations, enterprise] = RESTAURANT_PACKAGES;
    expect(operations.moduleKeys.length).toBeGreaterThan(essentials.moduleKeys.length);
    expect(enterprise.moduleKeys).toHaveLength(RESTAURANT_MODULES.length);
    for (const key of essentials.moduleKeys) expect(operations.moduleKeys).toContain(key);
    for (const key of operations.moduleKeys) expect(enterprise.moduleKeys).toContain(key);
  });

  it('uses one high anti-abuse SOP template guardrail across every package', () => {
    expect(SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL).toBe(1000);
    for (const pkg of RESTAURANT_PACKAGES) {
      expect(pkg.defaultLimits['sop.templates.max']).toBe(SOP_TEMPLATE_ANTI_ABUSE_GUARDRAIL);
    }
  });

  it('every default limit uses a defined §7 limit key', () => {
    const validKeys = new Set(RESTAURANT_LIMIT_KEYS.map((limit) => limit.key));
    for (const pkg of RESTAURANT_PACKAGES) {
      for (const key of Object.keys(pkg.defaultLimits)) {
        expect(validKeys.has(key)).toBe(true);
      }
    }
  });

  it('packagesForVertical filters by vertical', () => {
    expect(packagesForVertical('RESTAURANT')).toEqual(RESTAURANT_PACKAGES);
    expect(packagesForVertical('PHARMACY')).toEqual(PHARMACY_PACKAGES);
    expect(packagesForVertical('AGENCY')).toEqual([]);
  });
});

describe('package compatibility (§2.3 / D10)', () => {
  it('is a single vertical-column equality', () => {
    expect(isPackageCompatibleWithVertical('RESTAURANT', 'RESTAURANT')).toBe(true);
    expect(isPackageCompatibleWithVertical('AGENCY', 'AGENCY')).toBe(true);
    expect(isPackageCompatibleWithVertical('PHARMACY', 'PHARMACY')).toBe(true);
    expect(isPackageCompatibleWithVertical('PHARMACY', 'RESTAURANT')).toBe(false);
    expect(isPackageCompatibleWithVertical('RESTAURANT', 'PHARMACY')).toBe(false);
    expect(isPackageCompatibleWithVertical('RESTAURANT', 'AGENCY')).toBe(false);
    expect(isPackageCompatibleWithVertical('AGENCY', 'RESTAURANT')).toBe(false);
  });

  it('assertPackageCompatibleWithVertical passes on a match', () => {
    expect(() => assertPackageCompatibleWithVertical('RESTAURANT', 'RESTAURANT')).not.toThrow();
  });

  it('assertPackageCompatibleWithVertical rejects a mismatch (server-side bypass guard)', () => {
    expect(() => assertPackageCompatibleWithVertical('RESTAURANT', 'AGENCY')).toThrow(
      /not compatible/
    );
    expect(() => assertPackageCompatibleWithVertical('AGENCY', 'RESTAURANT')).toThrow(
      /not compatible/
    );
  });
});

describe('pharmacy SOP grants (DEV-751)', () => {
  const SOP_ACTIONS = ['sop:manage', 'sop:complete', 'sop:verify'] as const;
  const grants = (key: string) => PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!;

  it('lists the generic SOP actions so pharmacy role editors can grant them', () => {
    for (const action of SOP_ACTIONS) expect(PHARMACY_CAPABILITIES).toContain(action);
  });

  it('never relies on `pharmacy:*` to reach the generic SOP actions', () => {
    for (const action of SOP_ACTIONS) {
      expect(capabilityMatches('pharmacy:*', action)).toBe(false);
      expect(capabilityMatches('*', action)).toBe(true);
    }
  });

  it.each([
    ['owner', ['sop:manage', 'sop:complete', 'sop:verify']],
    ['owner-operator', ['sop:manage', 'sop:complete', 'sop:verify']],
    ['manager', ['sop:manage', 'sop:complete', 'sop:verify']],
    ['pharmacist', ['sop:complete', 'sop:verify']],
    ['cashier', ['sop:complete']],
    ['inventory', ['sop:complete']],
    ['procurement', ['sop:complete']],
    ['finance', []],
    ['auditor', []],
  ])('grants %s exactly %j of the SOP actions', (key, expected) => {
    const role = grants(key);
    expect(
      SOP_ACTIONS.filter((action) =>
        role.capabilities.some((grant) => capabilityMatches(grant, action))
      )
    ).toEqual(expected);
  });

  it('SOP grants are only sop:* and never add, remove or reorder a pharmacy operation grant', () => {
    for (const grantsForRole of Object.values(PHARMACY_SOP_TEMPLATE_GRANTS)) {
      for (const grant of grantsForRole) expect(grant).toMatch(/^sop:(manage|complete|verify)$/);
    }
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      const appended = PHARMACY_SOP_TEMPLATE_GRANTS[role.key] ?? [];
      const base = role.capabilities.slice(0, role.capabilities.length - appended.length);
      expect(role.capabilities.slice(base.length)).toEqual(appended);
      // No operation grant (pharmacy:close, pharmacy:counter, …) comes from SOP.
      expect(base.some((grant) => grant.startsWith('sop:'))).toBe(false);
    }
  });

  it('grants no restaurant module or restaurant capability to a pharmacy role', () => {
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      expect(role.capabilities.some((grant) => grant.startsWith('restaurant'))).toBe(false);
    }
  });
});
