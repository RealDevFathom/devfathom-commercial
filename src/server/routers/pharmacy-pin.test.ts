import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-931: "Your PIN" — every pharmacy member creates or changes their own approval PIN
// after re-entering their password; the owner or a staff manager resets other people's.
// The store is the existing operator credential, so this runs the real lifecycle (bcrypt
// hash, lockout counters) against an in-memory database.
const audit = vi.hoisted(() => ({ annotateAudit: vi.fn() }));
const abac = vi.hoisted(() => ({ staffManagers: new Set<string>() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: audit.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/abac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/abac')>();
  return {
    ...actual,
    can: vi.fn(async (subject: { id: string }, action: string) =>
      action === 'staff:manage' ? abac.staffManagers.has(subject.id) : false
    ),
  };
});

import { compareSync, hashSync } from 'bcryptjs';
import { rateLimit } from '@/lib/rate-limit';
import { authenticateOperator } from '@/lib/restaurant/terminal-auth';
import {
  applyOperatorAttemptCharge,
  isOperatorAttemptCharge,
} from '@/lib/test-support/operator-attempt-charge';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacyPinRouter } from './pharmacy-pin';

const app = router({ pharmacyPin: pharmacyPinRouter });
const PASSWORD = 'owner current password';
const PASSWORD_HASH = hashSync(PASSWORD, 4);
const ORG = 'org-1';

type Member = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  department: string | null;
  password: string;
  phone: string | null;
  organizationRole: { key: string; isSystem: boolean; permissions: [] } | null;
  permissionOverrides: [];
};
const member = (
  id: string,
  role: string,
  roleKey: string | null,
  organizationId = ORG
): Member => ({
  id,
  organizationId,
  name: id[0]!.toUpperCase() + id.slice(1),
  email: `${id}@pharmacy.invalid`,
  role,
  status: 'ACTIVE',
  department: null,
  password: PASSWORD_HASH,
  phone: null,
  organizationRole: roleKey ? { key: roleKey, isSystem: true, permissions: [] } : null,
  permissionOverrides: [],
});

type Profile = {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  displayName: string;
};
type Credential = {
  id: string;
  organizationId: string;
  staffProfileId: string;
  deviceId: string | null;
  type: string;
  credentialHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Where = Record<string, unknown>;

function world() {
  const users = new Map<string, Member>(
    [
      member('owner', 'EMPLOYEE', 'owner'),
      member('admin', 'ADMIN', null),
      member('manager', 'EMPLOYEE', 'manager'),
      member('cashier', 'EMPLOYEE', 'cashier'),
      member('stranger', 'EMPLOYEE', 'cashier', 'org-2'),
    ].map((user) => [user.id, user])
  );
  const profiles: Profile[] = [];
  const credentials: Credential[] = [];
  let sequence = 0;

  const profileMatches = (profile: Profile | undefined, where: Where | undefined) => {
    if (!where) return true;
    if (!profile) return false;
    if (where.organizationId && profile.organizationId !== where.organizationId) return false;
    if (where.status && profile.status !== where.status) return false;
    const userId = where.userId as string | { in: string[] } | undefined;
    if (typeof userId === 'string' && profile.userId !== userId) return false;
    if (userId && typeof userId === 'object' && !userId.in.includes(profile.userId)) return false;
    return true;
  };
  const credentialMatches = (row: Credential, where: Where) => {
    if (where.id && row.id !== where.id) return false;
    if (where.organizationId && row.organizationId !== where.organizationId) return false;
    if (where.type && row.type !== where.type) return false;
    if ('deviceId' in where && row.deviceId !== where.deviceId) return false;
    if ('staffProfileId' in where && row.staffProfileId !== where.staffProfileId) return false;
    if ('revokedAt' in where) {
      if (where.revokedAt === null && row.revokedAt !== null) return false;
      if (where.revokedAt && typeof where.revokedAt === 'object' && row.revokedAt === null)
        return false;
    }
    const profile = profiles.find((candidate) => candidate.id === row.staffProfileId);
    return profileMatches(profile, where.staffProfile as Where | undefined);
  };
  const newest = (rows: Credential[]) =>
    [...rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : 1)
    );
  const withProfile = (row: Credential) => ({
    ...row,
    staffProfile: { userId: profiles.find((p) => p.id === row.staffProfileId)!.userId },
  });

  const db = {
    // Called as a tagged template: the SQL text parts, then the bound values.
    $queryRaw: vi.fn(async (strings: readonly string[], ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('FROM users')) {
        const [id, organizationId] = values as [string, string];
        const user = users.get(id);
        return user && user.organizationId === organizationId
          ? [{ id, name: user.name, email: user.email }]
          : [];
      }
      // DEV-1055: the atomic attempt charge authenticateOperator makes before a compare.
      if (isOperatorAttemptCharge(strings as unknown as TemplateStringsArray)) {
        return applyOperatorAttemptCharge((id) => credentials.find((row) => row.id === id), values);
      }
      return [];
    }),
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    organization: { findFirst: vi.fn(async () => ({ requireApprovalAuthenticator: false })) },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; organizationId: string; status?: string } }) => {
          const user = users.get(where.id);
          if (!user || user.organizationId !== where.organizationId) return null;
          if (where.status && user.status !== where.status) return null;
          return user;
        }
      ),
      findMany: vi.fn(
        async ({ where }: { where: { organizationId: string; id: { not: string } } }) =>
          [...users.values()].filter(
            (user) => user.organizationId === where.organizationId && user.id !== where.id.not
          )
      ),
    },
    restaurantBranch: {
      // The organization also runs a restaurant branch, its default one.
      findFirst: vi.fn(async () => ({ id: 'restaurant-branch-1' })),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        shiftSignInEnforced: false,
      })),
    },
    restaurantStaffProfile: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const rows = profiles.filter(
          (profile) => profileMatches(profile, where) && (!where.id || profile.id === where.id)
        );
        return rows[0] ?? null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          profiles.find((profile) => profile.id === where.id) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Omit<Profile, 'id'> }) => {
        const profile = { ...data, id: `profile-${++sequence}` };
        profiles.push(profile);
        return { id: profile.id, primaryBranchId: null };
      }),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          newest(credentials.filter((row) => credentialMatches(row, where)))[0] ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        credentials.filter((row) => credentialMatches(row, where)).map(withProfile)
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          credentials.find((row) => row.id === where.id) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Partial<Credential> }) => {
        const profile = profiles.find((p) => p.id === data.staffProfileId)!;
        const row: Credential = {
          id: `credential-${++sequence}`,
          organizationId: profile.organizationId,
          staffProfileId: data.staffProfileId!,
          deviceId: data.deviceId ?? null,
          type: data.type!,
          credentialHash: data.credentialHash!,
          failedAttempts: 0,
          lockedUntil: null,
          revokedAt: null,
          createdAt: new Date(Date.now() + sequence),
          updatedAt: new Date(),
        };
        credentials.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<Credential> }) => {
          const row = credentials.find((candidate) => candidate.id === where.id)!;
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        }
      ),
    },
  };

  const caller = (userId: string, options: { support?: boolean } = {}) => {
    const user = users.get(userId)!;
    const context = {
      db,
      entitlements: {
        organizationId: user.organizationId,
        enabledModules: ['pharmacy-core'],
        modules: [],
      },
      session: {
        expires: 'later',
        user: {
          id: user.id,
          role: user.role,
          status: 'ACTIVE',
          organizationId: user.organizationId,
          isSupportSession: options.support ?? false,
        },
      },
      organization: { id: user.organizationId },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext;
    return app.createCaller(context).pharmacyPin;
  };

  return { users, profiles, credentials, caller, db };
}

const save = (pin: string, currentPassword = PASSWORD) => ({
  currentPassword,
  pin,
  confirmPin: pin,
});

function auditDetails() {
  return audit.annotateAudit.mock.calls.map(([, detail]) => detail as Record<string, unknown>);
}

beforeEach(() => {
  audit.annotateAudit.mockClear();
  vi.mocked(rateLimit).mockResolvedValue({ ok: true, retryAfter: 0, remaining: 1 });
  abac.staffManagers.clear();
});

describe('pharmacyPin.setMine', () => {
  it('lets a new solo owner create his PIN: a profile, a bcrypt hash and an audit row without the PIN', async () => {
    const w = world();
    expect(await w.caller('owner').status()).toMatchObject({ state: 'NOT_SET', locked: false });

    await expect(w.caller('owner').setMine(save('583917'))).resolves.toEqual({
      action: 'created',
      state: 'SET',
    });

    expect(w.profiles).toEqual([
      expect.objectContaining({ organizationId: ORG, userId: 'owner', status: 'ACTIVE' }),
    ]);
    expect(w.credentials).toHaveLength(1);
    const [credential] = w.credentials;
    expect(credential).toMatchObject({ type: 'PIN', deviceId: null, revokedAt: null });
    expect(credential!.credentialHash).not.toContain('583917');
    expect(compareSync('583917', credential!.credentialHash)).toBe(true);
    expect(await w.caller('owner').status()).toMatchObject({ state: 'SET' });

    const details = auditDetails();
    expect(details.every((detail) => detail.skipInput === true || !('skipInput' in detail))).toBe(
      true
    );
    expect(details[0]).toMatchObject({ skipInput: true });
    expect(details.at(-1)).toMatchObject({
      operation: 'CREATE',
      targetType: 'User',
      targetId: 'owner',
      description: 'Created their own PIN',
      metadata: expect.objectContaining({
        pinAction: 'created',
        forUserId: 'owner',
        byUserId: 'owner',
      }),
    });
    expect(JSON.stringify(details)).not.toContain('583917');
    expect(JSON.stringify(details)).not.toContain(PASSWORD);
  });

  it('changes an existing PIN in place and clears its strikes', async () => {
    const w = world();
    await w.caller('owner').setMine(save('583917'));
    Object.assign(w.credentials[0]!, {
      failedAttempts: 4,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    expect(await w.caller('owner').status()).toMatchObject({ state: 'SET', locked: true });

    await expect(w.caller('owner').setMine(save('2580'))).resolves.toMatchObject({
      action: 'changed',
    });

    expect(w.credentials).toHaveLength(1);
    expect(w.credentials[0]).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    expect(compareSync('2580', w.credentials[0]!.credentialHash)).toBe(true);
    expect(auditDetails().at(-1)).toMatchObject({
      operation: 'UPDATE',
      description: 'Changed their own PIN',
      metadata: expect.objectContaining({ pinAction: 'changed' }),
    });
  });

  it('refuses a wrong password, and saves nothing', async () => {
    const w = world();
    await expect(
      w.caller('owner').setMine(save('583917', 'not my password'))
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your current password is incorrect.',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it('rate limits password attempts per person', async () => {
    const w = world();
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, retryAfter: 60, remaining: 0 });
    await expect(w.caller('owner').setMine(save('583917'))).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(rateLimit).toHaveBeenCalledWith('pharmacy-pin-reauth:owner', 5, 15 * 60_000);
    expect(w.credentials).toHaveLength(0);
  });

  it.each(['0000', '1234', '1212', '987654'])('refuses the easy PIN %s', async (pin) => {
    const w = world();
    await expect(w.caller('owner').setMine(save(pin))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That PIN is too easy to guess. Choose a different one.',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it('refuses a PIN that is not 4 to 8 digits, or that was not typed the same twice', async () => {
    const w = world();
    await expect(w.caller('owner').setMine(save('58a917'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      w.caller('owner').setMine({ currentPassword: PASSWORD, pin: '583917', confirmPin: '583918' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'The two PINs do not match.' });
    expect(w.credentials).toHaveLength(0);
  });

  it('refuses a support session', async () => {
    const w = world();
    await expect(
      w.caller('owner', { support: true }).setMine(save('583917'))
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A support session cannot set or reset a PIN.',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it('refuses a suspended staff profile', async () => {
    const w = world();
    w.profiles.push({
      id: 'p-cashier',
      organizationId: ORG,
      userId: 'cashier',
      status: 'SUSPENDED',
      displayName: 'Cashier',
    });
    await expect(w.caller('cashier').setMine(save('583917'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it('never takes another person: the input has no user id', async () => {
    const w = world();
    await expect(
      w.caller('owner').setMine({ ...save('583917'), userId: 'cashier' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(w.credentials).toHaveLength(0);
  });
});

describe('pharmacyPin.setMine rules and reach', () => {
  it.each(['1990', '2024'])('refuses the year-like PIN %s', async (pin) => {
    const w = world();
    await expect(w.caller('owner').setMine(save(pin))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That PIN is too easy to guess. Choose a different one.',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it("refuses the end of the person's own phone number, read on the server", async () => {
    const w = world();
    w.users.get('owner')!.phone = '+92 300 1583917';
    await expect(w.caller('owner').setMine(save('583917'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That PIN is the end of your phone number. Choose a different one.',
    });
    expect(w.credentials).toHaveLength(0);
  });

  it('gives a new profile no branch, so the PIN can never unlock a restaurant terminal', async () => {
    const w = world();
    await w.caller('cashier').setMine(save('583917'));
    const [profile] = w.profiles;
    expect(profile).toMatchObject({ userId: 'cashier', status: 'ACTIVE', primaryBranchId: null });
    const signIn = (branchId?: string) =>
      authenticateOperator(w.db as unknown as ScopedDb, {
        staffProfileId: profile!.id,
        deviceId: 'terminal-1',
        branchId,
        type: 'PIN',
        secret: '583917',
        now: new Date(),
      });
    // A terminal always names its branch; no branch matches a profile without one.
    await expect(signIn('restaurant-branch-1')).resolves.toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    // The PIN itself is right: the branch rule is what keeps it off terminals.
    await expect(signIn(undefined)).resolves.toMatchObject({ ok: true });
  });
});

describe('pharmacyPin.resetForMember', () => {
  async function withCashierPin() {
    const w = world();
    await w.caller('cashier').setMine(save('583917'));
    audit.annotateAudit.mockClear();
    return w;
  }

  it('lets the owner reset a cashier PIN: it is revoked and the cashier creates a new one', async () => {
    const w = await withCashierPin();
    expect(await w.caller('owner').members()).toContainEqual({
      id: 'cashier',
      name: 'Cashier',
      hasPin: true,
      canReset: true,
    });

    await expect(
      w.caller('owner').resetForMember({ userId: 'cashier', currentPassword: PASSWORD })
    ).resolves.toEqual({ reset: true });

    expect(w.credentials[0]!.revokedAt).toBeInstanceOf(Date);
    expect(await w.caller('cashier').status()).toMatchObject({ state: 'RESET' });
    expect(auditDetails().at(-1)).toMatchObject({
      targetType: 'User',
      targetId: 'cashier',
      description: "Reset a staff member's PIN",
      metadata: { pinAction: 'reset', forUserId: 'cashier', byUserId: 'owner', revoked: 1 },
    });

    await w.caller('cashier').setMine(save('2580'));
    expect(w.credentials.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(await w.caller('cashier').status()).toMatchObject({ state: 'SET' });
  });

  it('lets a manager granted staff management reset a cashier, but not the owner or an administrator', async () => {
    const w = await withCashierPin();
    await w.caller('admin').setMine(save('2580'));
    abac.staffManagers.add('manager');
    expect(await w.caller('manager').status()).toMatchObject({ canResetOthers: true });

    await expect(
      w.caller('manager').resetForMember({ userId: 'admin', currentPassword: PASSWORD })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: "Only the owner can reset this person's PIN.",
    });
    await expect(
      w.caller('manager').resetForMember({ userId: 'owner', currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.caller('manager').resetForMember({ userId: 'cashier', currentPassword: PASSWORD })
    ).resolves.toEqual({ reset: true });
  });

  it('refuses a member without the staff-management right', async () => {
    const w = await withCashierPin();
    expect(await w.caller('manager').status()).toMatchObject({ canResetOthers: false });
    await expect(w.caller('manager').members()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.caller('manager').resetForMember({ userId: 'cashier', currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.credentials[0]!.revokedAt).toBeNull();
  });

  it('refuses resetting your own PIN here, a wrong password, and a support session', async () => {
    const w = await withCashierPin();
    await w.caller('owner').setMine(save('2580'));
    await expect(
      w.caller('owner').resetForMember({ userId: 'owner', currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      w.caller('owner').resetForMember({ userId: 'cashier', currentPassword: 'wrong' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Your current password is incorrect.' });
    await expect(
      w
        .caller('owner', { support: true })
        .resetForMember({ userId: 'cashier', currentPassword: PASSWORD })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A support session cannot set or reset a PIN.',
    });
    expect(w.credentials.every((row) => row.revokedAt === null)).toBe(true);
  });

  it('only revokes: a reset carrying a PIN is refused and sets nothing', async () => {
    const w = await withCashierPin();
    const before = w.credentials[0]!.credentialHash;
    await expect(
      w.caller('owner').resetForMember({
        userId: 'cashier',
        currentPassword: PASSWORD,
        pin: '2580',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(w.credentials).toHaveLength(1);
    expect(w.credentials[0]).toMatchObject({ credentialHash: before, revokedAt: null });

    await w.caller('owner').resetForMember({ userId: 'cashier', currentPassword: PASSWORD });
    // Nothing new was issued: the cashier has no live PIN until they create one themselves.
    expect(w.credentials).toHaveLength(1);
    expect(w.credentials.filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect(await w.caller('cashier').status()).toMatchObject({ state: 'RESET' });
  });

  it('cannot reach a member of another organization', async () => {
    const w = await withCashierPin();
    await expect(
      w.caller('owner').resetForMember({ userId: 'stranger', currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await w.caller('owner').members()).map((row) => row.id)).not.toContain('stranger');
  });
});
