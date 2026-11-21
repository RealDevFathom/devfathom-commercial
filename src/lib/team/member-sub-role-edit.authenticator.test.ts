// @vitest-environment node
import { createHmac, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

/**
 * DEV-961 with DEV-959B: the owner's fresh confirmation before a weighty access change (ticking a
 * sub-role, the member edit forms, invitations) goes through the shared approval verifier
 * (`verifyAccessPin` → `verifyOwnerExportPin` → `verifyApprovalSecret`), so it follows the
 * owner's "Authenticator for approvals" setting like every other approval: the current app code
 * while it is on, the permanent PIN while it is off. Only the database is faked here.
 */

vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({
  required: true,
  enrolled: true,
  lastUsedStep: null as number | null,
  credentialHash: '',
  failedAttempts: 0,
  audit: [] as unknown[],
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: vi.fn(async () => []),
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => ({
        id: 'cred-owner',
        credentialHash: state.credentialHash,
        failedAttempts: state.failedAttempts,
        lockedUntil: null,
      })),
      update: vi.fn(async ({ data }: { data: { failedAttempts?: number } }) => {
        state.failedAttempts = data.failedAttempts ?? state.failedAttempts;
        return {};
      }),
    },
    organization: {
      findFirst: vi.fn(async () => ({ requireApprovalAuthenticator: state.required })),
    },
    approvalAuthenticator: {
      findFirst: vi.fn(async () =>
        state.enrolled ? { id: 'auth-owner', encryptedSecret: ENCRYPTED.value } : null
      ),
      updateMany: vi.fn(async ({ data }: { data: { lastUsedStep: number } }) => {
        if (state.lastUsedStep !== null && state.lastUsedStep >= data.lastUsedStep)
          return { count: 0 };
        state.lastUsedStep = data.lastUsedStep;
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async (row: unknown) => state.audit.push(row)) },
  };
  return { withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)) };
});
const ENCRYPTED = vi.hoisted(() => ({ value: '' }));

import { verifyAccessPin } from './member-sub-role-edit';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { encryptSecret } from '@/lib/secret-crypto';
import { generateTotpSecret } from '@/lib/totp';

/** An independent RFC 6238 oracle (SHA-1, 6 digits, 30 s). */
function codeAt(secretB32: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  return String((hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff) % 1_000_000).padStart(
    6,
    '0'
  );
}

const PIN = '4821';
const SECRET = generateTotpSecret();
let clock = Date.UTC(2026, 10, 20, 9, 0, 0);
const nextStep = () => new Date((clock += 60_000));
const confirm = (pin: string, now: Date) =>
  verifyAccessPin({ organizationId: 'org', actorId: 'owner', pin, now });

beforeAll(async () => {
  state.credentialHash = await hashOperatorCredential('PIN', PIN);
  ENCRYPTED.value = encryptSecret(SECRET);
});
beforeEach(() => {
  state.required = true;
  state.enrolled = true;
  state.failedAttempts = 0;
  state.audit = [];
});

describe('DEV-961 the owner confirms an access change the way they approve', () => {
  it('while the setting is on, takes the current app code and refuses the permanent PIN', async () => {
    const now = nextStep();
    await expect(confirm(codeAt(SECRET, now), now)).resolves.toBe(true);
    expect(state.audit).toEqual([
      {
        data: expect.objectContaining({
          action: 'organizationAdmin.setMemberSubRole',
          metadata: expect.objectContaining({
            approvalMethod: 'AUTHENTICATOR',
            approverRight: 'OWNER',
          }),
        }),
      },
    ]);
    await expect(confirm(PIN, nextStep())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.failedAttempts).toBe(1);
  });

  it('while the setting is on, refuses an owner who has not set up the app', async () => {
    state.enrolled = false;
    await expect(confirm(PIN, nextStep())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('while the owner has it off, takes the permanent PIN and refuses an app code', async () => {
    state.required = false;
    await expect(confirm(PIN, nextStep())).resolves.toBe(true);
    expect(state.audit).toEqual([
      {
        data: expect.objectContaining({
          metadata: expect.objectContaining({ approvalMethod: 'PIN' }),
        }),
      },
    ]);
    const now = nextStep();
    await expect(confirm(codeAt(SECRET, now), now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
