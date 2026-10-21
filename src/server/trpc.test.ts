/**
 * Issue #16 — a revoked session must be rejected by EVERY procedure type, on a
 * representative read AND write.
 *
 * The QA report saw `clients.getAll` (protected query) and `clients.create`
 * (admin mutation) return 200 for a session that `/api/auth/session` reported as
 * REVOKED, while other procedures on the same session returned 403. The only way
 * a session could pass the old `assertActive` guard was a falsy `status`, so
 * these cases pin the fail-closed behaviour for every procedure builder rather
 * than for the one procedure that happened to be probed.
 */
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  recordTrpcAudit: vi.fn(),
  can: vi.fn(async () => true),
  hasModule: vi.fn(() => true),
  resolveTenantActor: vi.fn(),
  auditCreate: vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue({}),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(async (_id: string, run: (db: unknown) => unknown) =>
    run({ auditLog: { create: mocks.auditCreate } })
  ),
  withPlatformDb: vi.fn(async (run: (db: unknown) => unknown) =>
    run({ platformAuditLog: { create: mocks.auditCreate } })
  ),
}));
vi.mock('@/lib/restaurant/camera-presets', () => ({ listActiveCameraBrandPresets: vi.fn() }));
vi.mock('@/lib/restaurant/terminal-auth', () => ({ authenticateOperator: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: mocks.resolveTenantActor,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import {
  adminProcedure,
  capabilityProcedure,
  createTRPCContext,
  entitlementIndependentAdminProcedure,
  entitlementIndependentHistoryProcedure,
  hrProcedure,
  protectedProcedure,
  router,
} from './trpc';
import type { TRPCContext } from './trpc';

describe('createTRPCContext request actor resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not mark an unresolved route session as explicitly resolved', async () => {
    const request = new Request('https://restaurant.devfathom.test/api/restaurant/sop/evidence');
    mocks.resolveTenantActor.mockResolvedValueOnce({
      session: {
        expires: 'later',
        user: { id: 'user-1', organizationId: 'org-1', status: 'ACTIVE' },
      },
      organization: { id: 'org-1' },
      support: null,
    });

    await expect(createTRPCContext({ req: request })).resolves.toMatchObject({
      session: { user: { id: 'user-1' } },
      organization: { id: 'org-1' },
    });
    expect(mocks.resolveTenantActor).toHaveBeenCalledWith({ request });
  });

  it('keeps the workspace guard and its internal error classification', async () => {
    const request = new Request('https://restaurant.devfathom.test/api/restaurant/sop/evidence');
    mocks.resolveTenantActor.mockResolvedValueOnce(null);

    await expect(createTRPCContext({ req: request })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Workspace not found.',
    });
  });
});

type SessionUser = Record<string, unknown> & { id: string };

function contextFor(user: SessionUser | null, isDemo = false): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    entitlements: { enabledModules: [] } as unknown as TRPCContext['entitlements'],
    session: user ? ({ expires: 'later', user } as unknown as TRPCContext['session']) : null,
    organization: isDemo ? ({ id: 'org_demo', isDemo: true } as never) : null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

// One representative read and one representative write per procedure builder.
const probe = router({
  protectedRead: protectedProcedure.query(() => 'ok'),
  protectedWrite: protectedProcedure.input(z.object({}).optional()).mutation(() => 'ok'),
  adminRead: adminProcedure.query(() => 'ok'),
  adminWrite: adminProcedure.input(z.object({}).optional()).mutation(() => 'ok'),
  cleanupRead: entitlementIndependentAdminProcedure.query(() => 'ok'),
  cleanupWrite: entitlementIndependentAdminProcedure
    .input(z.object({}).optional())
    .mutation(() => 'ok'),
  historyRead: entitlementIndependentHistoryProcedure.query(() => 'ok'),
  hrRead: hrProcedure.query(() => 'ok'),
  hrWrite: hrProcedure.input(z.object({}).optional()).mutation(() => 'ok'),
  capabilityRead: capabilityProcedure('team:view').query(() => 'ok'),
  capabilityWrite: capabilityProcedure('team:view')
    .input(z.object({}).optional())
    .mutation(() => 'ok'),
});

const demoProbe = router({
  webhooks: router({
    list: protectedProcedure.query(() => 'blocked'),
    create: adminProcedure.mutation(() => 'blocked'),
  }),
  restaurantOrders: router({
    list: protectedProcedure.query(() => 'ok'),
    open: capabilityProcedure('orders:manage').mutation(() => 'ok'),
  }),
});

const CALLS: Array<[string, (caller: ReturnType<typeof probe.createCaller>) => Promise<unknown>]> =
  [
    ['protected read', (c) => c.protectedRead()],
    ['protected write', (c) => c.protectedWrite({})],
    ['admin read', (c) => c.adminRead()],
    ['admin write', (c) => c.adminWrite({})],
    ['entitlement-independent admin read', (c) => c.cleanupRead()],
    ['entitlement-independent admin write', (c) => c.cleanupWrite({})],
    ['entitlement-independent history read', (c) => c.historyRead()],
    ['hr read', (c) => c.hrRead()],
    ['hr write', (c) => c.hrWrite({})],
    ['capability read', (c) => c.capabilityRead()],
    ['capability write', (c) => c.capabilityWrite({})],
  ];

const ADMIN = { id: 'user_1', role: 'ADMIN', department: 'LEADERSHIP' };

const REJECTED_SESSIONS: Array<[string, SessionUser, 'UNAUTHORIZED' | 'FORBIDDEN', string]> = [
  [
    'revoked session',
    { ...ADMIN, status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'REVOKED' },
    'UNAUTHORIZED',
    'Your session has ended. Please sign in again.',
  ],
  [
    'deleted account',
    { ...ADMIN, status: 'ACTIVE', sessionRevoked: true, sessionInvalidReason: 'DELETED' },
    'UNAUTHORIZED',
    'Your session has ended. Please sign in again.',
  ],
  [
    'failed revalidation',
    {
      ...ADMIN,
      status: 'ACTIVE',
      sessionRevoked: true,
      sessionInvalidReason: 'REVALIDATION_FAILED',
    },
    'UNAUTHORIZED',
    'Your session has ended. Please sign in again.',
  ],
  [
    'suspended organization',
    {
      ...ADMIN,
      status: 'ACTIVE',
      sessionRevoked: true,
      sessionInvalidReason: 'ORGANIZATION_SUSPENDED',
    },
    'FORBIDDEN',
    'This workspace is not currently active.',
  ],
  [
    'legacy REVOKED sentinel in status',
    { ...ADMIN, status: 'REVOKED' },
    'UNAUTHORIZED',
    'Your session has ended. Please sign in again.',
  ],
  [
    'session with no status at all',
    { ...ADMIN },
    'UNAUTHORIZED',
    'Your session has ended. Please sign in again.',
  ],
  [
    'deactivated account',
    { ...ADMIN, status: 'INACTIVE' },
    'FORBIDDEN',
    'Your account is no longer active. Contact your workspace administrator.',
  ],
];

describe('procedure guards reject an unusable session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
  });

  for (const [label, user, code, message] of REJECTED_SESSIONS) {
    describe(label, () => {
      it.each(CALLS)('rejects %s', async (_name, call) => {
        const caller = probe.createCaller(contextFor(user));
        await expect(call(caller)).rejects.toMatchObject({ code, message });
      });
    });
  }

  it.each(CALLS)('rejects %s with no session at all', async (_name, call) => {
    const caller = probe.createCaller(contextFor(null));
    await expect(call(caller)).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('procedure guards admit a healthy session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
  });

  it.each(CALLS)('allows %s for an ACTIVE session', async (_name, call) => {
    const caller = probe.createCaller(contextFor({ ...ADMIN, status: 'ACTIVE' }));
    await expect(call(caller)).resolves.toBe('ok');
  });

  // Regression: on-leave staff must not start failing.
  it.each(CALLS)('allows %s for an ON_LEAVE session', async (_name, call) => {
    const caller = probe.createCaller(contextFor({ ...ADMIN, status: 'ON_LEAVE' }));
    await expect(call(caller)).resolves.toBe('ok');
  });

  it('rejects a non-admin from the entitlement-independent admin procedure', async () => {
    mocks.can.mockResolvedValue(false);
    const caller = probe.createCaller(
      contextFor({ id: 'user_2', role: 'EMPLOYEE', department: 'ENGINEERING', status: 'ACTIVE' })
    );

    await expect(caller.cleanupRead()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  });

  it('keeps authenticated history readable and audited when its module is disabled', async () => {
    mocks.hasModule.mockReturnValue(false);
    const caller = probe.createCaller(contextFor({ ...ADMIN, status: 'ACTIVE' }));
    await expect(caller.historyRead()).resolves.toBe('ok');
    expect(mocks.recordTrpcAudit).toHaveBeenCalledTimes(1);
  });
});

describe('central demo procedure isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
  });

  it.each([
    [
      'blocked integration read',
      (caller: ReturnType<typeof demoProbe.createCaller>) => caller.webhooks.list(),
    ],
    [
      'blocked integration mutation',
      (caller: ReturnType<typeof demoProbe.createCaller>) => caller.webhooks.create(),
    ],
  ])('%s returns the friendly demo denial', async (_label, call) => {
    const caller = demoProbe.createCaller(contextFor({ ...ADMIN, status: 'ACTIVE' }, true));
    await expect(call(caller)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Not available in demo.',
    });
  });

  it('keeps ordinary restaurant reads and mutations available', async () => {
    const caller = demoProbe.createCaller(contextFor({ ...ADMIN, status: 'ACTIVE' }, true));

    await expect(caller.restaurantOrders.list()).resolves.toBe('ok');
    await expect(caller.restaurantOrders.open()).resolves.toBe('ok');
  });
});

describe('temporary password gate', () => {
  const passwordProbe = router({
    team: router({
      changePassword: protectedProcedure.mutation(() => 'changed'),
      updateProfile: protectedProcedure.mutation(() => 'profile'),
    }),
    adminWrite: adminProcedure.mutation(() => 'admin'),
  });

  it('allows only the password change until the temporary password is replaced', async () => {
    const caller = passwordProbe.createCaller(
      contextFor({ ...ADMIN, status: 'ACTIVE', mustChangePassword: true })
    );
    await expect(caller.team.changePassword()).resolves.toBe('changed');
    await expect(caller.team.updateProfile()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Change your temporary password before continuing.',
    });
    await expect(caller.adminWrite()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('camera renewal audit redaction before resolver suppression (F3-R1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    const actual = await vi.importActual<typeof import('./audit')>('./audit');
    // Exercise real recordTrpcAudit/toAuditJson; replace only the database sink.
    mocks.recordTrpcAudit.mockImplementation(actual.recordTrpcAudit);
  });
  afterEach(async () => {
    const actual = await vi.importActual<typeof import('./audit')>('./audit');
    await actual.flushAuditWritesForTest();
    mocks.recordTrpcAudit.mockReset();
  });

  it.each(['entitlement', 'capability', 'license', 'invalid-input'] as const)(
    'keeps %s denial audited while removing the prior grant identifier',
    async (denial) => {
      const { restaurantCamerasRouter } = await import('./routers/restaurant-cameras');
      // Camera entitlement is enforced in its resolver. Mount the same procedure
      // under a licensed fixture prefix as well to exercise the outer license
      // guard; restaurantCameras currently has no catalog-prefix license mapping.
      const cameras = router({
        restaurantCameras: restaurantCamerasRouter,
        projects: restaurantCamerasRouter,
      });
      const ctx = contextFor({ ...ADMIN, status: 'ACTIVE', organizationId: 'org-camera' });
      ctx.entitlements = {
        enabledModules: [],
        modules: [],
      } as unknown as TRPCContext['entitlements'];
      ctx.audit.detail.metadata = {
        reason: 'camera verification',
        grant: 'ordinary business grant',
        count: 2,
      };
      if (denial === 'capability') mocks.can.mockResolvedValue(false);
      if (denial === 'entitlement' || denial === 'license') mocks.hasModule.mockReturnValue(false);
      const input = {
        cameraId: denial === 'invalid-input' ? '' : 'camera-a',
        previousGrantId: 'synthetic-camera-prior-grant',
      };
      const caller = cameras.createCaller(ctx);
      const call =
        denial === 'license'
          ? caller.projects.issueStreamGrant
          : caller.restaurantCameras.issueStreamGrant;
      const code = denial === 'invalid-input' ? 'BAD_REQUEST' : 'FORBIDDEN';
      await expect(call(input)).rejects.toMatchObject({ code });
      const actual = await vi.importActual<typeof import('./audit')>('./audit');
      await actual.flushAuditWritesForTest();
      expect(ctx.audit.detail.skipInput).toBeUndefined();
      expect(mocks.auditCreate).toHaveBeenCalledOnce();
      const row = mocks.auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(row.data).toMatchObject({
        organizationId: 'org-camera',
        actorId: ADMIN.id,
        outcome: 'FAILURE',
        errorCode: code,
        action: `${denial === 'license' ? 'projects' : 'restaurantCameras'}.issueStreamGrant`,
        input: { cameraId: input.cameraId, previousGrantId: '[REDACTED]' },
        metadata: { reason: 'camera verification', grant: 'ordinary business grant', count: 2 },
      });
      expect(JSON.stringify(row)).not.toContain(input.previousGrantId);
    }
  );

  it('redacts exact nested identifier keys without changing unrelated grant metadata', async () => {
    const { toAuditJson } = await vi.importActual<typeof import('./audit')>('./audit');
    const value = {
      previousGrantId: 'synthetic',
      nested: [{ PREVIOUSGRANTID: 'synthetic' }],
      grant: 'business',
      grantId: 'ordinary-id',
      previousGrantIdentifier: 'label',
      cameraId: 'camera-a',
      password: 'synthetic-password',
    };
    expect(toAuditJson(value)).toEqual({
      ...value,
      previousGrantId: '[REDACTED]',
      nested: [{ PREVIOUSGRANTID: '[REDACTED]' }],
      password: '[REDACTED]',
    });
    expect(value.previousGrantId).toBe('synthetic');
  });
});
