import { beforeEach, describe, expect, it, vi } from 'vitest';

const guards = vi.hoisted(() => ({
  hasModule: vi.fn((entitlements: { enabledModules: string[] }, moduleKey: string) =>
    entitlements.enabledModules.includes(moduleKey)
  ),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: guards.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import {
  DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE,
  restaurantDashboardRouter,
} from './restaurant-dashboard';

const db = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

function caller(options?: { enabledModules?: string[]; status?: string }) {
  return restaurantDashboardRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      enabledModules: options?.enabledModules ?? ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        role: 'ADMIN',
        status: options?.status ?? 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ preferences: null });
  db.user.update.mockResolvedValue({ id: 'user_1' });
});

describe('restaurant dashboard preferences', () => {
  it('returns the versioned allowlisted default for absent or malformed storage', async () => {
    await expect(caller().getPreferences()).resolves.toEqual(
      DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE
    );

    db.user.findUnique.mockResolvedValue({
      preferences: { restaurantDashboard: { version: 99, widgets: ['unknown'] } },
    });
    await expect(caller().getPreferences()).resolves.toEqual(
      DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE
    );
  });

  it('preserves every unrelated preference key when saving', async () => {
    const preference = {
      ...DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE,
      defaultBranchId: 'branch_1',
      rangeDays: 30 as const,
      widgets: DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE.widgets.map((widget) => ({ ...widget })),
    };
    db.user.findUnique.mockResolvedValue({
      preferences: { appearance: { density: 'compact' }, hiddenWidgets: ['activity'] },
    });

    await expect(caller().updatePreferences(preference)).resolves.toEqual(preference);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: {
        preferences: {
          appearance: { density: 'compact' },
          hiddenWidgets: ['activity'],
          restaurantDashboard: preference,
        },
      },
    });
  });

  it('rejects unknown, missing, and duplicate widget keys', async () => {
    const invalid = {
      ...DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE,
      widgets: DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE.widgets.map((widget, index) => ({
        ...widget,
        key: index === 0 ? 'unknown' : widget.key,
      })),
    };
    await expect(caller().updatePreferences(invalid as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const duplicate = {
      ...DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE,
      widgets: DEFAULT_RESTAURANT_DASHBOARD_PREFERENCE.widgets.map((widget, index) => ({
        ...widget,
        key: index === 0 ? 'trend' : widget.key,
      })),
    };
    await expect(caller().updatePreferences(duplicate)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('fails closed without an active session', async () => {
    await expect(caller({ status: 'SUSPENDED' }).getPreferences()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});
