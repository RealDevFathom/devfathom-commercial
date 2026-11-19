import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const audit = vi.hoisted(() => ({ annotateAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: audit.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
// DEV-961: who can approve, decided by the real classifier unless a case names the holders.
const gateMocks = vi.hoisted(() => ({ holders: null as string[] | null }));
vi.mock('@/lib/approval-authenticator-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/approval-authenticator-gate')>();
  return {
    ...actual,
    holdsAnyApprovalRight: vi.fn(async (db: never, input: { userId: string }) =>
      gateMocks.holders
        ? gateMocks.holders.includes(input.userId)
        : actual.holdsAnyApprovalRight(db, input as never)
    ),
  };
});

import { hashSync } from 'bcryptjs';
import { router, type TRPCContext } from '../trpc';
import { approvalAuthenticatorRouter } from './approval-authenticator';
import { decryptSecret } from '@/lib/secret-crypto';
import { rateLimit } from '@/lib/rate-limit';

const app = router({ approvalAuthenticator: approvalAuthenticatorRouter });
const PASSWORD = 'member current password';
const PASSWORD_HASH = hashSync(PASSWORD, 4);

function codeAt(secretB32: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const value = hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

type Party = {
  id: string;
  role: string;
  status: string;
  organizationRole: { key: string; isSystem: boolean; permissions: [] } | null;
  permissionOverrides: [];
};
const party = (id: string, role: string, roleKey: string | null): Party => ({
  id,
  role,
  status: 'ACTIVE',
  organizationRole: roleKey ? { key: roleKey, isSystem: true, permissions: [] } : null,
  permissionOverrides: [],
});
const MEMBERS: Record<string, Party> = {
  owner: party('owner', 'EMPLOYEE', 'owner'),
  admin: party('admin', 'ADMIN', null),
  manager: party('manager', 'EMPLOYEE', 'manager'),
  // DEV-961: provisioned by single sign-on or SCIM, with no password.
  sso: party('sso', 'EMPLOYEE', 'manager'),
};

type AuthRow = {
  id: string;
  organizationId: string;
  userId: string;
  encryptedSecret: string;
  enabledAt: Date | null;
  lastUsedStep: number | null;
};

type RecoveryRow = { userId: string; codeHash: string; usedAt: Date | null };

function setup(userId: keyof typeof MEMBERS, sessionExtra: Record<string, unknown> = {}) {
  const rows = new Map<string, AuthRow>();
  const recovery: RecoveryRow[] = [];
  const organization = { requireApprovalAuthenticator: false };
  const recoveryMatches = (
    row: RecoveryRow,
    where: { userId?: string; codeHash?: string; usedAt?: null }
  ) =>
    (where.userId === undefined || row.userId === where.userId) &&
    (where.codeHash === undefined || row.codeHash === where.codeHash) &&
    (where.usedAt === undefined || row.usedAt === null);
  const db = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        MEMBERS[where.id]
          ? {
              ...MEMBERS[where.id],
              email: `${where.id}@example.test`,
              password: where.id === 'sso' ? null : PASSWORD_HASH,
            }
          : null
      ),
      findMany: vi.fn(async () =>
        Object.values(MEMBERS).map((member) => ({ id: member.id, name: member.id }))
      ),
    },
    notification: { createMany: vi.fn() },
    organization: {
      findFirst: vi.fn(async () => ({ ...organization })),
      update: vi.fn(async ({ data }: { data: { requireApprovalAuthenticator: boolean } }) => {
        organization.requireApprovalAuthenticator = data.requireApprovalAuthenticator;
        return { ...organization };
      }),
    },
    approvalAuthenticator: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const row = rows.get(where.userId);
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async () =>
        [...rows.values()].filter((row) => row.enabledAt).map((row) => ({ userId: row.userId }))
      ),
      upsert: vi.fn(
        async (args: {
          create: { organizationId: string; userId: string; encryptedSecret: string };
          update: { encryptedSecret: string };
        }) => {
          rows.set(args.create.userId, {
            id: `auth_${args.create.userId}`,
            ...args.create,
            enabledAt: null,
            lastUsedStep: null,
          });
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id: string;
            enabledAt: null | { not: null };
            encryptedSecret?: string;
            OR?: unknown[];
          };
          data: { enabledAt?: Date; lastUsedStep: number };
        }) => {
          const row = [...rows.values()].find((candidate) => candidate.id === where.id);
          if (where.OR) {
            // Consuming a code: only a confirmed row, only a newer step.
            if (!row || !row.enabledAt) return { count: 0 };
            if (row.lastUsedStep !== null && row.lastUsedStep >= data.lastUsedStep)
              return { count: 0 };
            row.lastUsedStep = data.lastUsedStep;
            return { count: 1 };
          }
          if (!row || row.enabledAt || row.encryptedSecret !== where.encryptedSecret)
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => ({
        count: rows.delete(where.userId) ? 1 : 0,
      })),
    },
    approvalAuthenticatorRecoveryCode: {
      count: vi.fn(
        async ({ where }: { where: { userId: string; usedAt: null } }) =>
          recovery.filter((row) => recoveryMatches(row, where)).length
      ),
      createMany: vi.fn(async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
        for (const row of data) recovery.push({ ...row, usedAt: null });
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; usedAt?: null } }) => {
        const before = recovery.length;
        for (let i = recovery.length - 1; i >= 0; i--)
          if (recoveryMatches(recovery[i], where)) recovery.splice(i, 1);
        return { count: before - recovery.length };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string; codeHash: string; usedAt: null };
          data: { usedAt: Date };
        }) => {
          const matched = recovery.filter((row) => recoveryMatches(row, where));
          for (const row of matched) row.usedAt = data.usedAt;
          return { count: matched.length };
        }
      ),
    },
    auditLog: { create: vi.fn() },
    restaurantStaffProfile: {
      findMany: vi.fn(async () => [{ id: 'staff_floor', displayName: 'Floor operator' }]),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: {
      organizationId: 'org',
      enabledModules: [],
      modules: [],
      activeSeats: 1,
      seatLimit: 50,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role: MEMBERS[userId].role,
        status: 'ACTIVE',
        organizationId: 'org',
        approvalApprover: true,
        ...sessionExtra,
      },
    },
    organization: { id: 'org', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).approvalAuthenticator;
  return { caller, db, rows, recovery, organization };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('approvalAuthenticator enrolment (DEV-879)', () => {
  it('stores only the encrypted secret and activates it after one valid code', async () => {
    const { caller, rows } = setup('manager');
    const started = await caller.beginEnrollment({ currentPassword: PASSWORD });
    expect(started.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const row = rows.get('manager')!;
    expect(row.encryptedSecret).not.toContain(started.secret);
    expect(decryptSecret(row.encryptedSecret)).toBe(started.secret);
    expect(row.enabledAt).toBeNull();

    await expect(caller.confirmEnrollment({ token: '000000' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const step = Math.floor(Date.now() / 30_000);
    await expect(
      caller.confirmEnrollment({ token: codeAt(started.secret, step) })
    ).resolves.toEqual({ enrolled: true, recoveryCodes: expect.any(Array) });
    expect(rows.get('manager')!.enabledAt).toBeInstanceOf(Date);
    // The code that confirmed enrolment is consumed: it cannot also approve an action.
    expect(rows.get('manager')!.lastUsedStep).toBeGreaterThanOrEqual(step - 1);
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: 'Enrolled an approval authenticator' })
    );
    expect(rateLimit).toHaveBeenCalledWith('approval-authenticator-confirm:manager', 10, 900_000);
  });

  it('does not activate a secret replaced by a restarted set-up', async () => {
    const { caller, db, rows } = setup('manager');
    const first = await caller.beginEnrollment({ currentPassword: PASSWORD });
    const code = codeAt(first.secret, Math.floor(Date.now() / 30_000));
    // Another tab restarts set-up after this confirmation read the first secret.
    const read = db.approvalAuthenticator.findFirst.getMockImplementation()!;
    db.approvalAuthenticator.findFirst.mockImplementationOnce(async (args) => {
      const pending = await read(args);
      await caller.beginEnrollment({ currentPassword: PASSWORD });
      return pending;
    });
    await expect(caller.confirmEnrollment({ token: code })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(rows.get('manager')!.enabledAt).toBeNull();
  });

  it('refuses to start enrolment on a live session alone, without the current password', async () => {
    const { caller, rows } = setup('manager');
    await expect(
      caller.beginEnrollment({ currentPassword: 'not the password' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rows.has('manager')).toBe(false);
    expect(rateLimit).toHaveBeenCalledWith('approval-authenticator-reauth:manager', 5, 900_000);
  });

  it('never returns the secret from the status read', async () => {
    const { caller } = setup('manager');
    const started = await caller.beginEnrollment({ currentPassword: PASSWORD });
    const status = await caller.getStatus();
    expect(JSON.stringify(status)).not.toContain(started.secret);
    expect(status).toMatchObject({ enrolled: false, required: false, isOwner: false });
  });

  it('will not let a member replace a confirmed authenticator on their own', async () => {
    const { caller, rows } = setup('manager');
    const started = await caller.beginEnrollment({ currentPassword: PASSWORD });
    await caller.confirmEnrollment({
      token: codeAt(started.secret, Math.floor(Date.now() / 30_000)),
    });
    await expect(caller.beginEnrollment({ currentPassword: PASSWORD })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(rows.get('manager')!.enabledAt).toBeInstanceOf(Date);
  });
});

describe('approvalAuthenticator recovery and the owner setting (DEV-879)', () => {
  it('lets the owner reset a member, with an audit record', async () => {
    const { caller, rows } = setup('owner');
    rows.set('manager', {
      id: 'auth_manager',
      organizationId: 'org',
      userId: 'manager',
      encryptedSecret: 'v1.x.y.z',
      enabledAt: new Date(),
      lastUsedStep: 1,
    });
    await expect(
      caller.resetForMember({ userId: 'manager', currentPassword: PASSWORD })
    ).resolves.toEqual({ reset: true });
    expect(rows.has('manager')).toBe(false);
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'manager',
        metadata: expect.objectContaining({ approvalAuthenticator: 'reset', resetById: 'owner' }),
      })
    );
  });

  it('refuses an owner reset without the owner’s current password', async () => {
    const { caller, rows, db } = setup('owner');
    rows.set('owner', {
      id: 'auth_owner',
      organizationId: 'org',
      userId: 'owner',
      encryptedSecret: 'v1.x.y.z',
      enabledAt: new Date(),
      lastUsedStep: 1,
    });
    await expect(
      caller.resetForMember({ userId: 'owner', currentPassword: 'guess' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.approvalAuthenticator.deleteMany).not.toHaveBeenCalled();
    // With the password, the owner can recover their own lost authenticator.
    await expect(
      caller.resetForMember({ userId: 'owner', currentPassword: PASSWORD })
    ).resolves.toEqual({ reset: true });
  });

  it('refuses a reset by a member who is neither the owner nor an administrator', async () => {
    const { caller, db } = setup('manager');
    await expect(
      caller.resetForMember({ userId: 'manager', currentPassword: PASSWORD })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.approvalAuthenticator.deleteMany).not.toHaveBeenCalled();
    await expect(caller.members()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets only the owner require an authenticator for every approval', async () => {
    const admin = setup('admin');
    await expect(admin.caller.setRequired({ required: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(admin.db.organization.update).not.toHaveBeenCalled();

    const owner = setup('owner');
    await expect(owner.caller.setRequired({ required: true })).resolves.toEqual({
      required: true,
      withoutPin: [],
    });
    expect(owner.organization.requireApprovalAuthenticator).toBe(true);
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'Organization',
        metadata: { requireApprovalAuthenticator: true },
      })
    );
  });
});

/** Enrol `userId` through the real procedures; returns the secret and the recovery codes. */
async function enrol(caller: ReturnType<typeof setup>['caller']) {
  const started = await caller.beginEnrollment({ currentPassword: PASSWORD });
  const confirmed = await caller.confirmEnrollment({
    token: codeAt(started.secret, Math.floor(Date.now() / 30_000)),
  });
  return { secret: started.secret, recoveryCodes: confirmed.recoveryCodes };
}

describe('DEV-961 recovery codes', () => {
  it('shows ten one-time recovery codes once and stores only their hashes', async () => {
    const { caller, recovery } = setup('manager');
    const { recoveryCodes } = await enrol(caller);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recovery).toHaveLength(10);
    const stored = JSON.stringify(recovery);
    for (const code of recoveryCodes) expect(stored).not.toContain(code);
    for (const row of recovery) expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // The status read reports how many are left, never the codes.
    const status = await caller.getStatus();
    expect(status.recoveryCodesLeft).toBe(10);
    expect(JSON.stringify(status)).not.toContain(recoveryCodes[0]);
  });

  it('rate-limits starting a set-up', async () => {
    const { caller } = setup('manager');
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, retryAfter: 60 } as never);
    await expect(caller.beginEnrollment({ currentPassword: PASSWORD })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(rateLimit).toHaveBeenCalledWith('approval-authenticator-begin:manager', 10, 900_000);
  });

  it('spends a recovery code once, removes the authenticator and forces a new set-up, audited', async () => {
    const { caller, rows, recovery } = setup('manager');
    const { recoveryCodes } = await enrol(caller);
    await expect(
      caller.useRecoveryCode({ code: recoveryCodes[3], currentPassword: PASSWORD })
    ).resolves.toEqual({ reset: true });
    expect(rows.has('manager')).toBe(false);
    // The spent code is kept, stamped; every other code stopped working.
    expect(recovery).toHaveLength(1);
    expect(recovery[0].usedAt).toBeInstanceOf(Date);
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'manager',
        metadata: expect.objectContaining({ approvalAuthenticator: 'recovery-code-used' }),
      })
    );
    // Single use, and the remaining codes are gone.
    for (const code of [recoveryCodes[3], recoveryCodes[4]])
      await expect(
        caller.useRecoveryCode({ code, currentPassword: PASSWORD })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // The member can set up a new authenticator straight away.
    await expect(caller.beginEnrollment({ currentPassword: PASSWORD })).resolves.toMatchObject({
      otpauthUri: expect.stringMatching(/^otpauth:/),
    });
  });

  it('needs the password as well as the code, and rate-limits recovery attempts', async () => {
    const { caller, rows } = setup('manager');
    const { recoveryCodes } = await enrol(caller);
    await expect(
      caller.useRecoveryCode({ code: recoveryCodes[0], currentPassword: 'wrong' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(rows.get('manager')?.enabledAt).toBeInstanceOf(Date);
    await expect(
      caller.useRecoveryCode({ code: 'aaaaa-bbbbb', currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(rows.get('manager')?.enabledAt).toBeInstanceOf(Date);
    expect(rateLimit).toHaveBeenCalledWith('approval-authenticator-recovery:manager', 5, 900_000);
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, retryAfter: 60 } as never);
    await expect(
      caller.useRecoveryCode({ code: recoveryCodes[0], currentPassword: PASSWORD })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(rows.get('manager')?.enabledAt).toBeInstanceOf(Date);
  });

  it('a reset by another owner also removes the member recovery codes, without seeing the secret', async () => {
    const member = setup('manager');
    const { secret } = await enrol(member.caller);
    const owner = setup('owner');
    // Share the member's rows with the owner's view of the same organization.
    owner.rows.set('manager', member.rows.get('manager')!);
    owner.recovery.push(...member.recovery.map((row) => ({ ...row })));
    const result = await owner.caller.resetForMember({
      userId: 'manager',
      currentPassword: PASSWORD,
    });
    expect(result).toEqual({ reset: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(owner.rows.has('manager')).toBe(false);
    expect(owner.recovery).toHaveLength(0);
  });

  it('lists terminal-only staff who cannot use an authenticator for the owner', async () => {
    const { caller, db } = setup('owner');
    await expect(caller.terminalOnlyApprovers()).resolves.toEqual([
      { id: 'staff_floor', displayName: 'Floor operator' },
    ]);
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: null,
          status: 'ACTIVE',
          credentials: { some: { type: 'PIN', revokedAt: null } },
        }),
      })
    );
    const manager = setup('manager');
    await expect(manager.caller.terminalOnlyApprovers()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('DEV-961 turning the authenticator off', () => {
  it('needs the owner’s own current code when they have set one up', async () => {
    const { caller, organization, db } = setup('owner');
    organization.requireApprovalAuthenticator = true;
    const { secret } = await enrol(caller);
    await expect(caller.setRequired({ required: false, code: '000000' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // A password is not enough once they have an authenticator.
    await expect(
      caller.setRequired({ required: false, currentPassword: PASSWORD, acknowledged: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.organization.update).not.toHaveBeenCalled();
    expect(organization.requireApprovalAuthenticator).toBe(true);
    const next = Math.floor(Date.now() / 30_000) + 1;
    await expect(
      caller.setRequired({ required: false, code: codeAt(secret, next) })
    ).resolves.toEqual({ required: false, withoutPin: [] });
    expect(organization.requireApprovalAuthenticator).toBe(false);
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'Organization',
        metadata: {
          requireApprovalAuthenticator: false,
          confirmedWith: 'AUTHENTICATOR',
          askedToSetPin: [],
        },
      })
    );
    // The confirming code is single use.
    organization.requireApprovalAuthenticator = true;
    await expect(
      caller.setRequired({ required: false, code: codeAt(secret, next) })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(organization.requireApprovalAuthenticator).toBe(true);
  });

  it('takes the password and a plain acknowledgement from an owner with no authenticator yet', async () => {
    const { caller, organization } = setup('owner');
    organization.requireApprovalAuthenticator = true;
    await expect(
      caller.setRequired({ required: false, currentPassword: 'wrong', acknowledged: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.setRequired({ required: false, currentPassword: PASSWORD } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.setRequired({ required: false } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(organization.requireApprovalAuthenticator).toBe(true);
    await expect(
      caller.setRequired({ required: false, currentPassword: PASSWORD, acknowledged: true })
    ).resolves.toEqual({ required: false, withoutPin: [] });
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: {
          requireApprovalAuthenticator: false,
          confirmedWith: 'PASSWORD',
          askedToSetPin: [],
        },
      })
    );
  });

  it('asks everyone who can approve and has no PIN to set one, and tells the owner who', async () => {
    const { caller, organization, db } = setup('owner');
    organization.requireApprovalAuthenticator = true;
    // The query returns members with no live PIN; of those, only the manager can approve.
    gateMocks.holders = ['manager'];
    try {
      await expect(
        caller.setRequired({ required: false, currentPassword: PASSWORD, acknowledged: true })
      ).resolves.toEqual({ required: false, withoutPin: [{ id: 'manager', name: 'manager' }] });
    } finally {
      gateMocks.holders = null;
    }
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          restaurantStaffProfiles: {
            none: {
              status: 'ACTIVE',
              credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
            },
          },
        }),
      })
    );
    expect(db.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'manager',
          type: 'approval_pin_needed',
          title: 'Set your approval PIN',
        }),
      ],
    });
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ askedToSetPin: ['manager'] }),
      })
    );
  });

  it('asks nobody to set a PIN when the owner turns it back on', async () => {
    const { caller, db } = setup('owner');
    gateMocks.holders = ['manager'];
    try {
      await expect(caller.setRequired({ required: true })).resolves.toEqual({
        required: true,
        withoutPin: [],
      });
    } finally {
      gateMocks.holders = null;
    }
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it('refuses anyone but the owner, and rate-limits the confirmation', async () => {
    for (const member of ['admin', 'manager'] as const) {
      const { caller, organization } = setup(member);
      organization.requireApprovalAuthenticator = true;
      await expect(
        caller.setRequired({ required: false, currentPassword: PASSWORD, acknowledged: true })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(organization.requireApprovalAuthenticator).toBe(true);
    }
    const { caller, organization } = setup('owner');
    organization.requireApprovalAuthenticator = true;
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, retryAfter: 60 } as never);
    await expect(
      caller.setRequired({ required: false, currentPassword: PASSWORD, acknowledged: true })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(organization.requireApprovalAuthenticator).toBe(true);
    expect(rateLimit).toHaveBeenCalledWith('approval-authenticator-off:owner', 5, 900_000);
  });
});

describe('DEV-961 status for the set-up screen', () => {
  it('reports set-up as required, live, until the approver confirms a code', async () => {
    const { caller, organization } = setup('manager');
    organization.requireApprovalAuthenticator = true;
    await expect(caller.getStatus()).resolves.toMatchObject({ setupRequired: true });
    await enrol(caller);
    await expect(caller.getStatus()).resolves.toMatchObject({
      setupRequired: false,
      enrolled: true,
    });
  });
});

describe('DEV-961 members with no password (single sign-on, SCIM)', () => {
  const freshly = { signedInAt: Date.now() - 60_000 };

  it('lets a freshly signed-in passwordless approver set up and recover without a password', async () => {
    const { caller, rows } = setup('sso', freshly);
    await expect(caller.getStatus()).resolves.toMatchObject({ passwordless: true });
    const started = await caller.beginEnrollment({});
    const confirmed = await caller.confirmEnrollment({
      token: codeAt(started.secret, Math.floor(Date.now() / 30_000)),
    });
    expect(rows.get('sso')?.enabledAt).toBeInstanceOf(Date);
    await expect(caller.useRecoveryCode({ code: confirmed.recoveryCodes[0] })).resolves.toEqual({
      reset: true,
    });
    expect(rows.has('sso')).toBe(false);
  });

  it('refuses a passwordless member whose sign-in is stale, missing or in the future', async () => {
    for (const extra of [
      { signedInAt: Date.now() - 16 * 60_000 },
      {},
      { signedInAt: Date.now() + 60_000 },
    ]) {
      const { caller, rows } = setup('sso', extra);
      await expect(caller.beginEnrollment({})).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message:
          'For your security, sign out and sign in again, then set up the app straight away.',
      });
      expect(rows.has('sso')).toBe(false);
    }
  });

  it('still needs the password of a member who has one, however fresh the sign-in', async () => {
    const { caller, rows } = setup('manager', freshly);
    await expect(caller.beginEnrollment({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.beginEnrollment({ currentPassword: 'wrong' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(rows.has('manager')).toBe(false);
    await expect(caller.getStatus()).resolves.toMatchObject({ passwordless: false });
  });
});
