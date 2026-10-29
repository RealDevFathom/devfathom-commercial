// Admitted composed DB only. Invokes the actual service with PostgreSQL transactions.
// Fixture binding is explicitly TEST_DOUBLE; not authoritative-evidence/model acceptance.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  reviewRestaurantGrowth,
  type GrowthActor,
  type RestaurantGrowthBinding,
} from './growth-review';
const url = process.env.RESTAURANT_GROWTH_TEST_DATABASE_URL;
const admitted =
  process.env.RESTAURANT_GROWTH_DB_ADMITTED === '1' &&
  process.env.RESTAURANT_GROWTH_TEST_ENVIRONMENT === 'TEST_SANDBOX';
const suite = admitted && url ? describe : describe.skip;
const hash = 'a'.repeat(64);
type FixtureScope = {
  org: string;
  branch: string;
  insight: string;
  user: string;
  role: string;
};
const binding: RestaurantGrowthBinding = {
  validatePersisted: () => ({
    currency: 'PKR',
    current: { from: '2026-10-01T00:00:00.000Z', cutoff: '2026-10-02T00:00:00.000Z' },
    comparison: { from: '2026-09-30T00:00:00.000Z', cutoff: '2026-10-01T00:00:00.000Z' },
    recommendations: [
      {
        action: 'LOYALTY_REVIEW',
        evidence: [
          {
            key: 'loyalty_eligible_count',
            period: 'CURRENT',
            value: '10',
            unit: 'COUNT',
            coverage: 'COMPLETE',
          },
        ],
      },
    ],
  }),
  evidenceIsCurrent: async () => true,
}; // TEST_DOUBLE ONLY
async function connect() {
  if (!url) throw Error('Admission required');
  const parsed = new URL(url);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !/^\/restaurant_growth_test_[a-z0-9_]+$/.test(parsed.pathname)
  )
    throw Error('Named disposable loopback database required');
  const db = new Client({ connectionString: url });
  await db.connect();
  const identity = (
    await db.query(
      `SELECT current_database() AS database,host(inet_server_addr()) AS address,inet_server_port() AS port,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
    )
  ).rows[0];
  expect(identity).toMatchObject({
    database: parsed.pathname.slice(1),
    port: Number(parsed.port || 5432),
    rolsuper: false,
    rolbypassrls: false,
  });
  expect(['127.0.0.1', '::1']).toContain(identity.address);
  return db;
}
async function fixture(run: (scope: FixtureScope, admin: Client) => Promise<void>) {
  const db = await connect();
  const scope = {
    org: 'growth_test_' + randomUUID(),
    branch: 'branch_' + randomUUID(),
    insight: randomUUID(),
    user: 'user_' + randomUUID(),
    role: 'role_' + randomUUID(),
  };
  try {
    await db.query('BEGIN');
    await db.query(
      `SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true),set_config('app.is_platform_admin','false',true)`,
      [scope.org, scope.branch]
    );
    await db.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt",vertical) VALUES ($1,$1,$1,$1,now(),'RESTAURANT')`,
      [scope.org]
    );
    await db.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'TEST_DOUBLE',now())`,
      [scope.branch, scope.org]
    );
    await db.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'test','Test',now())`,
      [`department_${scope.user}`, scope.org]
    );
    await db.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'growth-test','Growth test',now())`,
      [scope.role, scope.org]
    );
    await db.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES
         ($1,$2,$3,'reports:financial','ALLOW'),($4,$2,$3,'restaurant:configure','ALLOW')`,
      [
        `permission_reports_${scope.user}`,
        scope.org,
        scope.role,
        `permission_configure_${scope.user}`,
      ]
    );
    await db.query(
      `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,role,department,title,"updatedAt") VALUES
         ($1,$2,$3,'Growth test actor',$1 || '@test.invalid','EMPLOYEE','test','Test',now())`,
      [scope.user, scope.org, scope.role]
    );
    await db.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName","primaryBranchId","updatedAt") VALUES
         ($1,$2,$3,'Growth test actor',$4,now())`,
      [`staff_${scope.user}`, scope.org, scope.user, scope.branch]
    );
    await db.query(
      `INSERT INTO restaurant_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES
         ($1,$2,$3,$4,now())`,
      [`assignment_${scope.user}`, scope.org, scope.branch, scope.user]
    );
    await db.query(
      `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,provider,model,snapshot,output) VALUES ($1,$2,$3,'RESTAURANT','TEST_DOUBLE',1,$4,'READY','TEST_DOUBLE','TEST_DOUBLE','{"actions":[{"ref":"a1","kind":"LOYALTY_REVIEW"}]}','{"recommendations":[{"actionRef":"a1"}]}')`,
      [scope.insight, scope.org, scope.branch, hash]
    );
    await db.query('COMMIT');
    await run(scope, db);
  } finally {
    await db.end();
  } // Append-only synthetic fixtures retained in named disposable DB.
}
function actor(scope: FixtureScope, failDraft = false): GrowthActor {
  return {
    ctx: {
      organizationId: scope.org,
      userId: scope.user,
      role: 'OWNER',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: async (capability: string) =>
      capability === 'reports:financial' || capability === 'restaurant:configure',
    db: {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const db = await connect();
        try {
          await db.query('BEGIN');
          await db.query(
            `SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true),set_config('app.is_platform_admin','false',true)`,
            [scope.org, scope.branch]
          );
          const tx = {
            organization: {
              findFirst: async () =>
                (await db.query('SELECT vertical FROM organizations WHERE id=$1', [scope.org]))
                  .rows[0],
            },
            restaurantBranch: {
              findFirst: async () =>
                (
                  await db.query(
                    'SELECT id FROM restaurant_branches WHERE "organizationId"=$1 AND id=$2 AND active=true',
                    [scope.org, scope.branch]
                  )
                ).rows[0],
            },
            $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
              (await db.query(sql, values)).rows,
            $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
              if (failDraft && sql.includes('INSERT INTO restaurant_growth_drafts'))
                throw Error('TEST_DOUBLE draft failure');
              return (await db.query(sql, values)).rowCount;
            },
          };
          const result = await work(tx);
          await db.query('COMMIT');
          return result;
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        } finally {
          await db.end();
        }
      },
    },
  } as unknown as GrowthActor;
}
const request = (scope: Pick<FixtureScope, 'branch' | 'insight'>) => ({
  branchId: scope.branch,
  insightId: scope.insight,
  recommendation: 0,
  expectedHash: hash,
  expectedVersion: 1,
  expectedRevision: 0,
  requestId: randomUUID(),
  decision: 'APPROVE',
  settings: { priority: 'NORMAL', objective: 'REVIEW_RETENTION' },
});
async function counts(db: Client, scope: FixtureScope) {
  await db.query('BEGIN');
  try {
    await db.query(
      `SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true)`,
      [scope.org, scope.branch]
    );
    return (
      await db.query(
        `SELECT (SELECT count(*)::int FROM restaurant_growth_reviews WHERE "insightId"=$1) AS reviews,(SELECT count(*)::int FROM restaurant_growth_drafts WHERE "insightId"=$1) AS drafts`,
        [scope.insight]
      )
    ).rows[0];
  } finally {
    await db.query('ROLLBACK');
  }
}
suite('actual Restaurant review service concurrency / TEST_DOUBLE binding', () => {
  it('same request across two connections commits one final review and one draft', async () =>
    fixture(async (scope, db) => {
      const input = request(scope);
      const results = await Promise.all([
        reviewRestaurantGrowth(actor(scope), input, binding),
        reviewRestaurantGrowth(actor(scope), input, binding),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(await counts(db, scope)).toEqual({ reviews: 1, drafts: 1 });
    }));
  it('distinct simultaneous final decisions permit exactly one', async () =>
    fixture(async (scope, db) => {
      const results = await Promise.allSettled([
        reviewRestaurantGrowth(actor(scope), request(scope), binding),
        reviewRestaurantGrowth(actor(scope), { ...request(scope), decision: 'REJECT' }, binding),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await counts(db, scope)).reviews).toBe(1);
    }));
  it('draft failure rolls back actual service review insert', async () =>
    fixture(async (scope, db) => {
      await expect(
        reviewRestaurantGrowth(actor(scope, true), request(scope), binding)
      ).rejects.toThrow('TEST_DOUBLE draft failure');
      expect(await counts(db, scope)).toEqual({ reviews: 0, drafts: 0 });
    }));
});
