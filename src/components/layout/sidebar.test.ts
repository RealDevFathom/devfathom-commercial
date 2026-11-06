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

  it('links the menu-import console for admins holding the menu module, and hides it otherwise', () => {
    const forAdmin = visibleNavigation(
      { vertical: 'RESTAURANT', enabledModules: ['restaurant-core', 'restaurant-menu'] },
      'ADMIN'
    ).map((item) => item.href);
    expect(forAdmin).toContain('/restaurant/menu-import');

    // menu:import is admin-only (only `*`-bearing templates hold it), so a
    // non-admin must not see the link it could not use.
    const forEmployee = visibleNavigation(
      { vertical: 'RESTAURANT', enabledModules: ['restaurant-core', 'restaurant-menu'] },
      'EMPLOYEE'
    ).map((item) => item.href);
    expect(forEmployee).not.toContain('/restaurant/menu-import');

    // Without the menu module the entry is gone even for an admin.
    const withoutModule = visibleNavigation(
      { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      'ADMIN'
    ).map((item) => item.href);
    expect(withoutModule).not.toContain('/restaurant/menu-import');
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
  const operations = [
    ['/pharmacy/inventory', 'pharmacy-inventory'],
    ['/pharmacy/purchasing', 'pharmacy-procurement'],
    ['/pharmacy/finance', 'pharmacy-finance'],
    ['/pharmacy/reports', 'pharmacy-reports'],
  ] as const;
  /** What a manager holding procurement and operational reports is granted (#979). */
  const operatingCapabilities = ['pharmacy:procurement', 'reports:operational'];

  it.each(operations)(
    'shows %s only with its own license, independently of Chat',
    (route, module) => {
      const granted = visibleNavigation(
        { vertical: 'PHARMACY', enabledModules: [module] },
        'ADMIN',
        [],
        operatingCapabilities
      ).map((item) => item.href);
      expect(granted).toContain(route);
      expect(granted).not.toContain('/chat');
      for (const [otherRoute] of operations) {
        if (otherRoute !== route) expect(granted).not.toContain(otherRoute);
      }

      const denied = visibleNavigation(
        {
          vertical: 'PHARMACY',
          enabledModules: [
            'pharmacy-core',
            'chat',
            ...operations.map(([, key]) => key).filter((key) => key !== module),
          ],
        },
        'ADMIN',
        [],
        operatingCapabilities
      ).map((item) => item.href);
      expect(denied).not.toContain(route);
      expect(denied).toContain('/chat');
    }
  );

  it.each(['MEMBER', 'HR', undefined])(
    'keeps operational navigation available without granting admin-only finance to %s',
    (role) => {
      const visible = visibleNavigation(
        {
          vertical: 'PHARMACY',
          enabledModules: ['pharmacy-core', ...operations.map(([, module]) => module)],
        },
        role,
        [],
        operatingCapabilities
      ).map((item) => item.href);
      expect(visible).toEqual(
        expect.arrayContaining(['/pharmacy/inventory', '/pharmacy/purchasing', '/pharmacy/reports'])
      );
      for (const adminRoute of [
        '/pharmacy',
        '/pharmacy/medicines',
        '/pharmacy/regulatory',
        '/pharmacy/settings/branches',
        '/pharmacy/finance',
      ]) {
        expect(visible).not.toContain(adminRoute);
      }
    }
  );

  it.each(['RESTAURANT', 'AGENCY'] as const)(
    'hides every Pharmacy entry from %s even with all Pharmacy modules granted',
    (vertical) => {
      const visible = visibleNavigation(
        {
          vertical,
          enabledModules: [
            'pharmacy-core',
            'pharmacy-counter',
            'pharmacy-dispensing',
            'pharmacy-safety',
            ...operations.map(([, module]) => module),
          ],
        },
        'ADMIN'
      );
      expect(visible.filter((item) => item.group === 'Pharmacy')).toEqual([]);
    }
  );

  it('keeps reports on the existing route and does not invent an Insights destination', () => {
    expect(navigation.find((item) => item.href === '/pharmacy/reports')?.label).toBe(
      'Reports & Insights'
    );
    expect(navigation.some((item) => item.href === '/pharmacy/insights')).toBe(false);
  });

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

  it('hides the controlled register until the user holds pharmacy safety access', () => {
    const entitled = {
      vertical: 'PHARMACY' as const,
      enabledModules: ['pharmacy-core', 'pharmacy-safety'],
    };
    expect(
      visibleNavigation(entitled, 'EMPLOYEE').some(
        (item) => item.href === '/pharmacy/controlled-register'
      )
    ).toBe(false);
    expect(
      visibleNavigation(entitled, 'EMPLOYEE', [], ['pharmacy:safety']).some(
        (item) => item.href === '/pharmacy/controlled-register'
      )
    ).toBe(true);
  });

  it('shows day close only after the server grants day-close access', () => {
    const entitled = {
      vertical: 'PHARMACY' as const,
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
    };
    expect(
      visibleNavigation(entitled, 'ADMIN').some((item) => item.href === '/pharmacy/counter/close')
    ).toBe(false);
    expect(
      visibleNavigation(entitled, 'EMPLOYEE', [], ['pharmacy:close']).some(
        (item) => item.href === '/pharmacy/counter/close'
      )
    ).toBe(true);
  });

  describe('cashier exposure (#979)', () => {
    const everyPharmacyModule = {
      vertical: 'PHARMACY' as const,
      enabledModules: [
        'pharmacy-core',
        'pharmacy-counter',
        'pharmacy-dispensing',
        'pharmacy-safety',
        ...operations.map(([, module]) => module),
      ],
    };
    const withHr = {
      ...everyPharmacyModule,
      enabledModules: [...everyPharmacyModule.enabledModules, 'hr'],
    };
    const hrefs = (role: string, held: string[] = [], entitlements = everyPharmacyModule) =>
      visibleNavigation(entitlements, role, [], held).map((item) => item.href);
    const capabilityGated = [
      ['/pharmacy/purchasing', 'pharmacy:procurement'],
      ['/pharmacy/reports', 'reports:operational'],
      ['/pharmacy/prescriptions', 'pharmacy:prescriptions'],
      ['/pharmacy/pharmacist-queue', 'pharmacy:dispense'],
      ['/pharmacy/substitution', 'pharmacy:dispense'],
    ] as const;

    it('offers a cashier the counter but none of the surfaces their role cannot open', () => {
      const visible = hrefs('EMPLOYEE');
      expect(visible).toContain('/pharmacy/counter');
      for (const hidden of [
        '/pharmacy/counter/close',
        '/pharmacy/reports',
        '/pharmacy/prescriptions',
        '/pharmacy/pharmacist-queue',
        '/pharmacy/substitution',
        '/pharmacy/purchasing',
        '/team',
      ]) {
        expect(visible).not.toContain(hidden);
      }
    });

    it.each(capabilityGated)('shows %s once the user holds %s', (route, capability) => {
      expect(hrefs('EMPLOYEE')).not.toContain(route);
      expect(hrefs('EMPLOYEE', [capability])).toContain(route);
    });

    it.each(capabilityGated)('keeps %s from an administrator the engine refuses', (route) => {
      expect(hrefs('ADMIN')).not.toContain(route);
    });

    // DEV-739: Day close follows the server's dayCloseAccess answer, the only source
    // of 'pharmacy:close' in the rail, so a cashier still never meets a dead end.
    it('offers Day close only once the server grants it, to an administrator or a manager', () => {
      expect(hrefs('ADMIN')).not.toContain('/pharmacy/counter/close');
      expect(hrefs('ADMIN', ['pharmacy:close'])).toContain('/pharmacy/counter/close');
      expect(hrefs('EMPLOYEE', ['pharmacy:close'])).toContain('/pharmacy/counter/close');
    });

    it('shows Team to administrators, and to members only with the HR directory', () => {
      expect(hrefs('ADMIN')).toContain('/team');
      expect(hrefs('EMPLOYEE')).not.toContain('/team');
      expect(hrefs('EMPLOYEE', [], withHr)).toContain('/team');
    });

    it('leaves Team as it was for members of other products', () => {
      for (const vertical of ['AGENCY', 'RESTAURANT'] as const) {
        expect(
          visibleNavigation({ vertical, enabledModules: [] }, 'EMPLOYEE').map((item) => item.href)
        ).toContain('/team');
      }
    });
  });

  it('shows Procedures only with Pharmacy Safety and an SOP capability', () => {
    const entry = navigation.find((item) => item.href === '/pharmacy/sop');
    expect(entry).toMatchObject({
      label: 'Procedures',
      group: 'Pharmacy',
      module: 'pharmacy-safety',
      pharmacyCapabilities: ['pharmacy:sop'],
    });
    const entitled = {
      vertical: 'PHARMACY' as const,
      enabledModules: ['pharmacy-core', 'pharmacy-safety'],
    };
    const shows = (...args: Parameters<typeof visibleNavigation>) =>
      visibleNavigation(...args).some((item) => item.href === '/pharmacy/sop');

    expect(shows(entitled, 'ADMIN')).toBe(false);
    expect(shows(entitled, 'EMPLOYEE', [], ['pharmacy:safety'])).toBe(false);
    expect(shows(entitled, 'EMPLOYEE', [], ['pharmacy:sop'])).toBe(true);
    // The capability opens nothing without the module, nor in another vertical.
    expect(
      shows(
        { vertical: 'PHARMACY', enabledModules: ['pharmacy-core'] },
        'ADMIN',
        [],
        ['pharmacy:sop']
      )
    ).toBe(false);
    expect(
      shows(
        {
          vertical: 'RESTAURANT',
          enabledModules: ['restaurant-core', 'restaurant-sop', 'pharmacy-safety'],
        },
        'ADMIN',
        [],
        ['pharmacy:sop']
      )
    ).toBe(false);
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

describe('hospitality navigation', () => {
  const hotelModules = ['hotel-core', 'hotel-banquets', 'hotel-upsell'];
  const everyRailCapability = ['hotel:property-admin', 'hotel:rates', 'hotel:marketing'] as const;

  it('defines the hospitality group in setup order, each entry with the capability its page checks', () => {
    expect(
      navigation
        .filter((item) => item.group === 'Hospitality')
        .map((item) => [item.href, item.hotelCapabilities])
    ).toEqual([
      ['/hotel/settings/property', ['hotel:property-admin']],
      ['/hotel/settings/rooms', ['hotel:property-admin']],
      ['/hotel/settings/meal-plans', ['hotel:rates']],
      ['/hotel/settings/spaces', ['hotel:property-admin']],
      ['/hotel/settings/extras', ['hotel:property-admin']],
      ['/hotel/settings/journey', ['hotel:property-admin', 'hotel:marketing']],
    ]);
  });

  it('keeps restaurant and pharmacy entries out of a hospitality workspace holding every hotel capability', () => {
    const visible = visibleNavigation(
      {
        vertical: 'HOSPITALITY',
        enabledModules: [...hotelModules, 'restaurant-core', 'pharmacy-core', 'pharmacy-counter'],
      },
      'ADMIN',
      everyRailCapability
    );
    expect(
      visible.filter((item) => item.group === 'Restaurant' || item.group === 'Pharmacy')
    ).toEqual([]);
    expect(visible.filter((item) => item.group === 'Hospitality')).toHaveLength(6);
  });

  it.each(['RESTAURANT', 'PHARMACY', 'AGENCY'] as const)(
    'keeps every hospitality entry out of %s even with every hotel module and capability',
    (vertical) => {
      const visible = visibleNavigation(
        { vertical, enabledModules: hotelModules },
        'ADMIN',
        everyRailCapability
      );
      expect(visible.filter((item) => item.group === 'Hospitality')).toEqual([]);
    }
  );
});
