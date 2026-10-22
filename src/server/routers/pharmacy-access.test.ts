import { describe, expect, it, vi } from 'vitest';

import { can, subjectFromSession, type CustomPermissionRule } from '@/lib/abac';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { protectedProcedure, router, type TRPCContext } from '../trpc';

const PHARMACY_RAIL_CAPABILITIES = [
  'pharmacy:counter',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'pharmacy:orders',
  'pharmacy:dispense',
  'pharmacy:safety',
  'reports:operational',
  'reports:financial',
] as const;

const pharmacyAccessRouter = router({
  navigation: protectedProcedure.query(async ({ ctx }) => {
    const subject = subjectFromSession(ctx.session.user);
    const decisions = await Promise.all(
      PHARMACY_RAIL_CAPABILITIES.map(async (capability) => ({
        capability,
        allowed: await can(subject, capability, undefined, { db: ctx.db, source: 'TRPC' }),
      }))
    );
    return decisions.flatMap(({ capability, allowed }) => (allowed ? [capability] : []));
  }),
});

function caller(overrides: CustomPermissionRule[], rolePermissions: CustomPermissionRule[]) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: rolePermissions },
        permissionOverrides: overrides,
      }),
    },
  };

  const context: TRPCContext = {
    db: db as unknown as TRPCContext['db'],
    entitlements: {
      organizationId: 'org-1',
      vertical: 'PHARMACY',
      seatLimit: 10,
      activeSeats: 1,
      enabledModules: ['pharmacy-core'],
      modules: [
        {
          key: 'pharmacy-core',
          name: 'Pharmacy Core',
          enabled: true,
          source: 'BASELINE',
          seatLimit: null,
          expiresAt: null,
        },
      ],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: 'cashier-1',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    organization: {
      id: 'org-1',
      slug: 'pharmacy',
      displayName: 'Pharmacy',
      legalName: 'Pharmacy',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
      timezone: 'UTC',
      locale: 'en',
      currency: 'USD',
      seatLimit: 10,
      isDemo: false,
      vertical: 'PHARMACY',
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };

  return pharmacyAccessRouter.createCaller(context);
}

describe('pharmacyAccess.navigation', () => {
  it('returns only effective rail capabilities and applies DENY across rule sources', async () => {
    const navigation = await caller(
      [
        { capability: 'pharmacy:counter', effect: 'ALLOW' },
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ],
      [
        { capability: 'pharmacy:procurement', effect: 'DENY' },
        { capability: 'reports:operational', effect: 'ALLOW' },
      ]
    ).navigation();

    expect(navigation).toEqual(['pharmacy:counter', 'reports:operational']);
  });

  it('does not turn wildcard ALLOWs into exact-only dispense or safety grants', async () => {
    const navigation = await caller(
      [],
      [{ capability: 'pharmacy:*', effect: 'ALLOW' }]
    ).navigation();

    expect(navigation).toEqual([
      'pharmacy:counter',
      'pharmacy:procurement',
      'pharmacy:inventory',
      'pharmacy:orders',
    ]);
    expect(navigation).not.toContain('pharmacy:dispense');
    expect(navigation).not.toContain('pharmacy:safety');
  });
});
