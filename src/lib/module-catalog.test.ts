import { describe, expect, it } from 'vitest';

import { moduleForApiScope, moduleForPath, moduleForProcedure } from './module-catalog';

describe('module catalog routing', () => {
  it.each([
    ['projects.list', 'projects'],
    ['trelloImport.preview', 'projects'],
    ['team.updateRole', 'hr'],
    ['finance.summary', 'finance'],
    ['apiTokens.create', 'api'],
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
