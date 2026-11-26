// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { decryptSecret } from '@/lib/secret-crypto';
import { prepareWahaSession, readWahaSession, selectorOrganization } from './waha-session';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('WAHA session storage on restricted PostgreSQL', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const [role] = await db.$queryRaw<
      { safe: boolean }[]
    >`SELECT NOT rolsuper AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname=current_user`;
    expect(role.safe).toBe(true);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('binds one opaque session to a business and keeps its credentials out of other tenant scopes', async () => {
    const apiKey = randomBytes(32).toString('hex');
    const tenants = [randomUUID(), randomUUID()];
    const rollback = new Error('rollback test data');
    await expect(
      db.$transaction(async (raw) => {
        const tx = raw as ScopedDb;
        await tx.$queryRaw`SELECT set_config('app.is_platform_admin','true',true)`;
        for (const id of tenants)
          await tx.organization.create({
            data: {
              id,
              slug: id,
              legalName: 'Synthetic Pharmacy',
              displayName: 'Synthetic Pharmacy',
            },
          });
        await tx.$queryRaw`SELECT set_config('app.is_platform_admin','false',true),set_config('app.current_organization_id',${tenants[0]},true)`;
        const first = await prepareWahaSession(tx, tenants[0], apiKey);
        expect(first.sessionName.length).toBeLessThanOrEqual(54);
        await prepareWahaSession(tx, tenants[0], apiKey);
        const row = await readWahaSession(tx, tenants[0]);
        expect(
          !!row && row.sessionName === first.sessionName && !row.sessionName.includes(tenants[0])
        ).toBe(true);
        expect(
          !!row && row.encryptedApiKey !== apiKey && decryptSecret(row.encryptedApiKey) === apiKey
        ).toBe(true);
        expect(!!row && decryptSecret(row.encryptedWebhookSecret).length >= 32).toBe(true);
        expect(selectorOrganization(first.selector)).toBe(tenants[0]);
        await tx.$queryRaw`SELECT set_config('app.current_organization_id',${tenants[1]},true)`;
        expect(await readWahaSession(tx, tenants[0])).toBeNull();
        const second = await prepareWahaSession(tx, tenants[1], apiKey);
        expect(first.sessionName !== second.sessionName && first.selector !== second.selector).toBe(
          true
        );
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });
});
