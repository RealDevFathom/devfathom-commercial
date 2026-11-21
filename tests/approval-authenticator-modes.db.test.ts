/**
 * DEV-961 — what an approval takes, in each mode of the owner's "Authenticator for approvals"
 * setting, through the real shared approval path (`verifyRefundPin` → `verifyApprovalSecret`),
 * real ABAC and persisted roles, on migrated PostgreSQL with FORCE row level security as the
 * NOSUPERUSER NOBYPASSRLS runtime role:
 *
 *  - ON (the default): a manager's permanent PIN is refused and their app code accepted; a
 *    cashier, who holds no approver right, still confirms their own voucher redemption with
 *    their own PIN;
 *  - OFF: everyone approves with their permanent PIN, enrolled or not; app codes are refused;
 *  - ON again: the app set up before restores codes with no new set-up, but a reset made
 *    while it was off never brings the old secret back;
 *  - wrong secrets strike the PIN credential and lock it in both modes; each accepted
 *    approval writes one uniform audit row with its method.
 *
 * Skipped (never silently passed) unless TEST_DATABASE_URL names a disposable database.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('server-only', () => ({}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scoped = typeof import('@/lib/tenancy/scoped-db');

const suffix = randomBytes(5).toString('hex');
const ORG = `org_d961_modes_${suffix}`;
const MANAGER = `user_d961_manager_${suffix}`;
const CASHIER = `user_d961_cashier_${suffix}`;
const MANAGER_PIN = '4821';
const CASHIER_PIN = '7310';

/** An independent RFC 6238 oracle (SHA-1, 6 digits, 30 s). */
function codeAt(secretB32: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const value = hmac.readUInt32BE(hmac[hmac.length - 1] & 0xf) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

let withTenantDb: Scoped['withTenantDb'];
let withPlatformDb: Scoped['withPlatformDb'];
let verifyRefundPin: (typeof import('@/lib/pharmacy/refund-authorization'))['verifyRefundPin'];
let authenticateVoucherCashierPin: (typeof import('@/lib/pharmacy/vouchers'))['authenticateVoucherCashierPin'];
let disconnect: () => Promise<void>;
let secret: string;
let encryptSecret: (typeof import('@/lib/secret-crypto'))['encryptSecret'];
let generateTotpSecret: (typeof import('@/lib/totp'))['generateTotpSecret'];
const profiles: Record<string, string> = {};

/** A fresh instant per approval, each in its own 30-second step, so codes are never reused. */
let clock = Date.UTC(2026, 10, 19, 9, 0, 0);
const nextStep = () => new Date((clock += 60_000));

const tenant = <T>(run: (db: ScopedDb) => Promise<T>, userId = MANAGER) =>
  withTenantDb(ORG, run, { userId });

const setRequired = (required: boolean) =>
  withPlatformDb((db) =>
    db.organization.update({
      where: { id: ORG },
      data: { requireApprovalAuthenticator: required },
    })
  );

const manager = (pin: string, now: Date) =>
  tenant((db) =>
    verifyRefundPin(
      db,
      { organizationId: ORG, actorId: MANAGER, pin, action: 'pharmacySales.refundTender' },
      now
    )
  );

const credential = (userId: string) =>
  tenant((db) =>
    db.restaurantOperatorCredential.findFirstOrThrow({
      where: { staffProfileId: profiles[userId], type: 'PIN', revokedAt: null },
      select: { id: true, failedAttempts: true, lockedUntil: true },
    })
  );

const unlock = (userId: string) =>
  tenant((db) =>
    db.restaurantOperatorCredential.updateMany({
      where: { staffProfileId: profiles[userId] },
      data: { failedAttempts: 0, lockedUntil: null },
    })
  );

const enrol = (userId: string) =>
  tenant(async (db) => {
    await db.approvalAuthenticator.deleteMany({ where: { userId } });
    await db.approvalAuthenticator.create({
      data: {
        userId,
        encryptedSecret: encryptSecret(secret),
        enabledAt: new Date(clock - 86_400_000),
      },
    });
  });

const approvalRows = () =>
  tenant((db) =>
    db.auditLog.findMany({
      where: { actorId: MANAGER, source: 'AUTH', description: { startsWith: 'Approved with' } },
      select: { description: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    })
  );

describeIfDatabase('DEV-961 approvals in each mode of the authenticator setting', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    ({ verifyRefundPin } = await import('@/lib/pharmacy/refund-authorization'));
    ({ authenticateVoucherCashierPin } = await import('@/lib/pharmacy/vouchers'));
    ({ encryptSecret } = await import('@/lib/secret-crypto'));
    ({ generateTotpSecret } = await import('@/lib/totp'));
    const credentials = await import('@/lib/restaurant/operator-credentials');
    const { seedDepartments, ensurePlatformModule } = await import('@/lib/test-support/departments');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { db } = await import('@/lib/db');
    disconnect = () => db.$disconnect();
    await assertRlsEnforcingRole(withPlatformDb);
    secret = generateTotpSecret();

    await withPlatformDb(async (tx) => {
      // Created with the database default: the authenticator setting is on.
      await tx.organization.create({
        data: {
          id: ORG,
          slug: ORG,
          legalName: ORG,
          displayName: ORG,
          status: 'ACTIVE',
          vertical: 'PHARMACY',
          timezone: 'Asia/Karachi',
        },
      });
      const counter = await ensurePlatformModule(tx as never, 'pharmacy-counter', {
        name: 'Pharmacy counter',
        category: 'Pharmacy',
      });
      await tx.organizationModule.create({ data: { organizationId: ORG, moduleId: counter.id } });
    });
    await tenant(async (tx) => {
      await seedDepartments(tx, [ORG], ['LEADERSHIP']);
      for (const [id, grants, pin] of [
        [MANAGER, ['pharmacy:manage', 'pharmacy:sell'], MANAGER_PIN],
        [CASHIER, ['pharmacy:sell'], CASHIER_PIN],
      ] as const) {
        await tx.organizationRole.create({
          data: {
            id: `role_${id}`,
            key: `role_${id}`,
            name: id,
            permissions: {
              create: grants.map((capability) => ({ capability, effect: 'ALLOW' as const })),
            },
          },
        });
        await tx.user.create({
          data: {
            id,
            name: id,
            email: `${id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Pharmacy staff',
            role: 'EMPLOYEE',
            status: 'ACTIVE',
            organizationRoleId: `role_${id}`,
          },
        });
        const profile = await tx.restaurantStaffProfile.create({
          data: { userId: id, displayName: id },
        });
        profiles[id] = profile.id;
        await tx.restaurantOperatorCredential.create({
          data: {
            staffProfileId: profile.id,
            type: 'PIN',
            credentialHash: await credentials.hashOperatorCredential('PIN', pin),
          },
        });
      }
    });
    await enrol(MANAGER);
  }, 120_000);

  afterAll(async () => {
    if (databaseUrl) await disconnect();
  });

  it('starts with the setting on, from the database default', async () => {
    const organization = await withPlatformDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: ORG },
        select: { requireApprovalAuthenticator: true },
      })
    );
    expect(organization.requireApprovalAuthenticator).toBe(true);
  });

  it('ON: a cashier with no approver right redeems a voucher with their own PIN', async () => {
    await expect(
      authenticateVoucherCashierPin({ organizationId: ORG, actorId: CASHIER, pin: CASHIER_PIN })
    ).resolves.toBe(true);
    await expect(
      authenticateVoucherCashierPin({ organizationId: ORG, actorId: CASHIER, pin: '0000' })
    ).resolves.toBe(false);
    expect(await credential(CASHIER)).toMatchObject({ failedAttempts: 1 });
    await unlock(CASHIER);
  });

  it('ON: refuses the manager’s permanent PIN (with a strike) and accepts their app code', async () => {
    await expect(manager(MANAGER_PIN, nextStep())).resolves.toEqual({
      blocked: expect.any(String),
    });
    expect(await credential(MANAGER)).toMatchObject({ failedAttempts: 1 });
    const now = nextStep();
    await expect(manager(codeAt(secret, now), now)).resolves.toEqual({ verified: true });
    expect(await credential(MANAGER)).toMatchObject({ failedAttempts: 0 });
  });

  it('OFF: the manager approves with the permanent PIN, though enrolled; app codes are refused', async () => {
    await setRequired(false);
    await expect(manager(MANAGER_PIN, nextStep())).resolves.toEqual({ verified: true });
    const now = nextStep();
    await expect(manager(codeAt(secret, now), now)).resolves.toEqual({
      blocked: expect.any(String),
    });
    await unlock(MANAGER);
    // The cashier keeps their PIN too.
    await expect(
      authenticateVoucherCashierPin({ organizationId: ORG, actorId: CASHIER, pin: CASHIER_PIN })
    ).resolves.toBe(true);
    // The app stays set up while the setting is off.
    const kept = await tenant((db) =>
      db.approvalAuthenticator.count({ where: { userId: MANAGER, enabledAt: { not: null } } })
    );
    expect(kept).toBe(1);
  });

  it('ON again: the app set up before restores codes without a new set-up', async () => {
    await setRequired(true);
    const now = nextStep();
    await expect(manager(codeAt(secret, now), now)).resolves.toEqual({ verified: true });
    await expect(manager(MANAGER_PIN, nextStep())).resolves.toEqual({
      blocked: expect.any(String),
    });
    await unlock(MANAGER);
  });

  it('never brings back a secret that was reset while the setting was off', async () => {
    await setRequired(false);
    await tenant((db) => db.approvalAuthenticator.deleteMany({ where: { userId: MANAGER } }));
    await setRequired(true);
    const now = nextStep();
    await expect(manager(codeAt(secret, now), now)).resolves.toEqual({
      blocked: expect.any(String),
    });
    await expect(manager(MANAGER_PIN, nextStep())).resolves.toEqual({
      blocked: expect.any(String),
    });
    await unlock(MANAGER);
    await enrol(MANAGER);
  });

  it.each([true, false])(
    'strikes and locks the credential after five wrong secrets (setting on: %s)',
    async (required) => {
      await setRequired(required);
      await unlock(MANAGER);
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(manager('000000', nextStep())).resolves.toEqual({
          blocked: expect.any(String),
        });
      const locked = await credential(MANAGER);
      expect(locked.lockedUntil).not.toBeNull();
      // Locked: even the right secret for this mode is refused.
      const now = nextStep();
      const right = required ? codeAt(secret, now) : MANAGER_PIN;
      await expect(manager(right, now)).resolves.toEqual({ blocked: expect.any(String) });
      await unlock(MANAGER);
      const after = nextStep();
      await expect(manager(required ? codeAt(secret, after) : MANAGER_PIN, after)).resolves.toEqual(
        { verified: true }
      );
    }
  );

  it('writes one uniform audit row per accepted approval, naming the method', async () => {
    const rows = await approvalRows();
    const methods = rows.map((row) => (row.metadata as { approvalMethod: string }).approvalMethod);
    expect(methods).toContain('PIN');
    expect(methods).toContain('AUTHENTICATOR');
    const shape = (row: (typeof rows)[number]) => Object.keys(row.metadata as object).sort();
    for (const row of rows) expect(shape(row)).toEqual(shape(rows[0]!));
    expect(JSON.stringify(rows)).not.toContain(MANAGER_PIN);
  });
});
