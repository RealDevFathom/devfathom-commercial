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
};

type AuthRow = {
  id: string;
  organizationId: string;
  userId: string;
  encryptedSecret: string;
  enabledAt: Date | null;
  lastUsedStep: number | null;
};

function setup(userId: keyof typeof MEMBERS) {
  const rows = new Map<string, AuthRow>();
  const organization = { requireApprovalAuthenticator: false };
  const db = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        MEMBERS[where.id]
          ? { ...MEMBERS[where.id], email: `${where.id}@example.test`, password: PASSWORD_HASH }
          : null
      ),
      findMany: vi.fn(async () =>
        Object.values(MEMBERS).map((member) => ({ id: member.id, name: member.id }))
      ),
    },
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
          where: { id: string; enabledAt: null; encryptedSecret: string };
          data: { enabledAt: Date; lastUsedStep: number };
        }) => {
          const row = [...rows.values()].find((candidate) => candidate.id === where.id);
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
      },
    },
    organization: { id: 'org', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).approvalAuthenticator;
  return { caller, db, rows, organization };
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
    ).resolves.toEqual({ enrolled: true });
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
