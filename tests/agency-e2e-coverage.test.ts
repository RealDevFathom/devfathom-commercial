import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const journey = readFileSync(resolve('tests/agency-e2e/agency-acceptance.spec.ts'), 'utf8');

describe('Agency required journey coverage', () => {
  test.each([
    ['/dashboard', 'onboarding and dashboard'],
    ['/clients', 'clients'],
    ['/projects', 'projects/tasks'],
    ['/team', 'team'],
    ['/organization', 'roles'],
    ['/meetings', 'meetings'],
    ['/finance', 'finance/invoices'],
    ['/team/stats', 'Insights/reports'],
    ['/settings', 'disabled integrations/settings'],
    ['/restaurant/orders', 'Restaurant leakage denial'],
  ])('contains required %s journey (%s)', (route) => {
    expect(journey).toContain(route);
  });

  test('contains no runtime skip or fixme', () => {
    expect(journey).not.toMatch(/test\.(?:skip|fixme)|\.skip\(/);
  });
});
