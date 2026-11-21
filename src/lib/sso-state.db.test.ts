// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteSpentSsoStates, reserveSsoStateCapacity, SsoStateCapacityError } from './sso-state';
import { withPlatformDb, withTenantDb } from './tenancy/scoped-db';
import { assertRlsEnforcingRole } from './testing/rls-role-guard';

const runtime = process.env.SSO_STATE_TEST_DATABASE_URL;
const org = 'sso_test_' + randomUUID();
const connection = randomUUID();
const active = new Date(Date.now() + 600_000);
const row = (key: string) => ({
  key,
  organizationId: org,
  identityConnectionId: connection,
  kind: 'OIDC',
  expiresAt: active,
  payload: {},
});

describe.skipIf(!runtime)('sign-in state on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(runtime!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_disposable') || url.search)
      throw new Error('Expected a local disposable database.');
    process.env.DATABASE_URL = runtime;
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb(async (db) => {
      await db.organization.create({
        data: { id: org, slug: org, legalName: 'Fixture', displayName: 'Fixture' },
      });
      await db.organizationIdentityConnection.create({
        data: { id: connection, organizationId: org, protocol: 'OIDC', name: 'Fixture' },
      });
    });
  });

  it('serializes concurrent reservations and fits a complete SAML pair or neither row', async () => {
    await withTenantDb(org, (db) =>
      db.organizationSsoState.createMany({
        data: Array.from({ length: 253 }, () => row(randomUUID())),
      })
    );
    const start = (slots: 1 | 2) =>
      withTenantDb(org, async (db) => {
        await reserveSsoStateCapacity(db, connection, slots);
        await db.organizationSsoState.createMany({
          data: Array.from({ length: slots }, () => row(randomUUID())),
        });
      });
    await Promise.all([start(1), start(1)]);
    await expect(start(2)).rejects.toBeInstanceOf(SsoStateCapacityError);
    const race = await Promise.allSettled([start(1), start(1)]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      SsoStateCapacityError
    );
    expect(await withTenantDb(org, (db) => db.organizationSsoState.count())).toBe(256);
  });

  it('removes used and expired rows in batches and preserves all active rows', async () => {
    // Tenant scope confines this exercise of the worker SQL to the fresh fixture.
    await withTenantDb(org, async (db) => {
      const live = await db.organizationSsoState.create({ data: row(randomUUID()) });
      const past = new Date(Date.now() - 60_000);
      await db.organizationSsoState.createMany({
        data: Array.from({ length: 502 }, (_, i) => ({
          ...row(randomUUID()),
          ...(i % 2 ? { usedAt: past } : { expiresAt: past }),
        })),
      });
      const activeBefore = await db.organizationSsoState.count({
        where: { usedAt: null, expiresAt: { gt: new Date() } },
      });
      expect(await deleteSpentSsoStates(db)).toBe(500);
      expect(await deleteSpentSsoStates(db)).toBe(2);
      expect(await deleteSpentSsoStates(db)).toBe(0);
      expect(await db.organizationSsoState.count()).toBe(activeBefore);
      expect(await db.organizationSsoState.findUnique({ where: { id: live.id } })).toBeTruthy();
    });
  });
});
