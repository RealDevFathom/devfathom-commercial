import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: vi.fn(), subjectFromSession: (user: unknown) => user }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'dummy-hash') }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  OPERATOR_CREDENTIAL_BCRYPT_COST: 12,
  verifyOperatorCredential: vi.fn(),
  isLockedOut: vi.fn(() => false),
  clearLockout: () => ({ failedAttempts: 0, lockedUntil: null }),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));

import { authorizeCounterApproval, CounterApprovalDenied } from './counter-line-approval';
import { verifyRefundPin } from './refund-authorization';
import { can } from '@/lib/abac';
import { isLockedOut, verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { encryptSecret } from '@/lib/secret-crypto';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { generateTotpSecret } from '@/lib/totp';

/**
 * DEV-879 through the real approval paths: the counter discount / Khata / FEFO approval and
 * the manager-or-owner refund re-authentication, with the real `verifyApprovalSecret`. Only
 * the database, ABAC and bcrypt are faked.
 */

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

const SECRET = generateTotpSecret();
const currentCode = () => codeAt(SECRET, Math.floor(Date.now() / 30_000));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'cashier' };
const cashier = { id: 'cashier', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };
const manager = { id: 'manager', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };
const owner = { id: 'owner', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };

function fixture(options: {
  actor?: typeof cashier;
  approver?: typeof manager;
  holders?: string[];
  others?: Array<typeof manager>;
  enrolled?: string[];
}) {
  const approver = options.approver ?? manager;
  const holders = options.holders ?? [approver.id];
  vi.mocked(can).mockImplementation(async (subject) => holders.includes(subject.id));
  vi.mocked(verifyOperatorCredential).mockImplementation(
    async (_type, secret, credentialHash) => credentialHash === `hash:${secret}`
  );
  const lastUsed = new Map<string, number>();
  const enrolled = new Set(options.enrolled ?? []);
  const db = {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn().mockResolvedValue(options.actor ?? cashier) },
    organization: {
      findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }),
    },
    approvalAuthenticator: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        enrolled.has(where.userId)
          ? { id: `auth_${where.userId}`, encryptedSecret: encryptSecret(SECRET) }
          : null
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { lastUsedStep: number } }) => {
          const previous = lastUsed.get(where.id);
          if (previous !== undefined && previous >= data.lastUsedStep) return { count: 0 };
          lastUsed.set(where.id, data.lastUsedStep);
          return { count: 1 };
        }
      ),
    },
    auditLog: { create: vi.fn() },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cred',
        credentialHash: 'hash:1234',
        failedAttempts: 0,
        lockedUntil: null,
        staffProfile: { status: 'ACTIVE', user: approver },
      }),
      findMany: vi.fn().mockResolvedValue(
        (options.others ?? [approver]).map((user, index) => ({
          id: `cred-${index}`,
          staffProfile: { status: 'ACTIVE', user },
        }))
      ),
      update: vi.fn(),
    },
  };
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) => run(db as never));
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLockedOut).mockReturnValue(false);
});

describe('DEV-879 counter approvals with an authenticator code', () => {
  it('approves a discount with the manager’s current code and audits the code use', async () => {
    const db = fixture({ enrolled: ['manager'] });
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', {
        staffProfileId: 'staff-manager',
        pin: currentCode(),
      })
    ).resolves.toMatchObject({ approvedByUserId: 'manager', selfApproved: false });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'manager',
        action: 'pharmacy.counterApproval.DISCOUNT',
        metadata: expect.objectContaining({ approvalMethod: 'AUTHENTICATOR' }),
      }),
    });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  it('refuses the enrolled manager’s old PIN and strikes the lockout counter', async () => {
    const db = fixture({ enrolled: ['manager'] });
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', {
        staffProfileId: 'staff-manager',
        pin: '1234',
      })
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
  });

  it('refuses a reused code and counts it as a failed attempt', async () => {
    const db = fixture({ enrolled: ['manager'] });
    const code = currentCode();
    const pin = { staffProfileId: 'staff-manager', pin: code };
    await authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin);
    db.restaurantOperatorCredential.update.mockClear();
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
  });

  it('refuses a locked-out approver without consuming their code', async () => {
    const db = fixture({ enrolled: ['manager'] });
    vi.mocked(isLockedOut).mockReturnValue(true);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', {
        staffProfileId: 'staff-manager',
        pin: currentCode(),
      })
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.approvalAuthenticator.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not let a manager approve their own discount with a code while another approver exists', async () => {
    const db = fixture({
      actor: manager,
      approver: manager,
      holders: ['manager', 'owner'],
      others: [owner],
      enrolled: ['manager'],
    });
    await expect(
      authorizeCounterApproval(db as never, { ...scope, actorId: 'manager' }, 'DISCOUNT', {
        staffProfileId: 'staff-manager',
        pin: currentCode(),
      })
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.approvalAuthenticator.updateMany).not.toHaveBeenCalled();
  });

  it('lets a solo owner self-approve with their own fresh code, recorded as self-approved', async () => {
    const db = fixture({
      actor: owner,
      approver: owner,
      holders: ['owner'],
      others: [],
      enrolled: ['owner'],
    });
    await expect(
      authorizeCounterApproval(db as never, { ...scope, actorId: 'owner' }, 'DISCOUNT', {
        staffProfileId: 'staff-owner',
        pin: currentCode(),
      })
    ).resolves.toMatchObject({
      approvedByUserId: 'owner',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
    });
    expect(db.auditLog.create).toHaveBeenCalledOnce();
  });
});

describe('DEV-879 manager or owner refunds with an authenticator code', () => {
  const input = { organizationId: 'org', actorId: 'manager', action: 'pharmacySales.refundTender' };

  it('re-authenticates an enrolled manager with their current code', async () => {
    const db = fixture({ enrolled: ['manager'] });
    await expect(verifyRefundPin(db as never, { ...input, pin: currentCode() })).resolves.toEqual({
      verified: true,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'pharmacySales.refundTender', actorId: 'manager' }),
    });
  });

  it('refuses the enrolled manager’s fixed PIN for a refund and records the strike', async () => {
    const db = fixture({ enrolled: ['manager'] });
    await expect(verifyRefundPin(db as never, { ...input, pin: '1234' })).resolves.toHaveProperty(
      'blocked'
    );
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
  });

  it('keeps accepting the PIN of a manager who has not enrolled', async () => {
    const db = fixture({});
    await expect(verifyRefundPin(db as never, { ...input, pin: '1234' })).resolves.toEqual({
      verified: true,
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
