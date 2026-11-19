import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
}));

import {
  APPROVAL_TOTP_WINDOW,
  approvalAuthenticatorResetDenial,
  consumeMemberApprovalCode,
  verifyApprovalSecret,
} from './approval-authenticator';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { encryptSecret } from '@/lib/secret-crypto';
import { findForbiddenPersistPath } from '@/lib/retail-terminal/local-store';
import { generateTotpSecret } from '@/lib/totp';

/** An independent RFC 6238 oracle (SHA-1, 6 digits, 30 s) so the tests do not trust totp.ts. */
function codeAt(secretB32: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const value = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

const NOW = new Date(1_800_000_000_000);
const STEP = Math.floor(NOW.getTime() / 30_000);
const SECRET = generateTotpSecret();
const PIN = '4821';

type Row = {
  id: string;
  organizationId: string;
  userId: string;
  encryptedSecret: string;
  enabledAt: Date | null;
  lastUsedStep: number | null;
};

/** An in-memory tenant database that applies the verifier's filters literally. */
function fakeDb(options: { enrolled?: boolean; required?: boolean; organization?: boolean } = {}) {
  const row: Row | null =
    options.enrolled === false
      ? null
      : {
          id: 'auth_manager',
          organizationId: 'org',
          userId: 'manager',
          encryptedSecret: encryptSecret(SECRET),
          enabledAt: new Date(NOW.getTime() - 86_400_000),
          lastUsedStep: null,
        };
  type Where = {
    id?: string;
    organizationId?: string;
    userId?: string;
    enabledAt?: { not: null };
    OR?: Array<{ lastUsedStep: null | { lt: number } }>;
  };
  const matches = (where: Where) =>
    row !== null &&
    (where.id === undefined || where.id === row.id) &&
    (where.organizationId === undefined || where.organizationId === row.organizationId) &&
    (where.userId === undefined || where.userId === row.userId) &&
    (where.enabledAt === undefined || row.enabledAt !== null) &&
    (where.OR === undefined ||
      where.OR.some((clause) =>
        clause.lastUsedStep === null
          ? row.lastUsedStep === null
          : row.lastUsedStep !== null && row.lastUsedStep < clause.lastUsedStep.lt
      ));
  return {
    row,
    organization: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.organization === false || where.id !== 'org'
          ? null
          : { requireApprovalAuthenticator: options.required ?? false }
      ),
    },
    approvalAuthenticator: {
      findFirst: vi.fn(async ({ where }: { where: Where }) =>
        matches(where) && row ? { id: row.id, encryptedSecret: row.encryptedSecret } : null
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Where; data: { lastUsedStep: number } }) => {
          if (!matches(where) || !row) return { count: 0 };
          row.lastUsedStep = data.lastUsedStep;
          return { count: 1 };
        }
      ),
    },
    auditLog: { create: vi.fn() },
  };
}

function verify(db: ReturnType<typeof fakeDb>, secret: string, now = NOW) {
  return verifyApprovalSecret(db as never, {
    organizationId: 'org',
    approverUserId: 'manager',
    credentialHash: `hash:${PIN}`,
    secret,
    action: 'pharmacySales.refundTender',
    approverRight: 'pharmacy:manage',
    requestedById: 'cashier',
    now,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyOperatorCredential).mockImplementation(
    async (_type, secret, credentialHash) => credentialHash === `hash:${secret}`
  );
});

describe('DEV-879 approval authenticator: who uses a PIN and who uses a code', () => {
  it('keeps accepting the PIN of an approver who has not enrolled, so nothing breaks', async () => {
    const db = fakeDb({ enrolled: false });
    await expect(verify(db, PIN)).resolves.toBe('PIN');
    await expect(verify(db, '0000')).resolves.toBeNull();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('accepts the current code of an enrolled approver', async () => {
    const db = fakeDb();
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBe('AUTHENTICATOR');
    expect(db.row?.lastUsedStep).toBe(STEP);
  });

  it('no longer accepts the fixed PIN once the approver has enrolled', async () => {
    const db = fakeDb();
    await expect(verify(db, PIN)).resolves.toBeNull();
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(db.approvalAuthenticator.updateMany).not.toHaveBeenCalled();
  });

  it('refuses every PIN when the owner requires an authenticator for approvals', async () => {
    const db = fakeDb({ enrolled: false, required: true });
    await expect(verify(db, PIN)).resolves.toBeNull();
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('still accepts an enrolled approver code when the organization requires one', async () => {
    const db = fakeDb({ required: true });
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBe('AUTHENTICATOR');
  });

  it('fails closed when the organization cannot be read', async () => {
    const db = fakeDb({ enrolled: false, organization: false });
    await expect(verify(db, PIN)).resolves.toBeNull();
  });

  it('only consults a confirmed enrolment, never a pending one', async () => {
    const db = fakeDb();
    db.row!.enabledAt = null;
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBeNull();
    // The pending secret does not turn the PIN off either.
    await expect(verify(db, PIN)).resolves.toBe('PIN');
    expect(db.approvalAuthenticator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ enabledAt: { not: null }, organizationId: 'org' }),
      })
    );
  });

  it('refuses a code when the stored secret cannot be decrypted', async () => {
    const db = fakeDb();
    db.row!.encryptedSecret = 'v1.broken.secret.value';
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBeNull();
  });
});

describe('DEV-879 approval authenticator: time window', () => {
  it('accepts one 30-second step either side and nothing wider', async () => {
    expect(APPROVAL_TOTP_WINDOW).toBe(1);
    await expect(verify(fakeDb(), codeAt(SECRET, STEP - 1))).resolves.toBe('AUTHENTICATOR');
    await expect(verify(fakeDb(), codeAt(SECRET, STEP + 1))).resolves.toBe('AUTHENTICATOR');
    await expect(verify(fakeDb(), codeAt(SECRET, STEP - 2))).resolves.toBeNull();
    await expect(verify(fakeDb(), codeAt(SECRET, STEP + 2))).resolves.toBeNull();
  });

  it('refuses malformed input without touching the enrolment', async () => {
    const db = fakeDb();
    for (const bad of ['', '12345', '1234567', 'abcdef']) {
      await expect(verify(db, bad)).resolves.toBeNull();
    }
    expect(db.approvalAuthenticator.updateMany).not.toHaveBeenCalled();
  });
});

describe('DEV-879 approval authenticator: single use', () => {
  it('lets one code approve exactly one action, even inside its 30-second window', async () => {
    const db = fakeDb();
    const code = codeAt(SECRET, STEP);
    await expect(verify(db, code)).resolves.toBe('AUTHENTICATOR');
    await expect(verify(db, code)).resolves.toBeNull();
    await expect(verify(db, code, new Date(NOW.getTime() + 10_000))).resolves.toBeNull();
    expect(db.auditLog.create).toHaveBeenCalledOnce();
  });

  it('refuses an older code once a newer one has been used', async () => {
    const db = fakeDb();
    await expect(verify(db, codeAt(SECRET, STEP + 1))).resolves.toBe('AUTHENTICATOR');
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBeNull();
    await expect(verify(db, codeAt(SECRET, STEP - 1))).resolves.toBeNull();
  });

  it('accepts the next code after the last one was used', async () => {
    const db = fakeDb();
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBe('AUTHENTICATOR');
    await expect(
      verify(db, codeAt(SECRET, STEP + 1), new Date(NOW.getTime() + 30_000))
    ).resolves.toBe('AUTHENTICATOR');
  });

  it('consumes the code with one guarded update, so two simultaneous approvals cannot both win', async () => {
    const db = fakeDb();
    db.approvalAuthenticator.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(verify(db, codeAt(SECRET, STEP))).resolves.toBeNull();
    expect(db.approvalAuthenticator.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'auth_manager',
        enabledAt: { not: null },
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: STEP } }],
      },
      data: { lastUsedStep: STEP },
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('DEV-879 approval authenticator: audit without the code', () => {
  it('records the approver, the action, the time and the method, never the code or secret', async () => {
    const db = fakeDb();
    const code = codeAt(SECRET, STEP);
    await verify(db, code);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org',
        actorId: 'manager',
        action: 'pharmacySales.refundTender',
        outcome: 'SUCCESS',
        metadata: expect.objectContaining({
          approvalMethod: 'AUTHENTICATOR',
          approverId: 'manager',
          approvedAction: 'pharmacySales.refundTender',
          approverRight: 'pharmacy:manage',
          approvedAt: NOW.toISOString(),
          requestedById: 'cashier',
        }),
      }),
    });
    const written = JSON.stringify(db.auditLog.create.mock.calls);
    expect(written).not.toContain(code);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(db.row!.encryptedSecret);
  });
});

describe('DEV-879 approval authenticator: server only, never offline', () => {
  it('is a server-only module, so the secret and the check never reach a counter device', () => {
    const source = readFileSync(join(__dirname, 'approval-authenticator.ts'), 'utf8');
    expect(source.startsWith("import 'server-only';")).toBe(true);
  });

  it('refuses to queue an approval code in the offline store, so offline approvals are impossible', () => {
    const code = codeAt(SECRET, STEP);
    expect(
      findForbiddenPersistPath({ overLimitApproval: { staffProfileId: 'staff', pin: code } })
    ).not.toBeNull();
    expect(findForbiddenPersistPath({ managerPin: code })).not.toBeNull();
  });
});

describe('DEV-879 approval authenticator recovery: owner or administrator only', () => {
  const owner = {
    id: 'owner',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organizationRole: { key: 'owner', isSystem: true, permissions: [] },
    permissionOverrides: [],
  };
  const admin = {
    id: 'admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    organizationRole: null,
    permissionOverrides: [],
  };
  const otherAdmin = { ...admin, id: 'admin-2' };
  const manager = {
    id: 'manager',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organizationRole: { key: 'manager', isSystem: true, permissions: [] },
    permissionOverrides: [],
  };

  it('lets the owner reset anyone, themselves included', () => {
    expect(approvalAuthenticatorResetDenial(owner, manager)).toBeNull();
    expect(approvalAuthenticatorResetDenial(owner, admin)).toBeNull();
    expect(approvalAuthenticatorResetDenial(owner, owner)).toBeNull();
  });

  it('lets an administrator reset a member below them only', () => {
    expect(approvalAuthenticatorResetDenial(admin, manager)).toBeNull();
    expect(approvalAuthenticatorResetDenial(admin, admin)).not.toBeNull();
    expect(approvalAuthenticatorResetDenial(admin, otherAdmin)).not.toBeNull();
    expect(approvalAuthenticatorResetDenial(admin, owner)).not.toBeNull();
  });

  it('never lets a member reset their own or anyone else’s authenticator', () => {
    expect(approvalAuthenticatorResetDenial(manager, manager)).not.toBeNull();
    expect(approvalAuthenticatorResetDenial(manager, admin)).not.toBeNull();
  });

  it('treats an owner with a DENY rule as restricted', () => {
    const restricted = {
      ...owner,
      permissionOverrides: [{ capability: 'pharmacy:refund', effect: 'DENY' }],
    };
    expect(approvalAuthenticatorResetDenial(restricted, manager)).not.toBeNull();
  });
});

describe('DEV-961 authenticator by default: the shared approval path', () => {
  it('refuses an approval whose approver right is not in the shared registry, before any check', async () => {
    const db = fakeDb({ enrolled: false });
    for (const right of ['pharmacy:sell', 'admin:access', '', undefined]) {
      await expect(
        verifyApprovalSecret(db as never, {
          organizationId: 'org',
          approverUserId: 'manager',
          credentialHash: `hash:${PIN}`,
          secret: PIN,
          action: 'pharmacySales.refundTender',
          approverRight: right as never,
          now: NOW,
        })
      ).resolves.toBeNull();
    }
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(db.organization.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the PIN of a terminal-only staff profile (no web login) while the requirement is on', async () => {
    const db = fakeDb({ enrolled: false, required: true });
    const terminalOnly = (secret: string) =>
      verifyApprovalSecret(db as never, {
        organizationId: 'org',
        approverUserId: null,
        credentialHash: `hash:${PIN}`,
        secret,
        action: 'restaurant.terminal.coAuthorize',
        approverRight: 'coauth:approve',
        requestedByStaffProfileId: 'staff_cashier',
        now: NOW,
      });
    await expect(terminalOnly(PIN)).resolves.toBe('PIN');
    await expect(terminalOnly('0000')).resolves.toBeNull();
    // A member with a web login and no authenticator is still refused.
    await expect(verify(db, PIN)).resolves.toBeNull();
  });

  it('still fails closed for a terminal-only profile when the organization cannot be read', async () => {
    const db = fakeDb({ enrolled: false, organization: false });
    await expect(
      verifyApprovalSecret(db as never, {
        organizationId: 'org',
        approverUserId: null,
        credentialHash: `hash:${PIN}`,
        secret: PIN,
        action: 'restaurant.terminal.coAuthorize',
        approverRight: 'coauth:approve',
        now: NOW,
      })
    ).resolves.toBeNull();
  });

  it('with the requirement off, approvals take the permanent PIN exactly as before', async () => {
    const db = fakeDb({ enrolled: false, required: false });
    await expect(verify(db, PIN)).resolves.toBe('PIN');
  });

  it('consumes the owner’s own code for a confirmation, once, with an audit row', async () => {
    const db = fakeDb();
    const confirm = (code: string) =>
      consumeMemberApprovalCode(db as never, {
        organizationId: 'org',
        userId: 'manager',
        code,
        action: 'approvalAuthenticator.setRequired',
        now: NOW,
      });
    await expect(confirm('000000')).resolves.toBe(false);
    await expect(confirm(codeAt(SECRET, STEP))).resolves.toBe(true);
    await expect(confirm(codeAt(SECRET, STEP))).resolves.toBe(false);
    expect(db.auditLog.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(SECRET);
    const none = fakeDb({ enrolled: false });
    await expect(
      consumeMemberApprovalCode(none as never, {
        organizationId: 'org',
        userId: 'manager',
        code: codeAt(SECRET, STEP),
        action: 'approvalAuthenticator.setRequired',
        now: NOW,
      })
    ).resolves.toBe(false);
  });
});
