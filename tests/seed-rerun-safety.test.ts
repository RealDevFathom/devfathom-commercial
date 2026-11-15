/**
 * DEV-347: `bun run db:seed` re-runs and the platform operator.
 *
 * The platform operator used to be upserted inside the seed's single
 * transaction, ahead of the tenant demo data. Any later failure (the reported
 * `Invoice.invoiceNumber` P2002 on a second run, a missing SEED_PASSWORD) rolled
 * the operator back with everything else, silently, leaving no way to sign in
 * to the control desk. These tests pin the operator to its own committed
 * transaction, its outcome to an explicit log line, and a P2002 to an
 * actionable message. No database is needed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionPlatformAdmin } from '../prisma/platform-admin';
import { describeSeedFailure, isUniqueConstraintViolation } from '../prisma/seed-failure';

type FakeTx = {
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
  platformUser: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

type PlatformAdminClient = Parameters<typeof provisionPlatformAdmin>[0];

function fakeClient(existing: { id: string } | null) {
  const tx: FakeTx = {
    $executeRawUnsafe: vi.fn(async () => 1),
    platformUser: {
      findUnique: vi.fn(async () => existing),
      upsert: vi.fn(async () => ({ id: 'pu_1' })),
    },
  };
  const $transaction = vi.fn(async (fn: (t: never) => Promise<unknown>) => fn(tx as never));
  // vi.fn drops the generic signature; the fake still forwards fn's result.
  const client = { $transaction } as unknown as PlatformAdminClient & {
    $transaction: typeof $transaction;
  };
  return { tx, client };
}

function fakeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

const ENV_KEYS = ['PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('provisionPlatformAdmin', () => {
  it('upserts the operator inside its own platform-admin transaction and logs the creation', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'Ops@Example.test';
    process.env.PLATFORM_ADMIN_PASSWORD = 'local-operator-password';
    const { tx, client } = fakeClient(null);
    const logger = fakeLogger();

    const outcome = await provisionPlatformAdmin(client, logger);

    expect(outcome).toEqual({ status: 'created', email: 'ops@example.test' });
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.is_platform_admin', 'true', true)")
    );
    // RLS context is established before the write.
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      tx.platformUser.upsert.mock.invocationCallOrder[0]
    );
    expect(tx.platformUser.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'ops@example.test' },
        update: expect.objectContaining({ active: true, role: 'SUPER_ADMIN' }),
      })
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Created platform operator ops@example.test')
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an update when the operator already exists', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@example.test';
    process.env.PLATFORM_ADMIN_PASSWORD = 'rotated-operator-password';
    const { client } = fakeClient({ id: 'pu_existing' });
    const logger = fakeLogger();

    const outcome = await provisionPlatformAdmin(client, logger);

    expect(outcome).toEqual({ status: 'updated', email: 'ops@example.test' });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Updated platform operator ops@example.test')
    );
  });

  it('warns visibly, and writes nothing, when both variables are unset', async () => {
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    const { tx, client } = fakeClient(null);
    const logger = fakeLogger();

    const outcome = await provisionPlatformAdmin(client, logger);

    expect(outcome).toEqual({ status: 'unset' });
    expect(tx.platformUser.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are unset/)
    );
  });

  it('still refuses a half-configured operator', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@example.test';
    delete process.env.PLATFORM_ADMIN_PASSWORD;
    const { tx, client } = fakeClient(null);

    await expect(provisionPlatformAdmin(client, fakeLogger())).rejects.toThrow(
      'Set both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD'
    );
    expect(tx.platformUser.upsert).not.toHaveBeenCalled();
  });
});

describe('prisma/seed.ts transaction boundaries', () => {
  const source = readFileSync(join(__dirname, '..', 'prisma', 'seed.ts'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));

  it('commits the platform operator before, and outside, the tenant transaction', () => {
    const provision = main.indexOf('await provisionPlatformAdmin(prisma);');
    const tenantTransaction = main.indexOf('await prisma.$transaction(');
    expect(provision).toBeGreaterThan(-1);
    expect(tenantTransaction).toBeGreaterThan(-1);
    expect(provision).toBeLessThan(tenantTransaction);
    expect(source).not.toMatch(/upsertPlatformAdmin\(tx\)/);
  });

  it('reports seed failures through the actionable describer', () => {
    expect(source).toContain('console.error(describeSeedFailure(e));');
  });
});

describe('describeSeedFailure', () => {
  const p2002 = Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { modelName: 'Invoice', target: ['invoiceNumber'] },
  });

  it('turns a P2002 into an actionable re-seed instruction', () => {
    expect(isUniqueConstraintViolation(p2002)).toBe(true);
    const message = describeSeedFailure(p2002);
    expect(message).toContain('Invoice (invoiceNumber)');
    expect(message).toContain('already contains data');
    expect(message).toContain('bun run db:reset && bun run db:seed');
  });

  it('keeps any other failure as its own message', () => {
    const other = new Error('Refusing to seed hardcoded credentials.');
    expect(isUniqueConstraintViolation(other)).toBe(false);
    expect(describeSeedFailure(other)).toBe(
      '❌ Seeding failed: Refusing to seed hardcoded credentials.'
    );
  });
});
