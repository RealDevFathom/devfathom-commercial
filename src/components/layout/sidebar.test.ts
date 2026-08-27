import { describe, expect, it } from 'vitest';
import { navigation, visibleNavigation } from './sidebar';

const restaurantRoutes = [
  '/pos',
  '/kds',
  '/restaurant/floor',
  '/restaurant/orders',
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
  });

  it('keeps restaurant routes out of an Agency workspace', () => {
    const visible = visibleNavigation(
      { vertical: 'AGENCY', enabledModules: ['dashboard', 'projects'] },
      'ADMIN'
    );
    expect(visible.some((item) => item.group === 'Restaurant')).toBe(false);
  });
});
