import { describe, expect, it } from 'vitest';

import {
  moduleForApiScope,
  moduleForPath,
  moduleForProcedure,
  verticalForModuleKey,
} from './module-catalog';

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
    ['unknown.list', null],
  ])('maps tRPC procedure %s to %s', (procedure, expected) => {
    expect(moduleForProcedure(procedure)).toBe(expected);
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
