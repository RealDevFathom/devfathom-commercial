/**
 * @vitest-environment node
 *
 * Requires TEST_DATABASE_URL for a disposable, migrated PostgreSQL database
 * accessed as a restricted runtime role. Exercise the real HTTP batch adapter,
 * router, Prisma transaction wrapper, and tenant RLS together.
 */
import { randomBytes } from 'node:crypto';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import pg from 'pg';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://test.invalid',
  sendEmail: vi.fn(),
  templates: { inviteMember: () => ({ subject: 'Invite', html: '', text: '' }) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { createTenantDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const app = router({ team: teamRouter });
const suffix = randomBytes(6).toString('hex');
const organizations: string[] = [];
let organizationId: string;
let client: pg.Client;

const invite = (email: string) => ({
  name: 'Invited Member',
  email,
  department: 'ENGINEERING',
  title: 'Engineer',
});

function context(db: ScopedDb, seatLimit = 2): TRPCContext {
  return {
    db,
    // Deliberately stale: only the count inside the invite may decide capacity.
    entitlements: { enabledModules: ['admin'], modules: [], activeSeats: 1, seatLimit },
    session: {
      expires: 'later',
      user: {
        id: `${organizationId}_admin`,
        organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'ENGINEERING',
      },
    },
    organization: { id: organizationId, isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

function occupiedSeats(tx: ScopedDb) {
  return tx.user.count({ where: { status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } } });
}

type BatchResult = {
  result?: { data: { json: { id: string; inviteUrl: string } } };
  error?: { json: { data: { code: string } } };
};

async function batch(tx: ScopedDb, emails: string[], seatLimit = 2) {
  const paths = emails.map(() => 'team.inviteMember').join(',');
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(`http://test.invalid/api/trpc/${paths}?batch=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        Object.fromEntries(
          emails.map((email, index) => [index, superjson.serialize(invite(email))])
        )
      ),
    }),
    router: app,
    createContext: () => context(tx, seatLimit),
  });
  return { status: response.status, results: (await response.json()) as BatchResult[] };
}

describe.skipIf(!databaseUrl)('team invitations against PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
  });

  beforeEach(async () => {
    organizationId = `invite_${suffix}_${organizations.length}`;
    organizations.push(organizationId);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "seatLimit", "updatedAt")
       VALUES ($1, $1, $1, $1, 2, now())`,
      [organizationId]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
      [`${organizationId}_department`, organizationId]
    );
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt")
       VALUES ($1, $2, 'Admin', 'admin@test.invalid', 'ADMIN', 'ENGINEERING', 'Admin', now())`,
      [`${organizationId}_admin`, organizationId]
    );
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('DELETE FROM invitations WHERE "organizationId" = ANY($1)', [
        organizations,
      ]);
      await client.query('DELETE FROM users WHERE "organizationId" = ANY($1)', [organizations]);
      await client.query('DELETE FROM organizations WHERE id = ANY($1)', [organizations]);
    } finally {
      await client.end();
    }
  });

  it('refuses the second batched invite for the last seat and rolls the failed batch back', async () => {
    await expect(
      withTenantDb(organizationId, async (tx) => {
        const { status, results } = await batch(tx, ['first@test.invalid', 'second@test.invalid']);
        expect(status).toBe(207);
        expect(results.filter((result) => result.result)).toHaveLength(1);
        expect(results.flatMap((result) => result.error?.json.data.code ?? [])).toEqual([
          'FORBIDDEN',
        ]);
        expect(await occupiedSeats(tx)).toBe(2);
        // The production route rolls back the owning transaction on any
        // procedure error; inspect the invariant before doing the same here.
        throw new Error('Roll back failed batch');
      })
    ).rejects.toThrow('Roll back failed batch');
    await withTenantDb(organizationId, async (tx) => {
      expect(await occupiedSeats(tx)).toBe(1);
      expect(await tx.invitation.count()).toBe(0);
    });
  });

  it('allows both batched invites when capacity is available', async () => {
    await withTenantDb(organizationId, async (tx) => {
      const { status, results } = await batch(tx, ['first@test.invalid', 'second@test.invalid'], 3);
      expect(status).toBe(200);
      expect(results.filter((result) => result.result)).toHaveLength(2);
    });
    expect(await withTenantDb(organizationId, occupiedSeats)).toBe(3);
  });

  it('serializes duplicate emails in a batch as reinvites at capacity', async () => {
    await withTenantDb(organizationId, async (tx) => {
      const { status, results } = await batch(tx, ['same@test.invalid', 'same@test.invalid']);
      expect(status).toBe(200);
      const first = results[0].result!.data.json;
      const second = results[1].result!.data.json;
      expect(first.id).toBe(second.id);
      expect(first.inviteUrl).not.toBe(second.inviteUrl);
      expect(await occupiedSeats(tx)).toBe(2);
      expect(await tx.invitation.count()).toBe(1);
    });
  });

  it('releases the invite queue after an application error', async () => {
    await withTenantDb(organizationId, async (tx) => {
      const { status, results } = await batch(tx, ['admin@test.invalid', 'new@test.invalid']);
      expect(status).toBe(207);
      expect(results[0].error?.json.data.code).toBe('CONFLICT');
      expect(results[1].result).toBeDefined();
      expect(await occupiedSeats(tx)).toBe(2);
    });
  });

  it('retains the database lock for concurrent independent requests', async () => {
    const results = await Promise.allSettled(
      ['first@test.invalid', 'second@test.invalid'].map((email) =>
        app.createCaller(context(createTenantDb(organizationId))).team.inviteMember(invite(email))
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'FORBIDDEN' } },
    ]);
    expect(await withTenantDb(organizationId, occupiedSeats)).toBe(2);
  });
});
