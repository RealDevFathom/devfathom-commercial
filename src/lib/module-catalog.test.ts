import { describe, expect, it } from 'vitest';

import { PLATFORM_MODULES } from '../../prisma/production-bootstrap';

import {
  PROCEDURE_MODULES,
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
    ['restaurantMenus.publishPublication', 'restaurant-menu'],
    ['restaurantFloor.listFloors', 'restaurant-pos'],
    ['restaurantBills.listBills', 'restaurant-pos'],
    ['restaurantCash.listDrawerSessions', 'restaurant-pos'],
    ['restaurantPayments.listTenders', 'restaurant-pos'],
    ['restaurantCustomers.list', 'restaurant-loyalty'],
    ['restaurantLoyalty.readAccount', 'restaurant-loyalty'],
    ['restaurantInsights.listFinancialReports', 'restaurant-insights'],
    ['unknown.list', null],
  ])('maps tRPC procedure %s to %s', (procedure, expected) => {
    expect(moduleForProcedure(procedure)).toBe(expected);
  });

  it('maps every procedure to a module in the production catalogs', () => {
    const catalogKeys = new Set<string>([
      ...PLATFORM_MODULES.map(([key]) => key),
      ...RESTAURANT_MODULES.map((module) => module.key),
    ]);

    expect(Object.values(PROCEDURE_MODULES).filter((key) => !catalogKeys.has(key))).toEqual([]);
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
