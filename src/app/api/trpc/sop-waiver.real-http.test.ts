// @vitest-environment node
/** Real HTTP route, SOP router, ABAC, audit, credential hashing and restricted PG/RLS.
 * Only the host/session and entitlement lookup are fixture seams; transaction handling
 * and both independent credential and request transactions are production code.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTRPCUntypedClient, httpLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import superjson from 'superjson';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const fixture = vi.hoisted(() => ({
  org: '',
  user: '',
  role: 'ADMIN',
  transactions: [] as string[],
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async () => ({
    session: {
      expires: '2099-01-01',
      user: { id: fixture.user, organizationId: fixture.org, role: fixture.role, status: 'ACTIVE' },
    },
    support: null,
  }),
}));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<object>()),
  requireOrganizationForRequest: async () => ({ id: fixture.org, status: 'ACTIVE' }),
}));
vi.mock('@/lib/auth/anonymous-tenant', () => ({ organizationForAnonymousToken: async () => null }));
vi.mock('@/server/routers/anonymous-fallback', () => ({ anonymousFallbackRouter: {} }));
vi.mock('@/server/routers/_app', async () => {
  const { router } = await import('@/server/trpc');
  const { restaurantSopExecutionRouter } =
    await import('@/server/routers/restaurant-sop-execution');
  return { appRouter: router({ restaurantSopExecution: restaurantSopExecutionRouter }) };
});
vi.mock('@/server/trpc', async (original) => {
  const actual = await original<typeof import('@/server/trpc')>();
  const { packageByKey } = await import('@/lib/vertical-catalog');
  return {
    ...actual,
    createTRPCContext: async (options: {
      db: ScopedDb;
      session: unknown;
      organization: unknown;
    }) => {
      const [row] = await options.db.$queryRawUnsafe<{ id: string }[]>(
        'SELECT pg_current_xact_id()::text AS id'
      );
      fixture.transactions.push(row.id);
      const pkg = packageByKey('restaurant-enterprise')!;
      return {
        ...options,
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
        entitlements: {
          organizationId: fixture.org,
          enabledModules: [...pkg.moduleKeys],
          modules: [],
          limits: pkg.defaultLimits,
          activeSeats: 1,
          seatLimit: 50,
        },
      };
    },
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const suite = databaseUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (name: string) => `sop591_${name}_${suffix}`;
let observer: pg.Client;
let server: Server;
let endpoint: string;
let tenantDb: ScopedDb;
let deps: typeof import('@/lib/tenancy/scoped-db');
let flushAudit: (typeof import('@/server/audit'))['flushAuditWritesForTest'];
const PIN = '4821';
function client() {
  return createTRPCUntypedClient<AnyTRPCRouter>({
    links: [httpLink({ url: endpoint, transformer: superjson })],
  });
}
const waiver = (occurrence = id('occurrence'), pin = PIN) => ({
  occurrenceId: occurrence,
  actorStaffProfileId: 'spoofed',
  approvingStaffProfileId: id('owner'),
  approvingPin: pin,
  reason: 'Emergency closure',
});
async function credential() {
  return tenantDb.restaurantOperatorCredential.findUniqueOrThrow({
    where: { id: id('credential') },
  });
}
async function resetCredential() {
  await tenantDb.restaurantOperatorCredential.update({
    where: { id: id('credential') },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}
async function noWaiverWrites(occurrence: string) {
  expect(
    await tenantDb.restaurantSopOccurrence.findUniqueOrThrow({ where: { id: occurrence } })
  ).toMatchObject({ status: 'MISSED' });
  expect(
    await tenantDb.restaurantSopVerification.count({ where: { occurrenceId: occurrence } })
  ).toBe(0);
  expect(await tenantDb.restaurantCoAuthorization.count({ where: { targetId: occurrence } })).toBe(
    0
  );
  expect(
    await tenantDb.auditLog.count({
      where: { action: 'sop.waive.soloOwnerApproval', targetId: occurrence },
    })
  ).toBe(0);
}

suite('SOP waiver credential durability through the real HTTP rollback boundary', () => {
  beforeAll(async () => {
    expect(['localhost', '127.0.0.1', '::1']).toContain(new URL(databaseUrl!).hostname);
    fixture.org = id('org');
    fixture.user = id('user');
    observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    expect(
      (
        await observer.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        )
      ).rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await observer.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    await observer.query(
      'INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt") VALUES ($1,$1,$1,$1,now())',
      [fixture.org]
    );
    deps = await import('@/lib/tenancy/scoped-db');
    tenantDb = deps.createTenantDb(fixture.org, fixture.user);
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    const hash = await hashOperatorCredential('PIN', PIN);
    await deps.withTenantDb(fixture.org, async (db) => {
      await db.organizationDepartment.create({ data: { key: 'ops', name: 'Operations' } });
      await db.user.create({
        data: {
          id: fixture.user,
          name: 'Owner',
          email: `${fixture.user}@test.invalid`,
          role: 'ADMIN',
          department: 'ops',
          title: 'Owner',
        },
      });
      for (const name of ['primary', 'target'])
        await db.restaurantBranch.create({ data: { id: id(name), name } });
      await db.restaurantStaffProfile.create({
        data: {
          id: id('owner'),
          userId: fixture.user,
          displayName: 'Owner',
          primaryBranchId: id('primary'),
        },
      });
      await db.restaurantOperatorCredential.create({
        data: {
          id: id('credential'),
          staffProfileId: id('owner'),
          type: 'PIN',
          credentialHash: hash,
        },
      });
      await db.restaurantSopTemplate.create({ data: { id: id('template'), name: 'Closure' } });
      await db.restaurantSopTemplateVersion.create({
        data: {
          id: id('version'),
          templateId: id('template'),
          versionNumber: 1,
          status: 'PUBLISHED',
        },
      });
      await db.restaurantSopAssignment.create({
        data: {
          id: id('assignment'),
          branchId: id('target'),
          templateId: id('template'),
          startDate: new Date('2026-10-01'),
          daysOfWeek: [],
          assigneeTargetType: 'PERSON',
          assigneeStaffProfileId: id('owner'),
        },
      });
      for (const [index, name] of [
        'occurrence',
        'solo',
        'multi',
        'concurrent',
        'verify-lockout',
        'verify-solo',
        'verify-multi',
      ].entries())
        await db.restaurantSopOccurrence.create({
          data: {
            id: id(name),
            branchId: id('target'),
            assignmentId: id('assignment'),
            templateVersionId: id('version'),
            status: name.startsWith('verify-') ? 'SUBMITTED' : 'MISSED',
            businessDate: new Date('2026-10-01'),
            dueAt: new Date(Date.UTC(2026, 9, 1, index)),
            windowEndsAt: new Date('2026-10-02'),
            assignedStaffProfileId: id('owner'),
          },
        });
    });
    flushAudit = (await import('@/server/audit')).flushAuditWritesForTest;
    const { GET, POST } = await import('./[trpc]/route');
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await (incoming.method === 'POST' ? POST : GET)(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.writeHead(500);
        outgoing.end('Test transport failed');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    endpoint = `http://127.0.0.1:${address.port}/api/trpc`;
  }, 60000);
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (flushAudit) await flushAudit();
    if (observer) {
      await observer.query('DELETE FROM organizations WHERE id=$1', [fixture.org]);
      await observer.end();
    }
  });

  it('commits five bad PIN attempts, locks the credential, and rolls back every HTTP procedure', async () => {
    fixture.transactions.length = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(
        client().mutation('restaurantSopExecution.waive', waiver(id('occurrence'), '1111'))
      ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
      await flushAudit();
      const row = await credential();
      // The existing credential policy resets the strike counter when it locks.
      expect(row.failedAttempts).toBe(attempt === 5 ? 0 : attempt);
      expect(row.lockedUntil !== null).toBe(attempt === 5);
      await noWaiverWrites(id('occurrence'));
    }
    await expect(client().mutation('restaurantSopExecution.waive', waiver())).rejects.toMatchObject(
      { data: { code: 'FORBIDDEN' } }
    );
    await flushAudit();
    expect((await credential()).failedAttempts).toBe(0);
    expect((await credential()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    for (const txid of fixture.transactions)
      expect(
        (await observer.query('SELECT pg_xact_status($1::xid8) AS state', [txid])).rows[0].state
      ).toBe('aborted');
    await noWaiverWrites(id('occurrence'));
  }, 60000);

  it('serializes concurrent failed attempts instead of losing increments', async () => {
    await resetCredential();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        client().mutation('restaurantSopExecution.waive', waiver(id('concurrent'), '1111'))
      )
    );
    expect(attempts.every((result) => result.status === 'rejected')).toBe(true);
    await flushAudit();
    expect(await credential()).toMatchObject({ failedAttempts: 0, lockedUntil: expect.any(Date) });
    await noWaiverWrites(id('concurrent'));
  }, 60000);

  it('commits explicit solo-owner audit evidence and derives the actor across branches', async () => {
    await resetCredential();
    await expect(
      client().mutation('restaurantSopExecution.waive', waiver(id('solo')))
    ).resolves.toMatchObject({ action: 'WAIVE' });
    await flushAudit();
    const coauth = await tenantDb.restaurantCoAuthorization.findFirstOrThrow({
      where: { targetId: id('solo') },
    });
    expect(coauth).toMatchObject({
      actingStaffProfileId: id('owner'),
      approvingStaffProfileId: id('owner'),
    });
    const audit = await tenantDb.auditLog.findFirstOrThrow({
      where: { action: 'sop.waive.soloOwnerApproval', targetId: id('solo') },
    });
    expect(audit).toMatchObject({
      actorStaffProfileId: id('owner'),
      metadata: {
        coAuthorizationId: coauth.id,
        branchId: id('target'),
        reason: 'Emergency closure',
      },
    });
    expect(JSON.stringify(audit)).not.toContain(PIN);
  });

  it('persists bad-PIN lockouts for own-work verification and audits a valid solo verification', async () => {
    await resetCredential();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(
        client().mutation('restaurantSopExecution.verify', {
          occurrenceId: id('verify-lockout'),
          approvalPin: '1111',
          actorStaffProfileId: 'spoofed',
        })
      ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
      await flushAudit();
      expect((await credential()).failedAttempts).toBe(attempt === 5 ? 0 : attempt);
      expect(
        await tenantDb.restaurantSopVerification.count({
          where: { occurrenceId: id('verify-lockout') },
        })
      ).toBe(0);
    }
    expect((await credential()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(
      client().mutation('restaurantSopExecution.verify', {
        occurrenceId: id('verify-lockout'),
        approvalPin: PIN,
      })
    ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
    await resetCredential();
    await expect(
      client().mutation('restaurantSopExecution.verify', {
        occurrenceId: id('verify-solo'),
        approvalPin: PIN,
      })
    ).resolves.toMatchObject({ action: 'VERIFY' });
    await flushAudit();
    const audit = await tenantDb.auditLog.findFirstOrThrow({
      where: { action: 'sop.verify.soloOwnerApproval', targetId: id('verify-solo') },
    });
    expect(audit.actorStaffProfileId).toBe(id('owner'));
    expect(JSON.stringify(audit)).not.toContain(PIN);
  }, 60000);

  it('requires a second approver when any other active staff member exists', async () => {
    await tenantDb.restaurantStaffProfile.create({
      data: { id: id('second'), displayName: 'Second operator', primaryBranchId: id('primary') },
    });
    await expect(
      client().mutation('restaurantSopExecution.waive', waiver(id('multi')))
    ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
    await flushAudit();
    await noWaiverWrites(id('multi'));
    await expect(
      client().mutation('restaurantSopExecution.verify', {
        occurrenceId: id('verify-multi'),
        approvalPin: PIN,
      })
    ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
    expect(
      await tenantDb.restaurantSopVerification.count({
        where: { occurrenceId: id('verify-multi') },
      })
    ).toBe(0);
  });

  it('accepts a PIN-only second approver whose job grants are at a different branch than their primary assignment', async () => {
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    await deps.withTenantDb(fixture.org, async (db) => {
      await db.restaurantJobRole.create({
        data: { id: id('reviewer-role'), key: 'reviewer', name: 'Reviewer' },
      });
      await db.restaurantJobRoleCapability.createMany({
        data: ['sop:verify', 'coauth:approve'].map((capability) => ({
          jobRoleId: id('reviewer-role'),
          capability,
        })),
      });
      await db.restaurantStaffJobRole.create({
        data: {
          staffProfileId: id('second'),
          jobRoleId: id('reviewer-role'),
          branchId: id('target'),
        },
      });
      await db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: id('second'),
          type: 'PIN',
          credentialHash: await hashOperatorCredential('PIN', PIN),
        },
      });
    });
    await expect(
      client().mutation('restaurantSopExecution.waive', {
        ...waiver(id('multi')),
        approvingStaffProfileId: id('second'),
      })
    ).resolves.toMatchObject({ action: 'WAIVE' });
    await flushAudit();
    expect(
      await tenantDb.restaurantCoAuthorization.findFirstOrThrow({
        where: { targetId: id('multi') },
      })
    ).toMatchObject({ actingStaffProfileId: id('owner'), approvingStaffProfileId: id('second') });
    expect(
      await tenantDb.auditLog.count({
        where: { action: 'sop.waive.soloOwnerApproval', targetId: id('multi') },
      })
    ).toBe(0);
  });

  it('redacts PIN plaintext in parser and capability failures before the resolver runs', async () => {
    await expect(
      client().mutation('restaurantSopExecution.waive', waiver(id('multi'), 'invalid-pin'))
    ).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } });
    await tenantDb.user.update({ where: { id: fixture.user }, data: { role: 'EMPLOYEE' } });
    fixture.role = 'EMPLOYEE';
    try {
      await expect(
        client().mutation('restaurantSopExecution.waive', waiver(id('multi'), '8765'))
      ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
      await flushAudit();
      const logs = await tenantDb.auditLog.findMany({
        where: { action: 'restaurantSopExecution.waive', outcome: 'FAILURE' },
      });
      expect(logs.some((row) => JSON.stringify(row.input).includes('[REDACTED]'))).toBe(true);
      expect(JSON.stringify(logs)).not.toContain('invalid-pin');
      expect(JSON.stringify(logs)).not.toContain('8765');
    } finally {
      fixture.role = 'ADMIN';
      await tenantDb.user.update({ where: { id: fixture.user }, data: { role: 'ADMIN' } });
    }
  });
});
