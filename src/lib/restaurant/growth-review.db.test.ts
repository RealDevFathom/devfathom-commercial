// Admission-only: already composed disposable DB; never loads private env or applies migrations.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
// This suite rolls every fixture back and only needs the migrated restricted-role
// database already supplied by the QA gate. A dedicated override remains available.
const url = process.env.RESTAURANT_GROWTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;
const hash = 'a'.repeat(64);
const settings = JSON.stringify({ priority: 'NORMAL', objective: 'REVIEW_RETENTION' });
async function fixture(
  run: (db: Client, scope: { org: string; branch: string; insight: string }) => Promise<void>
) {
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Explicit disposable loopback database required');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const role = (
      await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await db.query('BEGIN');
    const org = `growth_test_${randomUUID()}`;
    const branch = `branch_${randomUUID()}`;
    const insight = randomUUID();
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true),set_config('app.is_platform_admin','false',true)",
      [org, branch]
    );
    await db.query(
      'INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt",vertical) VALUES ($1,$1,$1,$1,now(),\'RESTAURANT\')',
      [org]
    );
    await db.query(
      'INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,\'Synthetic acceptance branch\',now())',
      [branch, org]
    );
    await db.query(
      `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,provider,model,snapshot,output) VALUES ($1,$2,$3,'RESTAURANT','synthetic-actor',1,$4,'READY','TEST_DOUBLE','TEST_DOUBLE','{"actions":[{"ref":"a1","kind":"LOYALTY_REVIEW"}]}','{"recommendations":[{"actionRef":"a1"}]}')`,
      [insight, org, branch, hash]
    );
    await run(db, { org, branch, insight });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}
async function review(
  db: Client,
  scope: { org: string; branch: string; insight: string },
  decision = 'EDIT',
  revision = 1,
  draft: string | null = null
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO restaurant_growth_reviews (id,"organizationId","branchId","insightId",recommendation,revision,decision,"actorId",settings,"draftId","requestId",fingerprint,"inputHash","schemaVersion") VALUES ($1,$2,$3,$4,0,$5,$6,'synthetic-actor',$7,$8,$9,'synthetic-fingerprint',$10,1)`,
    [
      id,
      scope.org,
      scope.branch,
      scope.insight,
      revision,
      decision,
      settings,
      draft,
      randomUUID(),
      hash,
    ]
  );
  return id;
}
suite('Restaurant review composed restricted-role storage', () => {
  it('forces tenant and exact branch RLS without platform bypass', async () =>
    fixture(async (db, scope) => {
      await review(db, scope);
      for (const [org, branch] of [
        ['other-org', scope.branch],
        [scope.org, 'other-branch'],
        [scope.org, ''],
      ]) {
        await db.query(
          "SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true),set_config('app.is_platform_admin','true',true)",
          [org, branch]
        );
        expect((await db.query('SELECT id FROM restaurant_growth_reviews')).rows).toHaveLength(0);
      }
    }));
  it('rejects foreign-tenant insert under RLS', async () =>
    fixture(async (db, scope) => {
      await db.query('SAVEPOINT foreign_review');
      // BEFORE INSERT lineage guard runs before the review policy's WITH CHECK.
      await expect(review(db, { ...scope, org: 'other-org' })).rejects.toMatchObject({
        code: '23514',
        message: 'Matching ready Restaurant insight required',
      });
      await db.query('ROLLBACK TO SAVEPOINT foreign_review');
      expect((await db.query('SELECT id FROM restaurant_growth_reviews')).rows).toHaveLength(0);
      // Also prove a direct foreign-tenant write is refused by PostgreSQL RLS.
      await expect(
        db.query(
          `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,"failureCode",snapshot) VALUES ($1,'other-org',$2,'RESTAURANT','synthetic-actor',1,$3,'INSUFFICIENT_DATA','SPARSE','{}')`,
          [randomUUID(), scope.branch, hash]
        )
      ).rejects.toMatchObject({
        code: '42501',
      });
    }));
  it('rejects updates to append-only review', async () =>
    fixture(async (db, scope) => {
      const id = await review(db, scope);
      await expect(
        db.query("UPDATE restaurant_growth_reviews SET decision='REJECT' WHERE id=$1", [id])
      ).rejects.toMatchObject({ code: '23514' });
    }));
  it('requires matching draft before approval can commit', async () =>
    fixture(async (db, scope) => {
      await review(db, scope, 'APPROVE', 1, randomUUID());
      await expect(db.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23503',
      });
    }));
  it('accepts inert paired draft and forbids a second final decision', async () =>
    fixture(async (db, scope) => {
      const draft = randomUUID();
      const id = await review(db, scope, 'APPROVE', 1, draft);
      await db.query(
        `INSERT INTO restaurant_growth_drafts (id,"organizationId","branchId","insightId",recommendation,"reviewId",action,settings,"actorId") VALUES ($1,$2,$3,$4,0,$5,'LOYALTY_REVIEW',$6,'synthetic-actor')`,
        [draft, scope.org, scope.branch, scope.insight, id, settings]
      );
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(
        (await db.query('SELECT status FROM restaurant_growth_drafts WHERE id=$1', [draft])).rows
      ).toEqual([{ status: 'DRAFT' }]);
      await expect(review(db, scope, 'REJECT', 2)).rejects.toMatchObject({ code: '23514' });
    }));
});
