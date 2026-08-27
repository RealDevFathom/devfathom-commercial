import { describe, expect, it } from 'vitest';

import { PLATFORM_MODULES } from '../../prisma/production-bootstrap';

import {
  PROCEDURE_MODULES,
  ROUTE_MODULES,
  moduleForApiScope,
  moduleForPath,
  moduleForProcedure,
  verticalForModuleKey,
} from './module-catalog';
import { RESTAURANT_MODULES } from './vertical-catalog';

describe('module catalog routing', () => {
  it.each([
    ['projects.list', 'projects'],
    ['trelloImport.preview', 'projects'],
    ['team.updateRole', 'hr'],
    ['finance.summary', 'finance'],
    ['apiTokens.create', 'api'],
    ['restaurantStaff.issueCredential', 'restaurant-core'],
    ['restaurantDevices.registerDevice', 'restaurant-core'],
    ['restaurantCatalog.listItems', 'restaurant-menu'],
    ['restaurantMenus.publishPublication', 'restaurant-menu'],
    ['restaurantFloor.listFloors', 'restaurant-pos'],
    ['restaurantOrders.listOrders', 'restaurant-pos'],
    ['restaurantBills.listBills', 'restaurant-pos'],
    ['restaurantCash.listDrawerSessions', 'restaurant-pos'],
    ['restaurantPayments.listTenders', 'restaurant-pos'],
    // WHA-138 Lane A: inventory/purchasing gate on their own catalog modules,
    // not on POS.
    ['restaurantInventory.listStockOnHand', 'restaurant-inventory'],
    ['restaurantPurchasing.listPurchaseOrders', 'restaurant-purchasing'],
    ['restaurantJobs.listJobs', 'restaurant-sop'],
    ['restaurantSop.listTemplates', 'restaurant-sop'],
    ['restaurantSopExecution.listBoard', 'restaurant-sop'],
    ['restaurantNotifications.list', 'restaurant-core'],
    ['restaurantCustomers.list', 'restaurant-loyalty'],
    ['restaurantLoyalty.readAccount', 'restaurant-loyalty'],
    ['restaurantInsights.listFinancialReports', 'restaurant-insights'],
    ['unknown.list', null],
  ])('maps tRPC procedure %s to %s', (procedure, expected) => {
    expect(moduleForProcedure(procedure)).toBe(expected);
  });

  it('pins every restaurant procedure namespace to its licensed module', () => {
    const restaurantEntries = Object.entries(PROCEDURE_MODULES).filter(([procedure]) =>
      procedure.startsWith('restaurant')
    );
    expect(Object.fromEntries(restaurantEntries)).toEqual({
      restaurantStaff: 'restaurant-core',
      restaurantDevices: 'restaurant-core',
      restaurantCatalog: 'restaurant-menu',
      restaurantMenuImport: 'restaurant-menu',
      restaurantMenus: 'restaurant-menu',
      restaurantFloor: 'restaurant-pos',
      restaurantOrders: 'restaurant-pos',
      restaurantBills: 'restaurant-pos',
      restaurantCash: 'restaurant-pos',
      restaurantPayments: 'restaurant-pos',
      restaurantInventory: 'restaurant-inventory',
      restaurantPurchasing: 'restaurant-purchasing',
      restaurantJobs: 'restaurant-sop',
      restaurantSop: 'restaurant-sop',
      restaurantSopExecution: 'restaurant-sop',
      restaurantNotifications: 'restaurant-core',
      restaurantCustomers: 'restaurant-loyalty',
      restaurantLoyalty: 'restaurant-loyalty',
      restaurantInsights: 'restaurant-insights',
    });
  });

  it('maps every procedure and route to a module in the production catalogs', () => {
    const catalogKeys = new Set<string>([
      ...PLATFORM_MODULES.map(([key]) => key),
      ...RESTAURANT_MODULES.map((module) => module.key),
    ]);

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
    expect(moduleForPath('/team')).toBe('hr');
    expect(moduleForPath('/team/stats')).toBe('hr');
    expect(moduleForPath('/projects/project_123')).toBe('projects');
    expect(moduleForPath('/project-settings')).toBeNull();
    expect(moduleForPath('/organization')).toBeNull();
    expect(moduleForPath('/api-docs')).toBeNull();
  });

  // WHA-138 Lane A / plan §3 — every restaurant surface in the route table.
  it.each([
    ['/pos', 'restaurant-pos'],
    ['/pos/register', 'restaurant-pos'],
    ['/kds', 'restaurant-pos'],
    ['/kds/station_1', 'restaurant-pos'],
    ['/restaurant/floor', 'restaurant-pos'],
    ['/restaurant/orders', 'restaurant-pos'],
    ['/restaurant/orders/ord_123', 'restaurant-pos'],
    ['/restaurant/money', 'restaurant-pos'],
    ['/restaurant/inventory', 'restaurant-inventory'],
    ['/restaurant/purchasing', 'restaurant-purchasing'],
    ['/restaurant/sop', 'restaurant-sop'],
    ['/restaurant/sop/admin', 'restaurant-sop'],
    ['/restaurant/loyalty', 'restaurant-loyalty'],
    ['/restaurant/insights', 'restaurant-insights'],
    ['/restaurant/catalog', 'restaurant-menu'],
    ['/restaurant/menus', 'restaurant-menu'],
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

  // §3 — the Dashboard surface is vertical-dispatched: mandatory core for a
  // restaurant organization, the Agency dashboard module otherwise (including
  // legacy callers that pass no vertical).
  it('dispatches the dashboard route by organization vertical', () => {
    expect(moduleForPath('/dashboard')).toBe('dashboard');
    expect(moduleForPath('/dashboard', 'AGENCY')).toBe('dashboard');
    expect(moduleForPath('/dashboard', 'RESTAURANT')).toBe('restaurant-core');
    expect(moduleForPath('/dashboard/widgets', 'RESTAURANT')).toBe('restaurant-core');
    // Only the dashboard entry is vertical-dispatched; agency surfaces keep
    // their module regardless of the caller's vertical.
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

  it.each([['dashboard'], ['projects'], ['finance'], ['hr'], ['not-a-real-module']])(
    'treats non-restaurant module %s as AGENCY',
    (key) => {
      expect(verticalForModuleKey(key)).toBe('AGENCY');
    }
  );
});
