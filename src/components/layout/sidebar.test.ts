import { describe, expect, it } from 'vitest';
import { navigation, visibleNavigation } from './sidebar';
import {
  NO_PHARMACY_STAFF_ACCESS,
  type PharmacyStaffAccess,
} from '@/lib/pharmacy/staff-access-flags';

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

  it.each(operations)(
    'shows %s only with its own license, independently of Chat',
    (route, module) => {
      const granted = visibleNavigation(
        { vertical: 'PHARMACY', enabledModules: [module] },
        'ADMIN'
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
        'ADMIN'
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
        role
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

  it('hides Prescriptions, Pharmacist queue and Substitution without a dispense or safety capability', () => {
    const entitled = {
      vertical: 'PHARMACY' as const,
      enabledModules: ['pharmacy-core', 'pharmacy-dispensing'],
    };
    const clinical = [
      '/pharmacy/prescriptions',
      '/pharmacy/pharmacist-queue',
      '/pharmacy/substitution',
    ];
    const hrefs = (capabilities: string[]) =>
      visibleNavigation(entitled, 'EMPLOYEE', [], capabilities).map((item) => item.href);

    // Module alone (e.g. a cashier or manager) is not enough.
    for (const route of clinical) expect(hrefs([])).not.toContain(route);
    const cashier = hrefs(['pharmacy:counter', 'pharmacy:orders']);
    for (const route of clinical) expect(cashier).not.toContain(route);
    // A pharmacist (dispense) or a safety holder sees all three.
    expect(hrefs(['pharmacy:dispense'])).toEqual(expect.arrayContaining(clinical));
    expect(hrefs(['pharmacy:safety'])).toEqual(expect.arrayContaining(clinical));
    // Prescription-records access alone opens only the prescription workspace.
    const records = hrefs(['pharmacy:prescriptions']);
    expect(records).toContain('/pharmacy/prescriptions');
    expect(records).not.toContain('/pharmacy/pharmacist-queue');
    expect(records).not.toContain('/pharmacy/substitution');
  });

  describe('menu by role: only what each role can use', () => {
    const entitled = {
      vertical: 'PHARMACY' as const,
      enabledModules: [
        'pharmacy-core',
        'pharmacy-counter',
        'pharmacy-inventory',
        'pharmacy-procurement',
        'pharmacy-reports',
        'pharmacy-dispensing',
      ],
    };
    const gated = [
      '/pharmacy/counter/close',
      '/pharmacy/reports',
      '/pharmacy/purchasing',
      '/pharmacy/prescriptions',
      '/pharmacy/pharmacist-queue',
      '/pharmacy/substitution',
      '/team',
      '/settings',
    ];
    const roles: Array<[string, string, Partial<PharmacyStaffAccess>, string[], string[]]> = [
      [
        'owner',
        'ADMIN',
        {
          commandCentre: true,
          dayClose: true,
          reports: true,
          purchasing: true,
          administration: true,
          prescriptions: true,
        },
        ['pharmacy:prescriptions'],
        [
          '/pharmacy/counter/close',
          '/pharmacy/reports',
          '/pharmacy/purchasing',
          '/pharmacy/prescriptions',
          '/team',
          '/settings',
        ],
      ],
      [
        'manager',
        'EMPLOYEE',
        {
          commandCentre: true,
          dayClose: true,
          reports: true,
          purchasing: true,
          administration: true,
        },
        [],
        [
          '/pharmacy/counter/close',
          '/pharmacy/reports',
          '/pharmacy/purchasing',
          '/team',
          '/settings',
        ],
      ],
      [
        'manager without close or report grants',
        'EMPLOYEE',
        { commandCentre: true, purchasing: true, administration: true },
        [],
        ['/pharmacy/purchasing', '/team', '/settings'],
      ],
      [
        'pharmacist',
        'EMPLOYEE',
        { dayClose: true, dispense: true, prescriptions: true },
        ['pharmacy:dispense', 'pharmacy:prescriptions'],
        [
          '/pharmacy/counter/close',
          '/pharmacy/prescriptions',
          '/pharmacy/pharmacist-queue',
          '/pharmacy/substitution',
        ],
      ],
      ['cashier', 'EMPLOYEE', {}, [], []],
    ];

    it.each(roles)(
      'offers the %s (%s) exactly the gated entries it can use',
      (_persona, role, access, capabilities, expected) => {
        const visible = visibleNavigation(entitled, role, [], capabilities, {
          ...NO_PHARMACY_STAFF_ACCESS,
          ...access,
        }).map((item) => item.href);
        expect(gated.filter((href) => visible.includes(href)).sort()).toEqual([...expected].sort());
        // Counter and Inventory stay for every role (the pharmacist's counter is unchanged).
        expect(visible).toEqual(
          expect.arrayContaining(['/pharmacy/counter', '/pharmacy/inventory'])
        );
      }
    );

    it('leaves Team and Settings alone outside a Pharmacy workspace', () => {
      const visible = visibleNavigation(
        { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
        'EMPLOYEE',
        [],
        [],
        NO_PHARMACY_STAFF_ACCESS
      ).map((item) => item.href);
      expect(visible).toEqual(expect.arrayContaining(['/team', '/settings']));
    });
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
