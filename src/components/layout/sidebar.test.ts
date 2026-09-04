import { describe, expect, it } from 'vitest';
import { navigation, visibleNavigation } from './sidebar';

const restaurantRoutes = [
  '/pos',
  '/kds',
  '/restaurant/floor',
  '/restaurant/orders',
  '/restaurant/catering',
  '/restaurant/money',
  '/restaurant/inventory',
  '/restaurant/purchasing',
  '/restaurant/sop',
  '/restaurant/sop/admin',
  '/restaurant/loyalty',
  '/restaurant/insights',
];

describe('restaurant navigation', () => {
  it('defines the complete restaurant route group', () => {
    const routes = navigation
      .filter((item) => item.group === 'Restaurant')
      .map((item) => item.href);
    expect(routes).toEqual(expect.arrayContaining(restaurantRoutes));
  });

  it('derives visibility from effective module ownership for desktop and mobile consumers', () => {
    const visible = visibleNavigation(
      {
        vertical: 'RESTAURANT',
        enabledModules: ['restaurant-core', 'restaurant-inventory'],
      },
      'ADMIN'
    ).map((item) => item.href);

    expect(visible).toContain('/dashboard');
    expect(visible).toContain('/restaurant/inventory');
    expect(visible).toContain('/restaurant/staff');
    expect(visible).not.toContain('/restaurant/orders');
    expect(visible).not.toContain('/restaurant/purchasing');
    expect(visible).not.toContain('/restaurant/insights');

    const withInsights = visibleNavigation(
      {
        vertical: 'RESTAURANT',
        enabledModules: ['restaurant-core', 'restaurant-insights'],
      },
      'ADMIN'
    ).map((item) => item.href);
    expect(withInsights).toContain('/restaurant/insights');
  });

  it('keeps restaurant routes out of an Agency workspace', () => {
    const visible = visibleNavigation(
      { vertical: 'AGENCY', enabledModules: ['dashboard', 'projects'] },
      'ADMIN'
    );
    expect(visible.some((item) => item.group === 'Restaurant')).toBe(false);
  });

  it('names Restaurant finance, tax, purchasing, and entitled insights distinctly', () => {
    expect(navigation.find((item) => item.href === '/restaurant/money')?.label).toBe(
      'Finance & reconciliation'
    );
    expect(navigation.find((item) => item.href === '/restaurant/tax')?.label).toBe('Tax');
    expect(navigation.find((item) => item.href === '/restaurant/purchasing')?.label).toBe(
      'Purchasing'
    );
    expect(navigation.find((item) => item.href === '/restaurant/insights')?.label).toBe(
      'Advanced Insights'
    );
  });
});

describe('pharmacy navigation', () => {
  const pharmacyRoutes = ['/pharmacy', '/pharmacy/counter', '/pharmacy/regulatory'];

  it('hides pharmacy routes from a Restaurant admin despite mis-provisioned pharmacy modules', () => {
    const visible = visibleNavigation(
      {
        vertical: 'RESTAURANT',
        enabledModules: ['restaurant-core', 'pharmacy-core', 'pharmacy-counter'],
      },
      'ADMIN'
    ).map((item) => item.href);

    for (const route of pharmacyRoutes) {
      expect(visible).not.toContain(route);
    }
  });

  it('shows pharmacy routes to a Pharmacy admin with core and counter modules', () => {
    const visible = visibleNavigation(
      {
        vertical: 'PHARMACY',
        enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      },
      'ADMIN'
    ).map((item) => item.href);

    expect(visible).toEqual(expect.arrayContaining(pharmacyRoutes));
  });
});
