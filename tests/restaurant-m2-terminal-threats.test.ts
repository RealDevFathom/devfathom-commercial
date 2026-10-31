import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Route = { POST: (request: Request) => Promise<Response> };

const h = vi.hoisted(() => ({
  resolveSharedLogin: vi.fn(async () => ({ outcome: 'failed' as const })),
  store: {
    organizations: [] as Row[],
    devices: [] as Row[],
    sessions: [] as Row[],
    staff: [] as Row[],
    credentials: [] as Row[],
    coAuthorizations: [] as Row[],
    auditLogs: [] as Row[],
  },
  reads: { deviceById: 0, sessionByHash: 0, operatorCredentials: 0 },
  authConfig: null as null | {
    providers: Array<{
      id?: string;
      authorize: (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;
    }>;
  },
}));

function find(rows: Row[], where: Record<string, unknown>): Row | null {
  return (
    rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null
  );
}

function copy(row: Row | null): Row | null {
  return row ? { ...row } : null;
}

const db = {
  organization: {
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      copy(find(h.store.organizations, where)),
  },
  user: { findFirst: vi.fn(async () => null) },
  restaurantBranch: {
    findUnique: vi.fn(async () => ({ id: 'branch_m2', active: true })),
    // WHA-149: /terminal/establish returns the branch NAME so the POS never
    // renders a raw branch id.
    findUniqueOrThrow: vi.fn(async () => ({ id: 'branch_m2', name: 'M2 Branch' })),
  },
  restaurantRegisteredDevice: {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `device_${h.store.devices.length + 1}`,
        organizationId: 'org_m2',
        status: 'ACTIVE',
        revokedAt: null,
        lastSeenAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      h.store.devices.push(row);
      return copy(row);
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      if ('id' in where) h.reads.deviceById += 1;
      return copy(find(h.store.devices, where));
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = find(h.store.devices, where);
      if (!row) throw new Error('device missing');
      Object.assign(row, data, { updatedAt: new Date() });
      return copy(row);
    },
  },
  restaurantTerminalSession: {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `session_${h.store.sessions.length + 1}`,
        organizationId: 'org_m2',
        activeStaffProfileId: null,
        endedAt: null,
        updatedAt: new Date(),
        ...data,
      };
      h.store.sessions.push(row);
      return copy(row);
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      if ('tokenHash' in where) h.reads.sessionByHash += 1;
      return copy(find(h.store.sessions, where));
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = find(h.store.sessions, where);
      if (!row) throw new Error('session missing');
      Object.assign(row, data, { updatedAt: new Date() });
      return copy(row);
    },
  },
  restaurantStaffProfile: {
    findFirst: vi.fn(async () => null),
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      copy(find(h.store.staff, where)),
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `staff_${h.store.staff.length + 1}`,
        organizationId: 'org_m2',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      h.store.staff.push(row);
      return copy(row);
    },
  },
  restaurantStaffJobRole: {
    findMany: async () => [],
  },
  restaurantStaffCapabilityGrant: {
    findMany: async () => [],
  },
  restaurantOperatorCredential: {
    findMany: async ({ where }: { where: Row }) => {
      h.reads.operatorCredentials += 1;
      return h.store.credentials
        .filter(
          (row) =>
            row.staffProfileId === where.staffProfileId &&
            row.type === where.type &&
            row.revokedAt === null
        )
        .filter((row) => {
          if (Array.isArray(where.OR)) {
            return where.OR.some(
              (clause) =>
                typeof clause === 'object' &&
                clause !== null &&
                row.deviceId === (clause as Row).deviceId
            );
          }
          return row.deviceId === where.deviceId;
        })
        .map((row) => ({ ...row }));
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = find(h.store.credentials, where);
      if (!row) throw new Error('credential missing');
      Object.assign(row, data, { updatedAt: new Date() });
      return copy(row);
    },
  },
  restaurantCoAuthorization: {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `coauth_${h.store.coAuthorizations.length + 1}`,
        organizationId: 'org_m2',
        createdAt: new Date(),
        ...data,
      };
      h.store.coAuthorizations.push(row);
      return copy(row);
    },
  },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `audit_${h.store.auditLogs.length + 1}`,
        createdAt: new Date(),
        ...data,
      };
      h.store.auditLogs.push(row);
      return copy(row);
    },
  },
};

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.25',
  rateLimit: () => ({ ok: true, retryAfter: 0, remaining: 100 }),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (database: unknown) => unknown) => run(db),
  withTenantDb: (_organizationId: string, run: (database: unknown) => unknown) => run(db),
  createTenantDb: () => db,
}));

vi.mock('@/lib/tenancy/host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenancy/host')>('@/lib/tenancy/host');
  return {
    ...actual,
    resolveOrganizationForRequest: vi.fn(async () => ({
      id: 'org_m2',
      slug: 'restaurant',
      status: 'ACTIVE',
    })),
  };
});

vi.mock('@/lib/auth/shared-login', () => ({ resolveSharedLogin: h.resolveSharedLogin }));

vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, moduleKey: string) =>
    entitlements.enabledModules.includes(moduleKey),
  resolveOrganizationEntitlements: vi.fn(async () => ({
    organizationId: 'org_m2',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: ['restaurant-pos'],
    modules: [],
    limits: {},
  })),
}));

vi.mock('next-auth/providers/credentials', () => ({
  default: (config: Record<string, unknown>) => ({ id: 'credentials', ...config }),
}));

vi.mock('next-auth', () => ({
  CredentialsSignin: class CredentialsSignin extends Error {},
  default: (config: NonNullable<typeof h.authConfig>) => {
    h.authConfig = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import { POST as sharedLogin } from '@/app/api/login/route';
import * as coAuthorizeRoute from '@/app/api/restaurant/terminal/co-authorize/route';
import * as establishRoute from '@/app/api/restaurant/terminal/establish/route';
import * as heartbeatRoute from '@/app/api/restaurant/terminal/heartbeat/route';
import * as lockRoute from '@/app/api/restaurant/terminal/lock/route';
import * as switchRoute from '@/app/api/restaurant/terminal/switch/route';
import * as unlockRoute from '@/app/api/restaurant/terminal/unlock/route';
import { enrollDevice, revokeDevice } from '@/lib/restaurant/devices';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const ORG = 'org_m2';
const BRANCH = 'branch_m2';
const ACTING = 'staff_acting';
const INCOMING = 'staff_incoming';
const MANAGER = 'staff_manager';
const PINS = { [ACTING]: '2468', [INCOMING]: '1357', [MANAGER]: '9999' };

let credentialHashes: Record<string, string>;

function terminalRequest(
  secret: string,
  session?: string,
  body?: unknown,
  path = 'heartbeat'
): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
  if (session) headers['x-terminal-session'] = session;
  return new Request(`https://restaurant.test/api/restaurant/terminal/${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(route: Route, request: Request) {
  const response = await route.POST(request);
  return {
    response,
    body: (await response.json().catch(() => ({}))) as Row,
  };
}

async function enroll(name: string) {
  return enrollDevice(db as unknown as ScopedDb, { branchId: BRANCH, name });
}

async function establish(secret: string) {
  const result = await call(
    establishRoute,
    terminalRequest(secret, undefined, undefined, 'establish')
  );
  expect(result.response.status).toBe(201);
  return {
    token: result.body.sessionToken as string,
    sessionId: (result.body.session as Row).id as string,
  };
}

function addOperator(
  staffProfileId: string,
  deviceId: string | null = null,
  capabilities: string[] = []
) {
  h.store.staff.push({
    id: staffProfileId,
    organizationId: ORG,
    displayName: staffProfileId,
    primaryBranchId: BRANCH,
    status: 'ACTIVE',
    jobRoles: [],
    directCapabilityGrants: [],
    user: {
      organizationRole: {
        permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
      },
      permissionOverrides: [],
    },
  });
  h.store.credentials.push({
    id: `credential_${staffProfileId}`,
    organizationId: ORG,
    staffProfileId,
    deviceId,
    type: 'PIN',
    credentialHash: credentialHashes[staffProfileId],
    failedAttempts: 0,
    lockedUntil: null,
    revokedAt: null,
  });
}

async function unlock(secret: string, token: string, staffProfileId: string, pin: string) {
  return call(
    unlockRoute,
    terminalRequest(secret, token, { staffProfileId, type: 'PIN', secret: pin }, 'unlock')
  );
}

async function switchOperator(secret: string, token: string, staffProfileId: string, pin: string) {
  return call(
    switchRoute,
    terminalRequest(secret, token, { staffProfileId, type: 'PIN', secret: pin }, 'switch')
  );
}

beforeAll(async () => {
  process.env.AUTH_SECRET ??= randomBytes(32).toString('base64url');
  credentialHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(PINS).map(async ([staffProfileId, pin]) => [
        staffProfileId,
        // Keep real bcrypt verification; production cost is covered by primitive tests.
        await hash(pin, 4),
      ])
    )
  );
});

beforeEach(() => {
  h.store.organizations = [{ id: ORG, status: 'ACTIVE' }];
  h.store.devices = [];
  h.store.sessions = [];
  h.store.staff = [];
  h.store.credentials = [];
  h.store.coAuthorizations = [];
  h.store.auditLogs = [];
  h.reads.deviceById = 0;
  h.reads.sessionByHash = 0;
  h.reads.operatorCredentials = 0;
  h.resolveSharedLogin.mockClear();
  h.resolveSharedLogin.mockResolvedValue({ outcome: 'failed' });
  vi.mocked(db.user.findFirst).mockClear();
});

describe('THREAT-1: operator credentials cannot become web sessions', () => {
  it.each(['2468', 'BADGE-SECRET-25'])(
    'returns one generic shared-host body for %s',
    async (secret) => {
      process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
      const response = await sharedLogin(
        new Request('https://www.devfathom.com/api/login', {
          method: 'POST',
          headers: {
            host: 'www.devfathom.com',
            origin: 'https://www.devfathom.com',
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify({ email: 'operator@restaurant.test', password: secret }),
        })
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        outcome: 'failed',
        message: 'Invalid email or password. Please try again.',
      });
    }
  );

  it('rejects PIN and badge values in the NextAuth credentials provider', async () => {
    await import('@/lib/auth');
    const provider = h.authConfig?.providers.find((candidate) => candidate.id === 'credentials');
    expect(provider).toBeDefined();

    for (const secret of ['2468', 'BADGE-SECRET-25']) {
      const result = await provider!.authorize(
        { email: 'operator@restaurant.test', password: secret },
        new Request('https://restaurant.devfathom.com/api/auth/callback/credentials', {
          method: 'POST',
          headers: { host: 'restaurant.devfathom.com' },
        })
      );
      expect(result).toBeNull();
    }

    expect(db.user.findFirst).toHaveBeenCalledTimes(2);
    expect(h.reads.operatorCredentials).toBe(0);
  });
});

describe('THREAT-2: revocation defeats queued and fresh calls', () => {
  it('DB-revalidates held device/session tokens after mid-session revocation', async () => {
    const { device, secret } = await enroll('queued-call');
    const { token } = await establish(secret);
    const queued = terminalRequest(secret, token);

    expect((await heartbeatRoute.POST(queued.clone())).status).toBe(200);
    await revokeDevice(db as unknown as ScopedDb, device.id, new Date());

    const readsBefore = { ...h.reads };
    const replay = await heartbeatRoute.POST(queued);
    const freshSessionCall = await heartbeatRoute.POST(terminalRequest(secret, token));
    const freshDeviceCall = await establishRoute.POST(
      terminalRequest(secret, undefined, undefined, 'establish')
    );

    expect([replay.status, freshSessionCall.status, freshDeviceCall.status]).toEqual([
      403, 403, 403,
    ]);
    expect(h.reads.deviceById - readsBefore.deviceById).toBe(3);
    expect(h.reads.sessionByHash - readsBefore.sessionByHash).toBe(2);
  });
});

describe('durable operator lockout', () => {
  it('locks after five failures, emits Retry-After, then accepts after that server interval', async () => {
    // Freeze policy time without trapping bcrypt's asynchronous yield timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    try {
      const { device, secret } = await enroll('lockout');
      const { token } = await establish(secret);
      addOperator(ACTING, device.id);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await unlock(secret, token, ACTING, '0000')).response.status).toBe(401);
      }

      const locked = await unlock(secret, token, ACTING, PINS[ACTING]);
      expect(locked.response.status).toBe(423);
      expect(locked.response.headers.get('retry-after')).toBe('900');
      expect(find(h.store.credentials, { id: `credential_${ACTING}` })).toMatchObject({
        failedAttempts: 0,
        lockedUntil: new Date('2026-08-18T12:15:00.000Z'),
      });

      vi.setSystemTime(new Date('2026-08-18T12:15:00.001Z'));
      expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KDS unlock authorization', () => {
  it('verifies the credential before revealing whether the operator has kitchen access', async () => {
    const { device, secret } = await enrollDevice(db as unknown as ScopedDb, {
      branchId: BRANCH,
      name: 'credential-first-kds',
      kind: 'KDS',
    });
    const { token } = await establish(secret);
    addOperator(ACTING, device.id);
    addOperator(INCOMING, device.id, ['kitchen:operate']);

    const invalidCredentialWithoutAccess = await unlock(secret, token, ACTING, '0000');
    const invalidCredentialWithAccess = await unlock(secret, token, INCOMING, '0000');

    // A caller who does not know either PIN sees the same response regardless
    // of whether the targeted operator has kitchen access.
    expect(invalidCredentialWithoutAccess.response.status).toBe(401);
    expect(invalidCredentialWithAccess.response.status).toBe(401);
    expect(invalidCredentialWithoutAccess.body).toEqual({
      error: 'Invalid operator credential.',
    });
    expect(invalidCredentialWithAccess.body).toEqual(invalidCredentialWithoutAccess.body);

    const validCredentialWithoutAccess = await unlock(secret, token, ACTING, PINS[ACTING]);
    expect(validCredentialWithoutAccess.response.status).toBe(403);
    expect(validCredentialWithoutAccess.body).toEqual({
      error: 'This operator lacks the "kitchen:operate" capability.',
    });
  });

  it('unlocks a KDS for an authenticated operator with kitchen access', async () => {
    const { device, secret } = await enrollDevice(db as unknown as ScopedDb, {
      branchId: BRANCH,
      name: 'authorized-kds',
      kind: 'KDS',
    });
    const { token } = await establish(secret);
    addOperator(ACTING, device.id, ['kitchen:operate']);

    expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);
  });

  it('prevents a switch from bypassing KDS authorization and preserves the current operator', async () => {
    const { device, secret } = await enrollDevice(db as unknown as ScopedDb, {
      branchId: BRANCH,
      name: 'authorized-kds-handoff',
      kind: 'KDS',
    });
    const { token, sessionId } = await establish(secret);
    addOperator(ACTING, device.id, ['kitchen:operate']);
    addOperator(INCOMING, device.id);

    expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);
    const auditsBeforeSwitch = h.store.auditLogs.length;

    const invalidCredential = await switchOperator(secret, token, INCOMING, '0000');
    expect(invalidCredential.response.status).toBe(401);
    expect(invalidCredential.body).toEqual({ error: 'Invalid operator credential.' });

    const unauthorized = await switchOperator(secret, token, INCOMING, PINS[INCOMING]);
    expect(unauthorized.response.status).toBe(403);
    expect(unauthorized.body).toEqual({
      error: 'This operator lacks the "kitchen:operate" capability.',
    });
    expect(find(h.store.sessions, { id: sessionId })).toMatchObject({
      activeStaffProfileId: ACTING,
    });
    expect(h.store.auditLogs).toHaveLength(auditsBeforeSwitch);
  });

  it('switches a KDS to an authenticated incoming operator with kitchen access', async () => {
    const { device, secret } = await enrollDevice(db as unknown as ScopedDb, {
      branchId: BRANCH,
      name: 'authorized-kds-switch',
      kind: 'KDS',
    });
    const { token, sessionId } = await establish(secret);
    addOperator(ACTING, device.id, ['kitchen:operate']);
    addOperator(INCOMING, device.id, ['kitchen:operate']);

    expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);
    expect((await switchOperator(secret, token, INCOMING, PINS[INCOMING])).response.status).toBe(
      200
    );
    expect(find(h.store.sessions, { id: sessionId })).toMatchObject({
      activeStaffProfileId: INCOMING,
    });
  });
});

describe('operator attribution and secret containment', () => {
  it('keeps acting and approving identities separate in complete server-stamped evidence', async () => {
    // Freeze policy time without trapping bcrypt's asynchronous yield timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-18T13:00:00.000Z'));
    try {
      const { device, secret } = await enroll('co-authorization');
      const { token, sessionId } = await establish(secret);
      addOperator(ACTING, device.id);
      addOperator(MANAGER, device.id, ['coauth:approve']);
      expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);

      const marker = PINS[MANAGER];
      const approved = await call(
        coAuthorizeRoute,
        terminalRequest(
          secret,
          token,
          {
            approvingStaffProfileId: MANAGER,
            type: 'PIN',
            secret: marker,
            capability: 'orders:void',
            targetType: 'Order',
            targetId: 'order_25',
            reason: 'guest complaint',
          },
          'co-authorize'
        )
      );

      expect(approved.response.status).toBe(201);
      expect(h.store.coAuthorizations).toContainEqual(
        expect.objectContaining({
          actingStaffProfileId: ACTING,
          approvingStaffProfileId: MANAGER,
          capability: 'orders:void',
          targetType: 'Order',
          targetId: 'order_25',
          reason: 'guest complaint',
          deviceId: device.id,
          terminalSessionId: sessionId,
          createdAt: new Date('2026-08-18T13:00:00.000Z'),
        })
      );
      expect(find(h.store.sessions, { id: sessionId })).toMatchObject({
        activeStaffProfileId: ACTING,
      });
      expect(JSON.stringify(h.store.coAuthorizations)).not.toContain(marker);
      expect(JSON.stringify(approved.body)).not.toContain(marker);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes acting-operator audit rows for every sensitive terminal mutation', async () => {
    const { device, secret } = await enroll('attribution');
    const { token } = await establish(secret);
    addOperator(ACTING, device.id);
    addOperator(INCOMING, device.id);
    addOperator(MANAGER, device.id, ['coauth:approve']);

    expect((await unlock(secret, token, ACTING, PINS[ACTING])).response.status).toBe(200);
    expect(
      (
        await call(
          switchRoute,
          terminalRequest(
            secret,
            token,
            { staffProfileId: INCOMING, type: 'PIN', secret: PINS[INCOMING] },
            'switch'
          )
        )
      ).response.status
    ).toBe(200);
    expect(
      (
        await call(
          coAuthorizeRoute,
          terminalRequest(
            secret,
            token,
            {
              approvingStaffProfileId: MANAGER,
              type: 'PIN',
              secret: PINS[MANAGER],
              capability: 'orders:void',
              targetType: 'Order',
              targetId: 'order_audit_25',
              reason: 'guest complaint',
            },
            'co-authorize'
          )
        )
      ).response.status
    ).toBe(201);
    expect(
      (await call(lockRoute, terminalRequest(secret, token, undefined, 'lock'))).response.status
    ).toBe(200);

    const terminalAudits = h.store.auditLogs.filter(
      (row) => row.actorType === 'RESTAURANT_OPERATOR'
    );
    expect(terminalAudits).toHaveLength(4);
    expect(terminalAudits.map((row) => row.actorId)).toEqual([null, null, null, null]);
    expect(terminalAudits.map((row) => row.actorStaffProfileId)).toEqual([
      ACTING,
      INCOMING,
      INCOMING,
      INCOMING,
    ]);
    for (const row of terminalAudits) {
      const context = {
        ...row,
        ...(typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {}),
      };
      expect(context).toMatchObject({
        organizationId: ORG,
        actorType: 'RESTAURANT_OPERATOR',
        source: 'REST_API',
        deviceId: device.id,
        terminalSessionId: expect.any(String),
      });
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(JSON.stringify(row)).not.toMatch(/2468|1357|9999/);
    }
    const approvalAudit = terminalAudits
      .map((row) => ({
        ...row,
        ...(typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {}),
      }))
      .find((row) => row.capability === 'orders:void');
    expect(approvalAudit).toMatchObject({
      actorId: null,
      actorStaffProfileId: INCOMING,
      actingStaffProfileId: INCOMING,
      approvingStaffProfileId: MANAGER,
      capability: 'orders:void',
      targetType: 'Order',
      targetId: 'order_audit_25',
      reason: 'guest complaint',
      deviceId: device.id,
    });
  });
});
