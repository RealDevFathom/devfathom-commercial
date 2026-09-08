import { describe, expect, it } from 'vitest';

import {
  ALL_VERTICALS,
  AGENCY_MODULES,
  AGENCY_ROLE_TEMPLATES,
  AGENCY_DEPARTMENTS,
  HOSPITALITY_CAPABILITIES,
  HOSPITALITY_CAPABILITY_NAMESPACES,
  HOSPITALITY_DEPARTMENTS,
  HOSPITALITY_LIMIT_KEYS,
  HOSPITALITY_MODULES,
  HOSPITALITY_PACKAGES,
  HOSPITALITY_ROLE_TEMPLATES,
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
});

describe('hospitality registry (H1-01)', () => {
  it('registers the core module, the optional set, limits, departments and role keys', () => {
    expect(HOSPITALITY_MODULES).toHaveLength(15);
    expect(
      HOSPITALITY_MODULES.filter((module) => module.mandatory).map((module) => module.key)
    ).toEqual(['hotel-core']);
    for (const entry of HOSPITALITY_MODULES) {
      expect(entry.vertical).toBe('HOSPITALITY');
      expect(entry.routePrefix.startsWith('/hotel')).toBe(true);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
    }
    const keys = HOSPITALITY_MODULES.map((module) => module.key);
    expect(new Set(keys).size).toBe(keys.length);

    expect(HOSPITALITY_LIMIT_KEYS.map((limit) => limit.key)).toEqual([
      'hotel.properties.max',
      'hotel.rooms.max',
      'hotel.users.max',
    ]);
    expect(HOSPITALITY_DEPARTMENTS.map((department) => department.key)).toEqual([
      'FRONT_OFFICE',
      'HOUSEKEEPING',
      'MAINTENANCE',
      'FOOD_AND_BEVERAGE',
      'SALES_AND_EVENTS',
      'FINANCE',
    ]);
    expect(modulesForVertical('HOSPITALITY')).toEqual(HOSPITALITY_MODULES);
    expect(limitKeysForVertical('HOSPITALITY')).toEqual(HOSPITALITY_LIMIT_KEYS);
    expect(departmentsForVertical('HOSPITALITY')).toEqual(HOSPITALITY_DEPARTMENTS);
    expect(mandatoryModulesForVertical('HOSPITALITY').map((module) => module.key)).toEqual([
      'hotel-core',
    ]);
  });

  it('declares exactly the nineteen capabilities of 06 §1, in one namespace', () => {
    expect(HOSPITALITY_CAPABILITIES).toEqual([
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
    ]);
    expect(new Set(HOSPITALITY_CAPABILITIES).size).toBe(19);
    for (const capability of HOSPITALITY_CAPABILITIES) {
      expect(HOSPITALITY_CAPABILITY_NAMESPACES).toContain(capability.split(':')[0]);
    }
  });

  it('defines the fifteen role templates of 06 §2 and draws every grant from the catalog', () => {
    expect(HOSPITALITY_ROLE_TEMPLATES).toHaveLength(15);
    expect(HOSPITALITY_ROLE_TEMPLATES.map((role) => role.key)).toEqual([
      'owner',
      'general-manager',
      'front-office-manager',
      'front-desk-agent',
      'reservations-agent',
      'night-auditor',
      'housekeeping-supervisor',
      'housekeeper',
      'maintenance-technician',
      'maintenance-manager',
      'accounts-ar',
      'sales-events',
      'revenue-marketing-manager',
      'read-only-auditor',
      'partner-api-key',
    ]);
    expect(roleTemplatesForVertical('HOSPITALITY')).toEqual(HOSPITALITY_ROLE_TEMPLATES);
    for (const role of HOSPITALITY_ROLE_TEMPLATES) {
      for (const capability of role.capabilities) {
        if (capability === '*') continue;
        expect(HOSPITALITY_CAPABILITIES).toContain(capability);
      }
      // A template never repeats a grant; a duplicate would hide a merge slip.
      expect(new Set(role.capabilities).size).toBe(role.capabilities.length);
    }
  });

  it('gives only Owner and General Manager the whole surface', () => {
    const roleFor = (key: string) => HOSPITALITY_ROLE_TEMPLATES.find((role) => role.key === key)!;
    expect(roleFor('owner').capabilities).toEqual(['*']);
    expect(roleFor('general-manager').capabilities).toEqual([...HOSPITALITY_CAPABILITIES]);
    for (const role of HOSPITALITY_ROLE_TEMPLATES.filter(
      (candidate) => !['owner', 'general-manager'].includes(candidate.key)
    )) {
      expect(role.capabilities).not.toContain('*');
      expect(role.capabilities.length).toBeLessThan(HOSPITALITY_CAPABILITIES.length);
    }
  });

  it('withholds every capability from the two rows 06 §2 flags as over-grantable', () => {
    const roleFor = (key: string) => HOSPITALITY_ROLE_TEMPLATES.find((role) => role.key === key)!;
    expect(roleFor('read-only-auditor').capabilities).toEqual([]);
    expect(roleFor('partner-api-key').capabilities).toEqual([]);
  });

  it('separates reservations from folio adjustment across the matrix', () => {
    const roleFor = (key: string) => HOSPITALITY_ROLE_TEMPLATES.find((role) => role.key === key)!;
    // The desk takes reservations and posts to a folio, but never adjusts one.
    expect(roleFor('front-desk-agent').capabilities).toContain('hotel:reservations');
    expect(roleFor('front-desk-agent').capabilities).toContain('hotel:folio');
    expect(roleFor('front-desk-agent').capabilities).not.toContain('hotel:folio-adjust');
    // The auditor adjusts and never sells.
    expect(roleFor('night-auditor').capabilities).toContain('hotel:folio-adjust');
    expect(roleFor('night-auditor').capabilities).not.toContain('hotel:reservations');

    const adjusters = HOSPITALITY_ROLE_TEMPLATES.filter(
      (role) => role.capabilities.includes('*') || role.capabilities.includes('hotel:folio-adjust')
    ).map((role) => role.key);
    expect(adjusters).toEqual([
      'owner',
      'general-manager',
      'front-office-manager',
      'night-auditor',
    ]);
  });

  it('never grants property administration outside the two management roles', () => {
    const holders = HOSPITALITY_ROLE_TEMPLATES.filter(
      (role) =>
        role.capabilities.includes('*') || role.capabilities.includes('hotel:property-admin')
    ).map((role) => role.key);
    expect(holders).toEqual(['owner', 'general-manager']);
  });

  it('composes Essentials, Pro, Chain and Venue through the module model (GTM-01)', () => {
    expect(HOSPITALITY_PACKAGES.map((pkg) => pkg.key)).toEqual([
      'hotel-essentials',
      'hotel-pro',
      'hotel-chain',
      'hotel-venue',
    ]);
    for (const pkg of HOSPITALITY_PACKAGES) {
      expect(pkg.vertical).toBe('HOSPITALITY');
      // Mandatory Hotel Core is in every package, and no package names a module
      // key that is not in the registry.
      expect(pkg.moduleKeys).toContain('hotel-core');
      for (const key of pkg.moduleKeys) {
        expect(HOSPITALITY_MODULES.map((module) => module.key)).toContain(key);
      }
      const limitKeys = HOSPITALITY_LIMIT_KEYS.map((limit) => limit.key);
      for (const key of Object.keys(pkg.defaultLimits)) {
        expect(limitKeys).toContain(key);
      }
    }
    expect(packagesForVertical('HOSPITALITY')).toEqual(HOSPITALITY_PACKAGES);
    expect(packageByKey('hotel-venue')?.name).toBe('Hotel Venue');
  });

  it('widens Essentials ⊆ Pro ⊆ Chain and keeps Venue free of room modules', () => {
    const [essentials, pro, chain, venue] = HOSPITALITY_PACKAGES;
    expect(essentials.moduleKeys).toEqual([
      'hotel-core',
      'hotel-reservations',
      'hotel-front-desk',
      'hotel-folio',
      'hotel-payments',
      'hotel-night-audit',
      'hotel-reports',
    ]);
    for (const key of essentials.moduleKeys) expect(pro.moduleKeys).toContain(key);
    for (const key of pro.moduleKeys) expect(chain.moduleKeys).toContain(key);
    expect(pro.moduleKeys).toContain('hotel-channels');
    expect(pro.moduleKeys).toContain('hotel-upsell');
    expect(pro.moduleKeys).toContain('hotel-marketing');
    expect(pro.moduleKeys).toContain('hotel-agents');
    expect(pro.moduleKeys).toContain('hotel-maintenance');
    expect(pro.moduleKeys).toContain('hotel-api');
    expect(chain.moduleKeys).toContain('hotel-crs');
    expect(pro.moduleKeys).not.toContain('hotel-crs');

    // MODE-05: a VENUE property has no availability days, so the package sells
    // banquets and carries none of the room surfaces.
    expect(venue.moduleKeys).toContain('hotel-banquets');
    for (const roomModule of [
      'hotel-reservations',
      'hotel-front-desk',
      'hotel-channels',
      'hotel-upsell',
      'hotel-crs',
    ]) {
      expect(venue.moduleKeys).not.toContain(roomModule);
    }
    expect(venue.defaultLimits['hotel.rooms.max']).toBe(0);
    // Only Chain licenses more than a handful of properties.
    expect(essentials.defaultLimits['hotel.properties.max']).toBe(1);
    expect(chain.defaultLimits['hotel.properties.max']).toBeGreaterThan(
      pro.defaultLimits['hotel.properties.max']!
    );
    // Banquets is a Venue module; the room-first packages do not carry it.
    for (const pkg of [essentials, pro, chain]) {
      expect(pkg.moduleKeys).not.toContain('hotel-banquets');
    }
  });

  it('keeps hospitality packages incompatible with every other vertical', () => {
    expect(isPackageCompatibleWithVertical('HOSPITALITY', 'HOSPITALITY')).toBe(true);
    for (const other of ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const) {
      expect(isPackageCompatibleWithVertical('HOSPITALITY', other)).toBe(false);
      expect(isPackageCompatibleWithVertical(other, 'HOSPITALITY')).toBe(false);
    }
    expect(() => assertPackageCompatibleWithVertical('HOSPITALITY', 'PHARMACY')).toThrow(
      /not compatible/
    );
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
