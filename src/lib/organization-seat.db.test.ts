/**
 * Seat limit under real concurrency (follow-up to #164 / #199).
 *
 * Every path that creates or reactivates a user funnels through
 * `lockOrganizationSeat`, which takes a `FOR UPDATE` lock on the organization
 * row before counting occupied seats. This test proves that lock actually
 * serializes competing transactions against a real PostgreSQL: a burst of
 * parallel invites and reactivations through the team router and AI tool race
 * for the last free seats without pushing the occupied count past the limit. Without the row lock, each transaction would read the
 * same pre-insert count and all of them would be admitted.
 *
 * Requires a disposable database. `TEST_DATABASE_URL` is the restricted runtime
 * role (NOSUPERUSER NOBYPASSRLS); the owner URL seeds fixtures. Skipped — never
 * silently passed — when either is absent. Run with `TZ=UTC`.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', () => ({
  appUrl: () => 'http://acme.localhost',
  sendEmail: vi.fn(),
  templates: { inviteMember: () => ({ subject: 'invite', html: '', text: '' }) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: () => ({}),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: async () => true,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({
    enabledModules: [],
    activeSeats: 3,
    seatLimit: 5,
  }),
}));

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const ownerUrl =
  process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.WHA566_OWNER_DATABASE_URL ?? '';
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
if (runtimeUrl && runtimeUrl === ownerUrl)
  throw new Error('Runtime and owner database URLs must differ');
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let lockOrganizationSeat: typeof import('@/lib/organization-seat').lockOrganizationSeat;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `seat_org_${suffix}`;
const DEPARTMENT = 'LEADERSHIP';
const SEAT_LIMIT = 5;
const PRESEEDED_ACTIVE = 3; // 2 free seats remain
const PARALLEL_INVITES = 8;

const owner = new pg.Client({ connectionString: ownerUrl });

describeIfDatabase('organization seat limit under concurrency', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ lockOrganizationSeat } = await import('@/lib/organization-seat'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1,$2,$3,$3,now())`,
      [`dept_${suffix}`, organizationId, DEPARTMENT]
    );
    for (let i = 0; i < PRESEEDED_ACTIVE; i += 1) {
      await owner.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, status, "updatedAt")
         VALUES ($1,$2,$3,$4,$5,'Member','ACTIVE',now())`,
        [
          `seat_seed_${suffix}_${i}`,
          organizationId,
          `Seed ${i}`,
          `seed_${i}_${suffix}@acme.test`,
          DEPARTMENT,
        ]
      );
    }
  });

  afterAll(async () => {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(`DELETE FROM invitations WHERE "organizationId" = $1`, [organizationId]);
    await owner.query(`DELETE FROM users WHERE "organizationId" = $1`, [organizationId]);
    await owner.query(`DELETE FROM organization_departments WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await owner.end();
  });

  beforeEach(async () => {
    await owner.query(`DELETE FROM invitations WHERE "organizationId" = $1`, [organizationId]);
    await owner.query(`DELETE FROM users WHERE "organizationId" = $1 AND id NOT LIKE $2`, [
      organizationId,
      `seat_seed_${suffix}_%`,
    ]);
  });

  // Run actual caller/tool code in independent RLS-scoped transactions. No mock
  // of lockOrganizationSeat: removing its call lets every contender be admitted.
  async function inviteThrough(path: 'team' | 'people', email: string) {
    return withTenantDb(organizationId, async (tx) => {
      const input = {
        name: 'Invitee',
        email,
        role: 'EMPLOYEE' as const,
        department: DEPARTMENT,
        title: 'Member',
      };
      if (path === 'team') {
        const { teamRouter } = await import('@/server/routers/team');
        const context = {
          db: tx,
          entitlements: {
            enabledModules: [],
            activeSeats: PRESEEDED_ACTIVE,
            seatLimit: SEAT_LIMIT,
          },
          session: {
            expires: 'later',
            user: {
              id: `seat_seed_${suffix}_0`,
              organizationId,
              role: 'ADMIN',
              status: 'ACTIVE',
              department: DEPARTMENT,
            },
          },
          organization: { id: organizationId, isDemo: false },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as import('@/server/trpc').TRPCContext;
        return teamRouter.createCaller(context).inviteMember(input);
      }
      const { buildPeopleTools } = await import('@/lib/ai/tools/people');
      const tools = buildPeopleTools({
        db: tx,
        isAdmin: true,
        isAdminOrHr: true,
        isHr: false,
        ctx: { organizationId, userId: `seat_seed_${suffix}_0`, name: 'Admin' },
        can: async () => true,
        audit: () => {},
      } as unknown as import('@/lib/ai/context').AssistantHelpers);
      return (
        tools.inviteMember as unknown as { execute: (data: typeof input) => Promise<unknown> }
      ).execute(input);
    });
  }

  it.each(['team', 'people'] as const)(
    '%s: new invites and reactivations serialize on the organization seat lock',
    async (path) => {
      for (const reactivate of [false, true]) {
        await owner.query(`DELETE FROM invitations WHERE "organizationId" = $1`, [organizationId]);
        await owner.query(`DELETE FROM users WHERE "organizationId" = $1 AND id NOT LIKE $2`, [
          organizationId,
          `seat_seed_${suffix}_%`,
        ]);
        if (reactivate) {
          for (let i = 0; i < PARALLEL_INVITES; i++) {
            await owner.query(
              `INSERT INTO users (id, "organizationId", name, email, department, title, status, "updatedAt") VALUES ($1,$2,'Former',$3,$4,'Member','INACTIVE',now())`,
              [`former_${suffix}_${i}`, organizationId, `race_${i}_${suffix}@acme.test`, DEPARTMENT]
            );
          }
        }
        const results = await Promise.allSettled(
          Array.from({ length: PARALLEL_INVITES }, (_, i) =>
            inviteThrough(path, `race_${i}_${suffix}@acme.test`)
          )
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
          SEAT_LIMIT - PRESEEDED_ACTIVE
        );
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected).toHaveLength(PARALLEL_INVITES - (SEAT_LIMIT - PRESEEDED_ACTIVE));
        for (const result of rejected)
          expect(result.reason).toMatchObject({ code: 'PRECONDITION_FAILED' });
        const occupied = await withTenantDb(organizationId, (tx) =>
          tx.user.count({ where: { status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } } })
        );
        expect(occupied).toBe(SEAT_LIMIT);
        const admittedIndex = results.findIndex((r) => r.status === 'fulfilled');
        // Resending an invitation already occupying a seat needs no extra seat.
        await expect(
          inviteThrough(path, `race_${admittedIndex}_${suffix}@acme.test`)
        ).resolves.toBeDefined();
        // Already at the limit: a deactivated user's re-invite is refused too.
        await owner.query(
          `INSERT INTO users (id, "organizationId", name, email, department, title, status, "updatedAt") VALUES ($1,$2,'Former',$3,$4,'Member','INACTIVE',now())`,
          [
            `full_${suffix}_${reactivate}`,
            organizationId,
            `full_${reactivate}_${suffix}@acme.test`,
            DEPARTMENT,
          ]
        );
        await expect(
          inviteThrough(path, `full_${reactivate}_${suffix}@acme.test`)
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      }
    }
  );

  it('never admits more invites than the free seats, however many race', async () => {
    const invite = (index: number) =>
      withTenantDb(organizationId, async (tx: ScopedDb) => {
        await lockOrganizationSeat(tx, organizationId, SEAT_LIMIT);
        return tx.user.create({
          data: {
            organizationId,
            name: `Invitee ${index}`,
            email: `invitee_${index}_${suffix}@acme.test`,
            department: DEPARTMENT,
            title: 'Invitee',
            status: 'INVITED',
          },
          select: { id: true },
        });
      });

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_INVITES }, (_, index) => invite(index))
    );

    const admitted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // Exactly the free seats were filled, not one more.
    expect(admitted).toHaveLength(SEAT_LIMIT - PRESEEDED_ACTIVE);
    expect(rejected).toHaveLength(PARALLEL_INVITES - (SEAT_LIMIT - PRESEEDED_ACTIVE));
    // Every loser failed for the seat-limit reason, not a deadlock or FK error.
    for (const failure of rejected) {
      expect(String(failure.reason?.message ?? failure.reason)).toContain('Seat limit reached');
    }

    // The durable truth: occupied seats land exactly on the limit.
    const occupied = await withTenantDb(organizationId, (tx: ScopedDb) =>
      tx.user.count({
        where: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
      })
    );
    expect(occupied).toBe(SEAT_LIMIT);
  });
});
