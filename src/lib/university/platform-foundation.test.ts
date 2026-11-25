import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS, POLICIES, type Action } from '@/lib/abac/policies';
import {
  moduleForApiScope,
  moduleForPath,
  verticalBaselineModules,
  verticalForModuleKey,
} from '@/lib/module-catalog';
import {
  UNIVERSITY_MODULES,
  UNIVERSITY_PACKAGES,
  inviteRoleRefusal,
  mandatoryModulesForVertical,
  packageByKey,
  packageDefaultSeats,
  roleTemplatesForVertical,
  isPackageCompatibleWithVertical,
} from '@/lib/vertical-catalog';

describe('university commercial foundation', () => {
  it('resolves each office independently of its parent route', () => {
    for (const definition of UNIVERSITY_MODULES) {
      expect(moduleForPath(definition.routePrefix)).toBe(definition.key);
      expect(moduleForPath(definition.routePrefix + '/record')).toBe(definition.key);
      expect(verticalForModuleKey(definition.key)).toBe('UNIVERSITY');
    }
    expect(moduleForPath('/university/student-support/advising')).toBe('university-academics');
    expect(moduleForPath('/university/community')).toBe('university-services');
    expect(moduleForPath('/university/imports')).toBe('university-core');
    expect(moduleForPath('/university-other')).toBeNull();
    expect(moduleForApiScope('university:integrations:read')).toBe('university-core');
    expect(moduleForApiScope('university:integrations:write')).toBe('university-core');
    expect(moduleForApiScope('university:other:write')).toBeNull();
  });
  it('publishes one integrated suite with different limits for staff and enrolled students', () => {
    const [suite] = UNIVERSITY_PACKAGES;
    expect(packageByKey(suite.key)).toEqual(suite);
    expect(packageDefaultSeats(suite)).toBe(250);
    expect(suite.defaultLimits['university.activeStudents.max']).toBe(25000);
    expect(suite.moduleKeys).toEqual(
      expect.arrayContaining(UNIVERSITY_MODULES.map((module) => module.key))
    );
    expect(mandatoryModulesForVertical('UNIVERSITY').map((module) => module.key)).toEqual([
      'university-core',
    ]);
    expect(verticalBaselineModules('UNIVERSITY')).toContain('audit');
    expect(isPackageCompatibleWithVertical(suite.vertical, 'AGENCY')).toBe(false);
  });
  it('grants staff office roles without turning learners into employee roles', () => {
    const roles = roleTemplatesForVertical('UNIVERSITY');
    expect(roles.map((role) => role.key)).toContain('university-finance-approver');
    expect(roles.some((role) => /student|applicant|alumni/.test(role.key))).toBe(false);
    expect(new Set(roles.map((role) => role.key)).size).toBe(roles.length);
    for (const role of roles.filter((role) => role.key !== 'university-admin')) {
      for (const capability of role.capabilities) {
        expect(ALL_ACTIONS).toContain(capability);
        expect(POLICIES[capability as Action]).toEqual([]);
      }
    }
    expect(inviteRoleRefusal('UNIVERSITY', 'EMPLOYEE', 'university-instructor')).toBeNull();
    expect(inviteRoleRefusal('UNIVERSITY', 'ADMIN', 'university-instructor')).not.toBeNull();
  });
});
