import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_PROCEDURES,
  MODULE_CATALOG,
  PROCEDURE_MODULES,
  ROUTE_MODULES,
  SOP_DEPTH_REQUIREMENTS,
  evaluateEntitlementRequirement,
  evaluateSopDepth,
  hasSopDepth,
  isModuleGranted,
  moduleForApiScope,
  moduleForPath,
  moduleForProcedure,
  sopDepthDenialMessage,
  verticalForModuleKey,
  type EntitlementSnapshot,
  type SopDepthCapability,
} from './module-catalog';
import {
  RESTAURANT_LIMIT_KEY_NAMES,
  RESTAURANT_MODULES,
  packageByKey,
  RESTAURANT_PACKAGES,
} from './vertical-catalog';

describe('module catalog routing', () => {
  it('uses the invitation entitlement for Team while retaining HR on details and stats', () => {
    expect(moduleForPath('/team')).toBe(moduleForProcedure('team.inviteMember'));
    expect(moduleForPath('/team/member-1')).toBe('hr');
    expect(moduleForPath('/team/stats')).toBe('hr');
  });
  it.each([
    ['projects.list', 'projects'],
    ['trelloImport.preview', 'projects'],
    ['team.updateRole', 'hr'],
    ['team.getNotifications', null],
    ['team.markNotificationRead', null],
    ['team.markAllNotificationsRead', null],
    ['finance.summary', 'finance'],
    ['apiTokens.create', 'api'],
    ['restaurantStaff.issueCredential', 'restaurant-core'],
    ['restaurantBranches.list', 'restaurant-core'],
    ['restaurantShifts.create', 'restaurant-core'],
    ['restaurantDevices.registerDevice', 'restaurant-core'],
    ['restaurantCatalog.listItems', 'restaurant-menu'],
    ['restaurantMenus.publishPublication', 'restaurant-menu'],
    ['restaurantPromotions.createOffer', 'restaurant-menu'],
    ['restaurantFloor.listFloors', 'restaurant-pos'],
    ['restaurantOrders.listOrders', 'restaurant-pos'],
    ['restaurantBills.listBills', 'restaurant-pos'],
    ['restaurantCash.listDrawerSessions', 'restaurant-pos'],
    ['restaurantPayments.listTenders', 'restaurant-pos'],
    ['restaurantTax.configuration', 'restaurant-pos'],
    // WHA-138 Lane A: inventory/purchasing gate on their own catalog modules,
    // not on POS.
    ['restaurantInventory.listStockOnHand', 'restaurant-inventory'],
    ['restaurantPurchasing.listPurchaseOrders', 'restaurant-purchasing'],
    ['restaurantJobs.listJobs', 'restaurant-sop'],
    ['restaurantSop.listTemplates', 'restaurant-sop'],
    ['restaurantSopExecution.listBoard', 'restaurant-sop'],
    ['restaurantNotifications.list', 'restaurant-core'],
    ['restaurantCustomers.list', 'restaurant-loyalty'],
    ['restaurantDelivery.listZones', 'restaurant-core'],
    ['restaurantLoyalty.readAccount', 'restaurant-loyalty'],
    ['restaurantInsights.listFinancialReports', 'restaurant-insights'],
    ['restaurantDashboard.getPreferences', 'restaurant-core'],
    ['restaurantGrowth.read', 'restaurant-core'],
    ['restaurantGrowth.review', 'restaurant-core'],
    ['unknown.list', null],
  ])('maps tRPC procedure %s to %s', (procedure, expected) => {
    expect(moduleForProcedure(procedure)).toBe(expected);
  });

  it('keeps the notification exception exact while the rest of team remains HR-gated', () => {
    expect(moduleForProcedure('team.getNotifications')).toBeNull();
    expect(moduleForProcedure('team.markNotificationRead')).toBeNull();
    expect(moduleForProcedure('team.markAllNotificationsRead')).toBeNull();
    expect(ACCOUNT_PROCEDURES.has('team.getNotifications')).toBe(false);
    expect(moduleForProcedure('team.getNotifications.future')).toBe('hr');
    expect(moduleForProcedure('team.deleteNotification')).toBe('hr');
  });

  it('pins every restaurant procedure namespace to its licensed module', () => {
    const restaurantEntries = Object.entries(PROCEDURE_MODULES).filter(([procedure]) =>
      procedure.startsWith('restaurant')
    );
    expect(Object.fromEntries(restaurantEntries)).toEqual({
      restaurantStaff: 'restaurant-core',
      restaurantBranches: 'restaurant-core',
      restaurantShifts: 'restaurant-core',
      restaurantDevices: 'restaurant-core',
      restaurantCatalog: 'restaurant-menu',
      restaurantMenuImport: 'restaurant-menu',
      restaurantMenus: 'restaurant-menu',
      restaurantPromotions: 'restaurant-menu',
      restaurantFloor: 'restaurant-pos',
      restaurantOrders: 'restaurant-pos',
      restaurantBills: 'restaurant-pos',
      restaurantCash: 'restaurant-pos',
      restaurantPayments: 'restaurant-pos',
      restaurantTax: 'restaurant-pos',
      restaurantInventory: 'restaurant-inventory',
      restaurantPurchasing: 'restaurant-purchasing',
      restaurantReports: 'restaurant-core',
      restaurantGrowth: 'restaurant-core',
      restaurantJobs: 'restaurant-sop',
      restaurantSop: 'restaurant-sop',
      restaurantSopExecution: 'restaurant-sop',
      restaurantNotifications: 'restaurant-core',
      restaurantCustomers: 'restaurant-loyalty',
      restaurantDelivery: 'restaurant-core',
      restaurantLoyalty: 'restaurant-loyalty',
      restaurantInsights: 'restaurant-insights',
      restaurantDashboard: 'restaurant-core',
    });
  });

  it('maps every procedure and route to a module in the production catalogs', () => {
    const catalogKeys = new Set(MODULE_CATALOG.map((module) => module.key));

    expect(Object.values(PROCEDURE_MODULES).filter((key) => !catalogKeys.has(key))).toEqual([]);
    expect(ROUTE_MODULES.map(([, key]) => key).filter((key) => !catalogKeys.has(key))).toEqual([]);
  });

  it.each([
    ['tasks:read', 'projects'],
    ['projects:write', 'projects'],
    ['team:read', 'hr'],
    ['clients:read', 'clients'],
    ['finance:read', 'finance'],
    ['unknown:read', null],
  ])('maps API scope %s to %s', (scope, expected) => {
    expect(moduleForApiScope(scope)).toBe(expected);
  });

  it('matches exact pages and descendants without matching lookalike prefixes', () => {
    expect(moduleForPath('/restaurant/growth')).toBe('restaurant-core');
    expect(moduleForPath('/team')).toBe('admin');
    expect(moduleForPath('/team/stats')).toBe('hr');
    expect(moduleForPath('/projects/project_123')).toBe('projects');
    expect(moduleForPath('/project-settings')).toBeNull();
    expect(moduleForPath('/organization')).toBeNull();
    expect(moduleForPath('/api-docs')).toBeNull();
  });

  it.each([
    ['/pharmacy/reports', 'pharmacy-reports'],
    ['/pharmacy/reports/repeat-purchasing', 'pharmacy-reports'],
    ['/pharmacy/finance', 'pharmacy-finance'],
    ['/pharmacy/inventory', 'pharmacy-inventory'],
    ['/pharmacy/purchasing', 'pharmacy-procurement'],
    ['/pharmacy/purchasing/receiving', 'pharmacy-procurement'],
    ['/pharmacy/purchasing/returns', 'pharmacy-procurement'],
    ['/pharmacy/purchasing/orders', 'pharmacy-procurement'],
    ['/pharmacy/purchasing/suppliers', 'pharmacy-procurement'],
    ['/pharmacy/medicines', 'pharmacy-core'],
    ['/pharmacy/orders', 'pharmacy-counter'],
  ])('resolves Pharmacy route %s to its existing licensed module %s', (route, module) => {
    for (const vertical of ['PHARMACY', 'RESTAURANT', 'AGENCY', undefined] as const) {
      expect(moduleForPath(route, vertical)).toBe(module);
    }
    expect(verticalForModuleKey(module)).toBe('PHARMACY');
  });

  it.each([
    '/pharmacy',
    '/pharmacy/insights',
    '/pharmacy/reports-archive',
    '/pharmacy/finance-settings',
    '/pharmacy/inventory-other',
    '/pharmacy/purchasing-returns',
  ])('preserves unmapped Pharmacy roots and lookalike siblings: %s', (route) => {
    expect(moduleForPath(route)).toBeNull();
  });

  it('keeps purchasing returns under the existing purchasing procedure license', () => {
    expect(moduleForPath('/pharmacy/purchasing/returns')).toBe(
      moduleForProcedure('pharmacyPurchasing.workspace')
    );
    expect(ROUTE_MODULES.filter(([route]) => route === '/pharmacy/purchasing')).toHaveLength(1);
  });

  it.each([
    ['/pharmacy/reports', 'pharmacy-reports'],
    ['/pharmacy/finance', 'pharmacy-finance'],
    ['/pharmacy/inventory', 'pharmacy-inventory'],
    ['/pharmacy/purchasing/returns', 'pharmacy-procurement'],
  ])('keeps direct-route licensing for %s independent of Chat', (route, module) => {
    const owner = moduleForPath(route);
    expect(owner).toBe(module);
    expect(isModuleGranted(owner!, [module])).toBe(true);
    expect(isModuleGranted(owner!, [module, 'chat'])).toBe(true);
    expect(isModuleGranted(owner!, ['pharmacy-core', 'chat'])).toBe(false);
    expect(isModuleGranted(owner!, [])).toBe(false);
  });

  // WHA-138 Lane A / plan §3 — every restaurant surface in the route table.
  it.each([
    ['/pos', 'restaurant-pos'],
    ['/pos/register', 'restaurant-pos'],
    ['/kds', 'restaurant-pos'],
    ['/kds/station_1', 'restaurant-pos'],
    ['/restaurant/floor', 'restaurant-pos'],
    ['/restaurant/delivery', 'restaurant-core'],
    ['/restaurant/orders', 'restaurant-pos'],
    ['/restaurant/orders/ord_123', 'restaurant-pos'],
    ['/restaurant/money', 'restaurant-pos'],
    ['/restaurant/tax', 'restaurant-pos'],
    ['/restaurant/inventory', 'restaurant-inventory'],
    ['/restaurant/purchasing', 'restaurant-purchasing'],
    ['/restaurant/sop', 'restaurant-sop'],
    ['/restaurant/sop/admin', 'restaurant-sop'],
    ['/restaurant/loyalty', 'restaurant-loyalty'],
    ['/restaurant/insights', 'restaurant-insights'],
    ['/restaurant/catalog', 'restaurant-menu'],
    ['/restaurant/menus', 'restaurant-menu'],
    ['/restaurant/promotions', 'restaurant-menu'],
    ['/restaurant/staff/roster', 'restaurant-core'],
    ['/restaurant/staff', 'restaurant-core'],
    ['/restaurant/devices', 'restaurant-core'],
    ['/restaurant/notifications', 'restaurant-core'],
    // The vertical catalog owns the `/restaurant` prefix via mandatory core.
    ['/restaurant', 'restaurant-core'],
    ['/restaurant/some-future-surface', 'restaurant-core'],
  ])('maps restaurant route %s to %s', (pathname, expected) => {
    expect(moduleForPath(pathname)).toBe(expected);
    // Restaurant routes never depend on the vertical argument.
    expect(moduleForPath(pathname, 'RESTAURANT')).toBe(expected);
  });

  it('does not match restaurant lookalike prefixes', () => {
    expect(moduleForPath('/postmortem')).toBeNull();
    expect(moduleForPath('/pos-settings')).toBeNull();
    expect(moduleForPath('/kds-view')).toBeNull();
    expect(moduleForPath('/restaurants')).toBeNull();
    expect(moduleForPath('/restaurant-admin')).toBeNull();
    expect(moduleForPath('/restaurant/inventory-x', 'RESTAURANT')).toBe('restaurant-core');
  });

  it('keeps the baseline dashboard independent of organization vertical', () => {
    expect(moduleForPath('/dashboard')).toBe('dashboard');
    expect(moduleForPath('/dashboard', 'AGENCY')).toBe('dashboard');
    expect(moduleForPath('/dashboard', 'RESTAURANT')).toBe('dashboard');
    expect(moduleForPath('/dashboard/widgets', 'RESTAURANT')).toBe('dashboard');
    expect(moduleForPath('/projects', 'RESTAURANT')).toBe('projects');
  });

  it('routes the menu-import console to the Menu and Costing module', () => {
    expect(moduleForPath('/restaurant/menu-import')).toBe('restaurant-menu');
    expect(moduleForPath('/restaurant/menu-import/import_123')).toBe('restaurant-menu');
    // A lookalike sibling must not inherit the import module; the restaurant
    // catalog's core catch-all still owns it.
    expect(moduleForPath('/restaurant/menu-imports-archive')).toBe('restaurant-core');
  });
});

describe('module vertical ownership', () => {
  it.each([
    ['restaurant-core', 'RESTAURANT'],
    ['restaurant-pos', 'RESTAURANT'],
    ['restaurant-integrations', 'RESTAURANT'],
  ])('maps restaurant module %s to %s', (key, expected) => {
    expect(verticalForModuleKey(key)).toBe(expected);
  });

  it.each([['agency-core'], ['projects'], ['finance']])(
    'maps agency module %s to AGENCY',
    (key) => {
      expect(verticalForModuleKey(key)).toBe('AGENCY');
    }
  );

  it.each([['dashboard'], ['hr'], ['not-a-real-module']])(
    'does not assign shared or unknown module %s to a vertical',
    (key) => expect(verticalForModuleKey(key)).toBeNull()
  );
});

// ---------------------------------------------------------------------------
// WHA-264 — SOP depth entitlement gating
// ---------------------------------------------------------------------------

/**
 * Build an entitlement snapshot the way `resolveOrganizationEntitlements` would
 * for an organization holding exactly one commercial package. The fixture reads
 * the catalog rather than restating module keys or limit values, so a repricing
 * moves these expectations through the catalog — which is the whole point of
 * gating on modules and limits instead of on a package key.
 */
function entitlementsForPackage(packageKey: string): EntitlementSnapshot {
  const pkg = packageByKey(packageKey);
  if (!pkg) throw new Error(`Unknown package ${packageKey}`);
  return { enabledModules: [...pkg.moduleKeys], limits: { ...pkg.defaultLimits } };
}

const ALL_SOP_DEPTHS = Object.keys(SOP_DEPTH_REQUIREMENTS) as SopDepthCapability[];

describe('entitlement requirement evaluation', () => {
  const snapshot: EntitlementSnapshot = {
    enabledModules: ['restaurant-sop'],
    limits: { 'sop.evidenceRetentionDays': 90 },
  };

  it('allows a requirement whose modules and limits are all satisfied', () => {
    expect(
      evaluateEntitlementRequirement(snapshot, {
        modules: ['restaurant-sop'],
        limits: [{ key: 'sop.evidenceRetentionDays', atLeast: 90 }],
      })
    ).toEqual({ allowed: true, missingModules: [], unmetLimits: [] });
  });

  it('denies and reports every missing module', () => {
    const result = evaluateEntitlementRequirement(snapshot, {
      modules: ['restaurant-sop', 'restaurant-insights', 'restaurant-integrations'],
      limits: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.missingModules).toEqual(['restaurant-insights', 'restaurant-integrations']);
  });

  it('fails closed on a limit key the organization was never granted', () => {
    const result = evaluateEntitlementRequirement(snapshot, {
      modules: [],
      limits: [{ key: 'restaurantInsights.retentionMonths', atLeast: 1 }],
    });
    expect(result.allowed).toBe(false);
    expect(result.unmetLimits).toEqual([
      { key: 'restaurantInsights.retentionMonths', required: 1, granted: 0 },
    ]);
  });

  it('treats the threshold as inclusive', () => {
    const at = evaluateEntitlementRequirement(snapshot, {
      modules: [],
      limits: [{ key: 'sop.evidenceRetentionDays', atLeast: 90 }],
    });
    const below = evaluateEntitlementRequirement(snapshot, {
      modules: [],
      limits: [{ key: 'sop.evidenceRetentionDays', atLeast: 91 }],
    });
    expect(at.allowed).toBe(true);
    expect(below.allowed).toBe(false);
  });
});

describe('SOP depth requirements are catalog-only', () => {
  const catalogModuleKeys = RESTAURANT_MODULES.map((module) => module.key);

  it.each(ALL_SOP_DEPTHS)('%s requires only real catalog module keys', (capability) => {
    for (const key of SOP_DEPTH_REQUIREMENTS[capability].modules) {
      expect(catalogModuleKeys).toContain(key);
    }
  });

  it.each(ALL_SOP_DEPTHS)('%s requires only real catalog limit keys', (capability) => {
    for (const limit of SOP_DEPTH_REQUIREMENTS[capability].limits) {
      expect(RESTAURANT_LIMIT_KEY_NAMES).toContain(limit.key);
    }
  });

  it('never names a commercial package', () => {
    const serialized = JSON.stringify(SOP_DEPTH_REQUIREMENTS);
    for (const pkg of RESTAURANT_PACKAGES) {
      expect(serialized).not.toContain(pkg.key);
      expect(serialized).not.toContain(pkg.name);
    }
  });

  it('gates every depth on the SOP module itself', () => {
    for (const capability of ALL_SOP_DEPTHS) {
      expect(SOP_DEPTH_REQUIREMENTS[capability].modules).toContain('restaurant-sop');
    }
  });
});

describe('SOP depth allow/deny across adjacent tiers', () => {
  // The commercial intent, asserted end-to-end through the catalog: entry-level
  // licensing runs SOPs; the mid tier adds the proof/verification/escalation
  // family; the top tier adds cross-branch reporting and retention/export.
  const MATRIX: Array<[string, Record<SopDepthCapability, boolean>]> = [
    [
      'restaurant-essentials',
      {
        'sop.execution': true,
        'sop.evidence': false,
        'sop.verification': false,
        'sop.waiver': false,
        'sop.escalation': false,
        'sop.crossBranchReporting': false,
        'sop.retentionExport': false,
      },
    ],
    [
      'restaurant-operations',
      {
        'sop.execution': true,
        'sop.evidence': true,
        'sop.verification': true,
        'sop.waiver': true,
        'sop.escalation': true,
        'sop.crossBranchReporting': false,
        'sop.retentionExport': false,
      },
    ],
    [
      'restaurant-enterprise',
      {
        'sop.execution': true,
        'sop.evidence': true,
        'sop.verification': true,
        'sop.waiver': true,
        'sop.escalation': true,
        'sop.crossBranchReporting': true,
        'sop.retentionExport': true,
      },
    ],
  ];

  it.each(MATRIX)('%s resolves the expected SOP depth', (packageKey, expected) => {
    const entitlements = entitlementsForPackage(packageKey);
    const actual = Object.fromEntries(
      ALL_SOP_DEPTHS.map((capability) => [capability, hasSopDepth(entitlements, capability)])
    );
    expect(actual).toEqual(expected);
  });

  it('is monotonic — a higher tier never loses a depth the tier below has', () => {
    const [entry, mid, top] = MATRIX.map(([key]) => entitlementsForPackage(key));
    for (const capability of ALL_SOP_DEPTHS) {
      if (hasSopDepth(entry, capability)) expect(hasSopDepth(mid, capability)).toBe(true);
      if (hasSopDepth(mid, capability)) expect(hasSopDepth(top, capability)).toBe(true);
    }
  });

  it('follows the limit catalog, not the package key: raising retention grants the proof family', () => {
    const entry = entitlementsForPackage('restaurant-essentials');
    expect(hasSopDepth(entry, 'sop.verification')).toBe(false);

    // A contract/override that lifts only the evidence-retention limit — the
    // same package key, a deeper SOP surface.
    const withAuditRetention: EntitlementSnapshot = {
      enabledModules: entry.enabledModules,
      limits: { ...entry.limits, 'sop.evidenceRetentionDays': 365 },
    };
    expect(hasSopDepth(withAuditRetention, 'sop.verification')).toBe(true);
    expect(hasSopDepth(withAuditRetention, 'sop.evidence')).toBe(true);
    expect(hasSopDepth(withAuditRetention, 'sop.waiver')).toBe(true);
    // …but not the depths that need modules it still does not hold.
    expect(hasSopDepth(withAuditRetention, 'sop.escalation')).toBe(false);
    expect(hasSopDepth(withAuditRetention, 'sop.crossBranchReporting')).toBe(false);
  });

  it('denies every depth when the SOP module itself is disabled', () => {
    const top = entitlementsForPackage('restaurant-enterprise');
    const withoutSop: EntitlementSnapshot = {
      enabledModules: top.enabledModules.filter((key) => key !== 'restaurant-sop'),
      limits: top.limits,
    };
    for (const capability of ALL_SOP_DEPTHS) {
      expect(hasSopDepth(withoutSop, capability)).toBe(false);
    }
  });

  it('denies every depth for an organization holding no restaurant modules', () => {
    const none: EntitlementSnapshot = { enabledModules: [], limits: {} };
    for (const capability of ALL_SOP_DEPTHS) {
      expect(hasSopDepth(none, capability)).toBe(false);
    }
  });
});

describe('SOP depth denial messages', () => {
  it('names the missing catalog keys and never a package', () => {
    const entry = entitlementsForPackage('restaurant-essentials');
    const result = evaluateSopDepth(entry, 'sop.escalation');
    const message = sopDepthDenialMessage('sop.escalation', result);

    expect(message).toContain('restaurant-integrations');
    expect(message).toContain('integrations.connections.max');
    for (const pkg of RESTAURANT_PACKAGES) {
      expect(message).not.toContain(pkg.key);
      expect(message).not.toContain(pkg.name);
    }
  });

  it('reports the granted value alongside the requirement', () => {
    const entry = entitlementsForPackage('restaurant-essentials');
    const message = sopDepthDenialMessage(
      'sop.verification',
      evaluateSopDepth(entry, 'sop.verification')
    );
    expect(message).toMatch(/sop\.evidenceRetentionDays of at least 365 \(granted 90\)/);
  });
});
