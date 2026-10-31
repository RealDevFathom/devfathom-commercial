/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates model only the operations exercised by these boundary tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const state = vi.hoisted(() => ({
  user: {} as any,
  sessions: [] as any[],
  audits: [] as any[],
  valid: true,
  rateLimitOk: true,
}));
vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: vi.fn(async () => true) }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimit: () => ({ ok: state.rateLimitOk }),
  clearRateLimit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
vi.mock('@/lib/totp', () => ({
  verifyTotp: () => state.valid,
  hashRecoveryCode: (s: string) => s,
  generateTotpSecret: () => 'test-secret',
  totpAuthUri: () => 'otpauth://test',
  generateRecoveryCodes: () => ({ hashes: ['hash'], codes: ['recovery'] }),
}));
const db = {
  $queryRawUnsafe: vi.fn(async () => []),
  platformUser: {
    findUnique: vi.fn(async () => ({ ...state.user })),
    update: vi.fn(async ({ data }: any) => Object.assign(state.user, data)),
  },
  platformSession: {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `s${state.sessions.length}`, revokedAt: null, ...data };
      state.sessions.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = state.sessions.find((s) =>
        where.id ? s.id === where.id : s.tokenHash === where.tokenHash
      );
      return row && { ...row, platformUser: { ...state.user } };
    }),
    update: vi.fn(async ({ where, data }: any) =>
      Object.assign(
        state.sessions.find((s) => s.id === where.id),
        data
      )
    ),
    updateMany: vi.fn(async ({ where, data }: any) => {
      state.sessions
        .filter(
          (s) => s.platformUserId === where.platformUserId && !s.revokedAt && s.id !== where.id?.not
        )
        .forEach((s) => Object.assign(s, data));
      return { count: 1 };
    }),
  },
  platformRecoveryCode: {
    count: vi.fn(async () => 0),
    findUnique: vi.fn(async () => null),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  platformAuditLog: {
    create: vi.fn(async ({ data }: any) => {
      state.audits.push(data);
      return data;
    }),
  },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: (fn: any) => fn(db) }));
import {
  canPlatform,
  createPlatformSession,
  getPlatformSession,
  platformLoginNeedsEnrollment,
  requirePlatformSession,
  requirePlatformMfaSession,
  revokePlatformSession,
} from '@/lib/platform/auth';
import { POST, GET } from '@/app/api/platform/mfa/route';
import { POST as login, DELETE as logout } from '@/app/api/platform/session/route';
const request = (token = '', body?: unknown) =>
  new Request('http://admin.localhost/api/platform/mfa', {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie: `df_platform_session=${token}`,
      origin: 'http://admin.localhost',
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const signIn = () =>
  createPlatformSession('admin@example.com', 'valid-password', undefined, request());

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('PLATFORM_MFA_ENFORCE', 'true');
  vi.clearAllMocks();
  state.sessions = [];
  state.audits = [];
  state.valid = true;
  state.rateLimitOk = true;
  state.user = {
    id: 'operator_1',
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: 'hash',
    active: true,
    role: 'SUPER_ADMIN',
    mfaRequired: false,
    mfaEnabledAt: null,
    encryptedTotpSecret: null,
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('restricted enrollment sessions', () => {
  it.each(['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'])(
    '%s gets enrollment only by default',
    async (role) => {
      state.user.role = role;
      const session = await signIn();
      expect(session.identity.enrollmentOnly).toBe(true);
      expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600000);
      expect(canPlatform(session.identity, 'organizations:read')).toBe(false);
      expect(await getPlatformSession(request(session.token))).toBeNull();
      expect(await platformLoginNeedsEnrollment(request(session.token))).toBe(true);
      await expect(requirePlatformSession(request(session.token))).rejects.toMatchObject({
        status: 401,
      });
      expect((await requirePlatformMfaSession(request(session.token))).enrollmentOnly).toBe(true);
      expect((await GET(request(session.token))).status).toBe(200);
      expect(
        (await POST(request(session.token, { action: 'disable', code: '123456' }))).status
      ).toBe(403);
      expect(
        (await POST(request(session.token, { action: 'regenerate', code: '123456' }))).status
      ).toBe(403);
      await revokePlatformSession(request(session.token));
      await expect(requirePlatformMfaSession(request(session.token))).rejects.toMatchObject({
        status: 401,
      });
    }
  );
  it.each(['SALES', 'FINANCE', 'AUDITOR'])('%s preserves optional-MFA login', async (role) => {
    state.user.role = role;
    const session = await signIn();
    expect(session.identity.enrollmentOnly).toBe(false);
    expect(await getPlatformSession(request(session.token))).not.toBeNull();
    expect(await platformLoginNeedsEnrollment(request(session.token))).toBe(false);
  });
  it('allows the explicit test override but still honors user policy', async () => {
    vi.stubEnv('PLATFORM_MFA_ENFORCE', 'false');
    expect((await signIn()).identity.enrollmentOnly).toBe(false);
    state.user.mfaRequired = true;
    expect((await signIn()).identity.enrollmentOnly).toBe(true);
  });
  it('returns enrollmentRequired through the login endpoint', async () => {
    const response = await login(
      request('', { email: 'admin@example.com', password: 'valid-password' })
    );
    expect(await response.json()).toMatchObject({ authenticated: false, enrollmentRequired: true });
    expect(response.headers.get('set-cookie')).toContain('enroll_');
  });
  it('requires a valid factor when already enrolled', async () => {
    state.user.mfaEnabledAt = new Date();
    state.user.encryptedTotpSecret = 'secret';
    await expect(signIn()).rejects.toMatchObject({ status: 401 });
    const session = await createPlatformSession(
      'admin@example.com',
      'valid-password',
      '123456',
      request()
    );
    expect(session.identity.enrollmentOnly).toBe(false);
  });
  it('confirms enrollment, rotates the cookie, and prevents sibling or stripped-token promotion', async () => {
    const first = await signIn();
    const sibling = await signIn();
    expect((await POST(request(first.token, { action: 'begin' }))).status).toBe(200);
    state.valid = false;
    expect((await POST(request(first.token, { action: 'confirm', code: '000000' }))).status).toBe(
      400
    );
    expect(state.user.mfaEnabledAt).toBeNull();
    state.valid = true;
    const response = await POST(request(first.token, { action: 'confirm', code: '123456' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'confirm', recoveryCodes: ['recovery'] });
    const token = response.headers.get('set-cookie')!.match(/df_platform_session=([^;]+)/)![1];
    expect(token).not.toMatch(/^enroll_/);
    expect(await getPlatformSession(request(token))).not.toBeNull();
    for (const old of [first.token, sibling.token, first.token.replace('enroll_', '')]) {
      expect(await getPlatformSession(request(old))).toBeNull();
      await expect(requirePlatformMfaSession(request(old))).rejects.toMatchObject({ status: 401 });
    }
    expect(state.audits.some((a) => a.action === 'platform.mfa.enabled')).toBe(true);
  });
  it('does not lift enrollment scope merely because the account has enrolled', async () => {
    const session = await signIn();
    state.user.mfaEnabledAt = new Date();
    state.user.encryptedTotpSecret = 'secret';
    expect(await getPlatformSession(request(session.token))).toBeNull();
  });
  it('rejects expired enrollment and pre-policy unenrolled privileged sessions', async () => {
    const session = await signIn();
    state.sessions[0].expiresAt = new Date(0);
    await expect(requirePlatformMfaSession(request(session.token))).rejects.toMatchObject({
      status: 401,
    });
    const legacy = 'a'.repeat(43);
    state.sessions.push({
      id: 'old',
      platformUserId: state.user.id,
      tokenHash: createHash('sha256').update(legacy).digest('hex'),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    expect(await getPlatformSession(request(legacy))).toBeNull();
  });
});

describe('enrollment integration guards', () => {
  it('logs out an enrollment cookie through the real JSON-origin route boundary', async () => {
    const session = await signIn();
    const headers = {
      cookie: `df_platform_session=${session.token}`,
      origin: 'http://admin.localhost',
    };
    const missingType = await logout(
      new Request('http://admin.localhost/api/platform/session', { method: 'DELETE', headers })
    );
    expect(missingType.status).toBe(400);
    expect((await requirePlatformMfaSession(request(session.token))).enrollmentOnly).toBe(true);
    const response = await logout(
      new Request('http://admin.localhost/api/platform/session', {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(requirePlatformMfaSession(request(session.token))).rejects.toMatchObject({
      status: 401,
    });
  });
  it('refuses issuance if the verified account changes before its locked recheck', async () => {
    db.platformUser.findUnique
      .mockResolvedValueOnce({ ...state.user })
      .mockResolvedValueOnce({ ...state.user, role: 'SALES' });
    await expect(signIn()).rejects.toMatchObject({ status: 401 });
    expect(state.sessions).toHaveLength(0);
  });
  it('rate limits enrollment mutation before changing the setup secret', async () => {
    const session = await signIn();
    state.rateLimitOk = false;
    expect((await POST(request(session.token, { action: 'begin' }))).status).toBe(429);
    expect(state.user.encryptedTotpSecret).toBeNull();
  });
  it('refuses role-required MFA disable even from an enrolled regular session', async () => {
    state.user.mfaEnabledAt = new Date();
    state.user.encryptedTotpSecret = 'synthetic-secret';
    const session = await createPlatformSession(
      'admin@example.com',
      'valid-password',
      '123456',
      request()
    );
    expect(session.identity.enrollmentOnly).toBe(false);
    expect((await POST(request(session.token, { action: 'disable', code: '123456' }))).status).toBe(
      403
    );
    expect(state.user.encryptedTotpSecret).toBe('synthetic-secret');
  });
});
