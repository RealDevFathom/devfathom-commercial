// Real platform command -> fresh MFA -> committed profile -> actual stored guard.
// No command, crypto, tenancy, guard, or database mocks. Synthetic fixtures only.
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformIdentity } from './auth';

const runtimeUrl = process.env.TEST_DATABASE_URL;
const suite = runtimeUrl ? describe : describe.skip;
if (runtimeUrl) {
  const url = new URL(runtimeUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/test|disposable|synthetic/.test(url.pathname)
  ) {
    throw new Error('Placeholder acceptance requires an isolated synthetic test database');
  }
  process.env.DATABASE_URL = runtimeUrl;
}
// Ephemeral test-only encryption material is generated in memory, never checked in.
process.env.PLATFORM_ENCRYPTION_KEY = randomBytes(32).toString('base64');
let platform: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let apply: typeof import('./commands').applyPlaceholderRuleSet;
let guard: typeof import('@/lib/pharmacy/regulatory').assertStoredBranchMayOperate;
let encrypt: typeof import('@/lib/secret-crypto').encryptSecret;
let verify: typeof import('@/lib/totp').verifyTotp;
let disconnect: () => Promise<void>;
const unique = () => `p635_${randomBytes(8).toString('hex')}`;
const label = 'PLACEHOLDER – not a real licence';

function otp() {
  const bytes = randomBytes(20);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0,
    value = 0,
    secret = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      secret += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) secret += alphabet[(value << (5 - bits)) & 31];
  return {
    secret,
    code(at = Date.now()) {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
      const digest = createHmac('sha1', bytes).update(counter).digest();
      const offset = digest[digest.length - 1] & 15;
      return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
    },
  };
}

async function operator(role: PlatformIdentity['role'] = 'SUPER_ADMIN', state = 'enabled') {
  const id = unique();
  const factor = otp();
  const actor: PlatformIdentity = {
    id,
    sessionId: unique(),
    name: 'Synthetic placeholder acceptance',
    email: `${id}@example.invalid`,
    role,
    expiresAt: new Date(Date.now() + 60_000),
    mfaEnabled: true,
  };
  await platform((db) =>
    db.platformUser.create({
      data: {
        id,
        name: actor.name,
        email: actor.email,
        role,
        passwordHash: 'unused-synthetic-hash',
        active: state !== 'inactive',
        encryptedTotpSecret: encrypt(factor.secret),
        mfaEnabledAt: state === 'unenrolled' ? null : new Date(),
      },
    })
  );
  return { actor, factor };
}

async function pharmacy() {
  const organizationId = unique(),
    branchId = unique();
  await platform(async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: organizationId,
        displayName: organizationId,
        vertical: 'PHARMACY',
        status: 'ONBOARDING',
        deploymentMode: 'SHARED',
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: 'Synthetic branch',
        addressLine: '12 Synthetic Road',
        city: 'Lahore',
        provinceCode: 'PK-PB',
      },
    });
  });
  return { organizationId, branchId };
}
const reason = 'Isolated synthetic pharmacy placeholder acceptance';

suite('pharmacy platform placeholder writer and stored guard against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb: platform, withTenantDb: tenant } = await import('@/lib/tenancy/scoped-db'));
    ({ applyPlaceholderRuleSet: apply } = await import('./commands'));
    ({ assertStoredBranchMayOperate: guard } = await import('@/lib/pharmacy/regulatory'));
    ({ encryptSecret: encrypt } = await import('@/lib/secret-crypto'));
    ({ verifyTotp: verify } = await import('@/lib/totp'));
    const { db } = await import('@/lib/db');
    disconnect = () => db.$disconnect();
  });
  afterEach(async () => {
    // The real denial audit is fire-and-forget: await its persistence before disconnect.
    const { flushAuditWritesForTest } = await import('@/server/audit');
    await flushAuditWritesForTest();
  });
  afterAll(async () => {
    await disconnect?.();
  });

  it('persists the actual fresh-MFA SuperAdmin writer and accepts its exact label-only profile', async () => {
    const { actor, factor } = await operator();
    const { organizationId, branchId } = await pharmacy();
    const code = factor.code();
    expect(verify(factor.secret, code)).toBe(true);
    await expect(apply(organizationId, actor, reason, code)).resolves.toEqual({ applied: true });
    const persisted = await platform((db) =>
      db.branchRegulatoryProfile.findFirstOrThrow({
        where: { organizationId, branchId },
        include: { jurisdictionRuleSet: true },
      })
    );
    expect(persisted).toMatchObject({
      isPlaceholder: true,
      jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
      provinceCode: 'PK-PB',
      licenceNumber: label,
      licenceEvidenceFileRef: label,
      premises: { label },
      jurisdictionRuleSet: { isPlaceholder: true },
    });
    for (const schedule of ['OTC', 'RX', 'CONTROLLED']) {
      await tenant(organizationId, (db) =>
        guard(db, organizationId, branchId, { name: 'sale', schedule })
      );
    }
    const audit = await platform((db) =>
      db.platformAuditLog.findFirstOrThrow({
        where: { organizationId, action: 'organization.pharmacy.placeholder.apply', success: true },
      })
    );
    expect(audit.actorPlatformUserId).toBe(actor.id);
    expect(audit.metadata).toMatchObject({ placeholder: true });
    expect(JSON.stringify(audit.after)).not.toContain('authenticationCode');
    expect(JSON.stringify(audit.after)).not.toContain(factor.secret);
  });

  it('rejects a non-SuperAdmin even with a valid fresh code, without persisting a profile', async () => {
    const { actor, factor } = await operator('OPERATIONS');
    const { organizationId } = await pharmacy();
    await expect(apply(organizationId, actor, reason, factor.code())).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await platform((db) => db.branchRegulatoryProfile.count({ where: { organizationId } }))
    ).toBe(0);
  });

  it.each(['malformed', 'stale', 'inactive', 'unenrolled'])(
    'rejects %s MFA without persisting a profile',
    async (state) => {
      const { actor, factor } = await operator('SUPER_ADMIN', state);
      const { organizationId } = await pharmacy();
      let code = state === 'malformed' ? 'not-a-code' : factor.code();
      if (state === 'stale') {
        let at = Date.now() - 300_000;
        do {
          code = factor.code(at);
          at -= 30_000;
        } while (verify(factor.secret, code));
      }
      await expect(apply(organizationId, actor, reason, code)).rejects.toMatchObject({
        status: 403,
      });
      expect(
        await platform((db) => db.branchRegulatoryProfile.count({ where: { organizationId } }))
      ).toBe(0);
    }
  );

  it('retains the active-branch and province guards after the legitimate writer', async () => {
    const { actor, factor } = await operator();
    const { organizationId, branchId } = await pharmacy();
    await apply(organizationId, actor, reason, factor.code());
    await platform((db) =>
      db.pharmacyBranch.update({ where: { id: branchId }, data: { active: false } })
    );
    await expect(
      tenant(organizationId, (db) => guard(db, organizationId, branchId, { name: 'sale' }))
    ).rejects.toMatchObject({ reason: 'BRANCH_INACTIVE' });
    await platform((db) =>
      db.pharmacyBranch.update({
        where: { id: branchId },
        data: { active: true, provinceCode: 'PK-SD' },
      })
    );
    await expect(
      tenant(organizationId, (db) => guard(db, organizationId, branchId, { name: 'sale' }))
    ).rejects.toMatchObject({ reason: 'PROFILE_BRANCH_MISMATCH' });
  });

  it('does not let placeholder flags bless mismatched structured premises persisted in a successor', async () => {
    const { actor, factor } = await operator();
    const { organizationId, branchId } = await pharmacy();
    await apply(organizationId, actor, reason, factor.code());
    const effectiveFrom = new Date(Date.now() + 10);
    await platform(async (db) => {
      const prior = await db.branchRegulatoryProfile.findFirstOrThrow({
        where: { organizationId, branchId },
      });
      await db.branchRegulatoryProfile.update({
        where: { id: prior.id },
        data: { effectiveTo: effectiveFrom },
      });
      await db.branchRegulatoryProfile.create({
        data: {
          ...prior,
          id: unique(),
          createdAt: new Date(),
          version: prior.version + 1,
          effectiveFrom,
          effectiveTo: null,
          retentionPolicy:
            prior.retentionPolicy as import('@/generated/prisma/client').Prisma.InputJsonValue,
          premises: { label, addressLine: 'Wrong premises', city: 'Lahore' },
        },
      });
    });
    await expect(
      tenant(organizationId, (db) =>
        guard(db, organizationId, branchId, {
          name: 'sale',
          at: new Date(effectiveFrom.getTime() + 1),
        })
      )
    ).rejects.toMatchObject({ reason: 'PROFILE_BRANCH_MISMATCH' });
  });
});
