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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  recordTrpcAudit: vi.fn(),
  can: vi.fn(async () => true),
  hasModule: vi.fn(() => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
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
  entitlementIndependentAdminProcedure,
  entitlementIndependentHistoryProcedure,
  hrProcedure,
  protectedProcedure,
  router,
} from './trpc';
import type { TRPCContext } from './trpc';

type SessionUser = Record<string, unknown> & { id: string };

function contextFor(user: SessionUser | null): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    entitlements: { enabledModules: [] } as unknown as TRPCContext['entitlements'],
    session: user ? ({ expires: 'later', user } as unknown as TRPCContext['session']) : null,
    organization: null,
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
