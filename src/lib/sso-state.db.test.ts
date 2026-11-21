// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SSO_PENDING_PER_CONNECTION, SSO_START_LIMITS, SSO_TRANSACTION_TTL_MS } from './sso-limits';
import { rateLimitStorageKey } from './rate-limit';
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
    const seedCount = SSO_PENDING_PER_CONNECTION - 3;
    expect(SSO_PENDING_PER_CONNECTION).toBeGreaterThan(
      2 *
        SSO_START_LIMITS.connection *
        (1 + Math.ceil(SSO_TRANSACTION_TTL_MS / SSO_START_LIMITS.windowMs))
    );
    // Pre-upgrade rows have no source tag and still consume connection slots.
    await withTenantDb(
      org,
      (db) => db.$executeRaw`
      INSERT INTO organization_sso_states (id, "organizationId", "identityConnectionId", key, kind, payload, "expiresAt")
      SELECT ${connection} || n, ${org}, ${connection}, ${connection} || n, 'OIDC', '{}', ${active}
      FROM generate_series(1, ${seedCount}::int) n
    `
    );
    const request = new Request('https://fixture.example');
    const start = (slots: 1 | 2) =>
      withTenantDb(org, async (db) => {
        const sourceKey = await reserveSsoStateCapacity(db, connection, request, slots);
        await db.organizationSsoState.createMany({
          data: Array.from({ length: slots }, () => ({
            ...row(randomUUID()),
            payload: { sourceKey },
          })),
        });
      });
    await Promise.all([start(1), start(1)]);
    await expect(start(2)).rejects.toBeInstanceOf(SsoStateCapacityError);
    const race = await Promise.allSettled([start(1), start(1)]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
      SsoStateCapacityError
    );
    expect(await withTenantDb(org, (db) => db.organizationSsoState.count())).toBe(
      SSO_PENDING_PER_CONNECTION
    );
  });

  it('refuses new states at the source limit and preserves another source’s capacity on the same connection', async () => {
    const id = randomUUID();
    vi.stubEnv('CLIENT_IP_HEADER', 'x-fixture-address');
    const request = (ip: string) =>
      new Request('https://fixture.example', { headers: { 'x-fixture-address': ip } });
    const full = '192.0.2.1';
    const fullKey = rateLimitStorageKey(`sso:pending:${id}:${full}`);
    const samlPair = (sourceKey: string) =>
      ['SAML_RELAY', 'SAML_REQUEST'].map((kind) => ({
        ...row(randomUUID()),
        identityConnectionId: id,
        kind,
        payload: { sourceKey },
      }));
    try {
      await withTenantDb(org, async (db) => {
        await db.organizationIdentityConnection.create({
          data: { id, organizationId: org, protocol: 'SAML', name: 'Source isolation fixture' },
        });
        await db.organizationSsoState.createMany({
          data: Array.from({ length: 299 }, () => samlPair(fullKey)).flat(),
        });
        const sourceKey = await reserveSsoStateCapacity(db, id, request(full), 2);
        await db.organizationSsoState.createMany({ data: samlPair(sourceKey) });
      });
      const rowsForConnection = { identityConnectionId: id };
      const before = await withTenantDb(org, (db) =>
        db.organizationSsoState.findMany({
          where: rowsForConnection,
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      );
      expect(before).toHaveLength(600);
      for (const slots of [1, 2] as const) {
        await expect(
          withTenantDb(org, (db) => reserveSsoStateCapacity(db, id, request(full), slots))
        ).rejects.toBeInstanceOf(SsoStateCapacityError);
      }
      await withTenantDb(org, async (db) => {
        const sourceKey = await reserveSsoStateCapacity(db, id, request('192.0.2.2'), 2);
        expect(sourceKey).not.toBe(fullKey);
        await db.organizationSsoState.createMany({
          data: samlPair(sourceKey),
        });
        expect(await db.organizationSsoState.count({ where: rowsForConnection })).toBe(602);
        expect(
          await db.organizationSsoState.findMany({
            where: { ...rowsForConnection, payload: { path: ['sourceKey'], equals: fullKey } },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        ).toEqual(before);
      });
    } finally {
      vi.unstubAllEnvs();
    }
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
