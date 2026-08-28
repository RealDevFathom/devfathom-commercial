/**
 * WHA-288 — promotion tenant isolation, immutability and audit, on real
 * PostgreSQL under an UNPRIVILEGED role.
 *
 * Requires M8_TEST_OWNER_DATABASE_URL or TEST_DATABASE_URL (local only). The
 * probes run as a purpose-made LOGIN NOSUPERUSER NOBYPASSRLS role, because a
 * superuser bypasses RLS entirely and would make every assertion here
 * meaningless.
 *
 * What is proved:
 *   - every promotion table has RLS both ENABLED and FORCED;
 *   - a tenant sees its own rows and only its own;
 *   - a cross-tenant INSERT is refused by the policy (42501);
 *   - a crafted cross-tenant RELATION is refused by the composite tenant FK
 *     (23503) — the case RLS alone would let through, where org A points a row
 *     at org B's promotion version;
 *   - an application and a redemption cannot be updated or deleted at all
 *     (55000), so the audit trail survives a direct SQL client;
 *   - an ACTIVE version and its owned rows are frozen, while the sanctioned
 *     ACTIVE -> SUPERSEDED transition still works.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIfDatabase = url ? describe : describe.skip;

const client = url ? new pg.Client({ connectionString: url }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `promo_runtime_${suffix}`;
const orgA = `promo_org_a_${suffix}`;
const orgB = `promo_org_b_${suffix}`;

const PROMOTION_TABLES = [
  'restaurant_promotions',
  'restaurant_promotion_versions',
  'restaurant_promotion_targets',
  'restaurant_promotion_channels',
  'restaurant_promotion_branches',
  'restaurant_promotion_caps',
  'restaurant_promotion_applications',
  'restaurant_promotion_redemptions',
] as const;

const id = (kind: string, tenant: string) => `${kind}_${tenant}_${suffix}`;

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client!.query('SAVEPOINT expected_failure');
  try {
    await operation();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client!.query('RELEASE SAVEPOINT expected_failure');
  }
}

/** Seed one tenant's full promotion chain, authored the real way: DRAFT ->
 * children attached -> ACTIVE. */
async function seedTenant(tenant: 'a' | 'b', organizationId: string) {
  await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
    organizationId,
  ]);
  await client!.query(
    `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","primaryBranchId","updatedAt")
     VALUES ($1,$2,'Operator',$3,now())`,
    [id('staff', tenant), organizationId, id('branch', tenant)]
  );
  await client!.query(
    `INSERT INTO "restaurant_registered_devices" ("id","organizationId","branchId","name","deviceSecretHash","updatedAt")
     VALUES ($1,$2,$3,'POS',$1,now())`,
    [id('device', tenant), organizationId, id('branch', tenant)]
  );
  await client!.query(
    `INSERT INTO "restaurant_products" ("id","organizationId","name","updatedAt") VALUES ($1,$2,'Item',now())`,
    [id('product', tenant), organizationId]
  );
  await client!.query(
    `INSERT INTO "restaurant_orders"
       ("id","organizationId","branchId","orderNumber","businessDate","channel","staffProfileId","deviceId","updatedAt")
     VALUES ($1,$2,$3,1,DATE '2030-01-01','DINE_IN',$4,$5,now())`,
    [
      id('order', tenant),
      organizationId,
      id('branch', tenant),
      id('staff', tenant),
      id('device', tenant),
    ]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotions" ("id","organizationId","name","code","updatedAt")
     VALUES ($1,$2,'Fixture',$3,now())`,
    [id('promotion', tenant), organizationId, `CODE_${tenant.toUpperCase()}_${suffix}`]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_versions"
       ("id","organizationId","promotionId","versionNumber","ruleCode",status,"effectiveFrom",
        "targetScope","benefitKind","benefitRate","updatedAt")
     VALUES ($1,$2,$3,1,$4,'DRAFT',TIMESTAMP '2020-01-01','PRODUCT','PERCENTAGE_OFF',0.1,now())`,
    [id('version', tenant), organizationId, id('promotion', tenant), `RULE_${tenant.toUpperCase()}`]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_targets" ("id","organizationId","promotionVersionId","productId")
     VALUES ($1,$2,$3,$4)`,
    [id('target', tenant), organizationId, id('version', tenant), id('product', tenant)]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_channels" ("id","organizationId","promotionVersionId",channel)
     VALUES ($1,$2,$3,'DINE_IN')`,
    [id('channel', tenant), organizationId, id('version', tenant)]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_branches" ("id","organizationId","promotionVersionId","branchId")
     VALUES ($1,$2,$3,$4)`,
    [id('scope', tenant), organizationId, id('version', tenant), id('branch', tenant)]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_caps" ("id","organizationId","promotionVersionId",scope,"maxRedemptions")
     VALUES ($1,$2,$3,'TOTAL',10)`,
    [id('cap', tenant), organizationId, id('version', tenant)]
  );
  await client!.query(
    `UPDATE "restaurant_promotion_versions" SET status='ACTIVE', "activatedAt"=now() WHERE "id"=$1`,
    [id('version', tenant)]
  );
  // A second, still-DRAFT version. The crafted cross-tenant CHILD probes below
  // need an unfrozen parent: the child-freeze trigger is a BEFORE trigger and
  // would fire ahead of the foreign key on an ACTIVE version, masking the very
  // tenant check those probes exist to prove.
  await client!.query(
    `INSERT INTO "restaurant_promotion_versions"
       ("id","organizationId","promotionId","versionNumber","ruleCode",status,"effectiveFrom",
        "targetScope","benefitKind","benefitRate","updatedAt")
     VALUES ($1,$2,$3,2,$4,'DRAFT',TIMESTAMP '2020-01-01','PRODUCT','PERCENTAGE_OFF',0.1,now())`,
    [
      id('draftversion', tenant),
      organizationId,
      id('promotion', tenant),
      `DRAFT_RULE_${tenant.toUpperCase()}`,
    ]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_applications"
       ("id","organizationId","promotionId","promotionVersionId","versionNumber","ruleCode",
        "targetScope","benefitKind","benefitRate",authority,"orderId","branchId","businessDate",
        sequence,"discountAmount")
     VALUES ($1,$2,$3,$4,1,$5,'PRODUCT','PERCENTAGE_OFF',0.1,'AUTOMATIC',$6,$7,DATE '2030-01-01',1,10.00)`,
    [
      id('application', tenant),
      organizationId,
      id('promotion', tenant),
      id('version', tenant),
      `RULE_${tenant.toUpperCase()}`,
      id('order', tenant),
      id('branch', tenant),
    ]
  );
  await client!.query(
    `INSERT INTO "restaurant_promotion_redemptions"
       ("id","organizationId","promotionVersionId","capScope","capKey",ordinal,"applicationId")
     VALUES ($1,$2,$3,'TOTAL','*',1,$4)`,
    [id('redemption', tenant), organizationId, id('version', tenant), id('application', tenant)]
  );
}

describeIfDatabase('promotion tenant isolation, immutability and audit', () => {
  beforeAll(async () => {
    const hostname = new URL(url!).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('Refusing to run promotion RLS probes against a non-local database');
    }
    await client!.connect();
    await client!.query('BEGIN');
    await client!.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client!.query(`GRANT "${role}" TO CURRENT_USER`);
    await client!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client!.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROMOTION_TABLES.join(', ')} TO "${role}"`
    );

    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()), ($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [orgA, orgB]
    );
    await client!.query(
      `INSERT INTO "restaurant_branches" ("id","organizationId",name,"updatedAt")
       VALUES ($1,$2,'A',now()),($3,$4,'B',now())`,
      [id('branch', 'a'), orgA, id('branch', 'b'), orgB]
    );

    await seedTenant('a', orgA);
    await seedTenant('b', orgB);
  }, 60_000);

  afterAll(async () => {
    await client?.query('ROLLBACK');
    await client?.end();
  });

  it('has RLS both enabled and forced on every promotion table', async () => {
    await client!.query('RESET ROLE');
    const result = await client!.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relkind = 'r' AND relname = ANY($1::text[])
          AND relrowsecurity AND relforcerowsecurity
        ORDER BY relname`,
      [[...PROMOTION_TABLES]]
    );
    expect(result.rows.map((row) => row.relname)).toEqual([...PROMOTION_TABLES].sort());
  });

  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS runtime role', async () => {
    const flags = await client!.query(
      'SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [role]
    );
    expect(flags.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

  it('shows a tenant its own promotion chain and nothing of the other tenant', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    const expectedRows: Record<(typeof PROMOTION_TABLES)[number], number> = {
      restaurant_promotions: 1,
      // One ACTIVE version plus the DRAFT one the cross-tenant probes use.
      restaurant_promotion_versions: 2,
      restaurant_promotion_targets: 1,
      restaurant_promotion_channels: 1,
      restaurant_promotion_branches: 1,
      restaurant_promotion_caps: 1,
      restaurant_promotion_applications: 1,
      restaurant_promotion_redemptions: 1,
    };
    for (const table of PROMOTION_TABLES) {
      const rows = await client!.query(`SELECT "id" FROM "${table}"`);
      // Both tenants seeded identical shapes; org A must see exactly its own.
      expect({ table, count: rows.rowCount }).toEqual({ table, count: expectedRows[table] });
    }
    const promotion = await client!.query(`SELECT "id" FROM "restaurant_promotions"`);
    expect(promotion.rows[0].id).toBe(id('promotion', 'a'));

    // Naming org B's row explicitly does not reveal it either.
    const targeted = await client!.query(
      `SELECT "id" FROM "restaurant_promotion_applications" WHERE "id" = $1`,
      [id('application', 'b')]
    );
    expect(targeted.rowCount).toBe(0);
  });

  it('refuses a write stamped with another tenant id', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    await expectPgCode('42501', () =>
      client!.query(
        `INSERT INTO "restaurant_promotions" ("id","organizationId","name","updatedAt") VALUES ($1,$2,'Cross',now())`,
        [`cross_promotion_${suffix}`, orgB]
      )
    );
  });

  it('refuses every crafted cross-tenant promotion relation', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    // A version under org A pointing at org B's promotion.
    await expectPgCode('23503', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_versions"
           ("id","organizationId","promotionId","versionNumber","ruleCode","effectiveFrom",
            "benefitKind","benefitRate","updatedAt")
         VALUES ($1,$2,$3,9,'CROSS',TIMESTAMP '2020-01-01','PERCENTAGE_OFF',0.1,now())`,
        [`cross_version_${suffix}`, orgA, id('promotion', 'b')]
      )
    );
    // A target under org A hanging off org B's version.
    await expectPgCode('23503', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_targets" ("id","organizationId","promotionVersionId","productId")
         VALUES ($1,$2,$3,$4)`,
        [`cross_target_${suffix}`, orgA, id('version', 'b'), id('product', 'a')]
      )
    );
    // A branch scope on org A's own DRAFT version naming org B's branch.
    await expectPgCode('23503', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_branches" ("id","organizationId","promotionVersionId","branchId")
         VALUES ($1,$2,$3,$4)`,
        [`cross_scope_${suffix}`, orgA, id('draftversion', 'a'), id('branch', 'b')]
      )
    );
    // An application under org A attributed to org B's version.
    await expectPgCode('23503', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_applications"
           ("id","organizationId","promotionId","promotionVersionId","versionNumber","ruleCode",
            "targetScope","benefitKind","benefitRate",authority,"orderId","branchId","businessDate",
            sequence,"discountAmount")
         VALUES ($1,$2,$3,$4,1,'CROSS','ORDER','PERCENTAGE_OFF',0.1,'AUTOMATIC',$5,$6,DATE '2030-01-01',2,1.00)`,
        [
          `cross_application_${suffix}`,
          orgA,
          id('promotion', 'a'),
          id('version', 'b'),
          id('order', 'a'),
          id('branch', 'a'),
        ]
      )
    );
    // A redemption under org A claiming a slot on org B's version.
    await expectPgCode('23503', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_redemptions"
           ("id","organizationId","promotionVersionId","capScope","capKey",ordinal,"applicationId")
         VALUES ($1,$2,$3,'TOTAL','*',5,$4)`,
        [`cross_redemption_${suffix}`, orgA, id('version', 'b'), id('application', 'a')]
      )
    );
  });

  it('never lets an application or a redemption be rewritten or deleted', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    await expectPgCode('55000', () =>
      client!.query(`UPDATE "restaurant_promotion_applications" SET "discountAmount" = 0.01`)
    );
    await expectPgCode('55000', () =>
      client!.query(`UPDATE "restaurant_promotion_applications" SET "ruleCode" = 'REWRITTEN'`)
    );
    await expectPgCode('55000', () =>
      client!.query(`DELETE FROM "restaurant_promotion_applications"`)
    );
    await expectPgCode('55000', () =>
      client!.query(`UPDATE "restaurant_promotion_redemptions" SET ordinal = 99`)
    );
    await expectPgCode('55000', () =>
      client!.query(`DELETE FROM "restaurant_promotion_redemptions"`)
    );
  });

  it('freezes an ACTIVE version and everything it owns', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    await expectPgCode('55000', () =>
      client!.query(
        `UPDATE "restaurant_promotion_versions" SET "benefitRate" = 0.9 WHERE "id" = $1`,
        [id('version', 'a')]
      )
    );
    await expectPgCode('55000', () =>
      client!.query(`UPDATE "restaurant_promotion_caps" SET "maxRedemptions" = 9999`)
    );
    await expectPgCode('55000', () => client!.query(`DELETE FROM "restaurant_promotion_targets"`));
    await expectPgCode('55000', () =>
      client!.query(
        `INSERT INTO "restaurant_promotion_channels" ("id","organizationId","promotionVersionId",channel)
         VALUES ($1,$2,$3,'DELIVERY')`,
        [`late_channel_${suffix}`, orgA, id('version', 'a')]
      )
    );
  });

  it('still permits the sanctioned ACTIVE -> SUPERSEDED transition, but not a rule edit with it', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    // A supersession that also rewrites the rule is refused.
    await expectPgCode('55000', () =>
      client!.query(
        `UPDATE "restaurant_promotion_versions"
            SET status='SUPERSEDED', "supersededAt"=now(), "benefitRate"=0.9 WHERE "id"=$1`,
        [id('version', 'a')]
      )
    );
    // The clean transition is allowed.
    const result = await client!.query(
      `UPDATE "restaurant_promotion_versions"
          SET status='SUPERSEDED', "supersededAt"=now() WHERE "id"=$1 RETURNING status`,
      [id('version', 'a')]
    );
    expect(result.rows[0].status).toBe('SUPERSEDED');
  });

  it('keeps the superseded rule readable and its application intact — the audit survives', async () => {
    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);

    const version = await client!.query(
      `SELECT status FROM "restaurant_promotion_versions" WHERE "id" = $1`,
      [id('version', 'a')]
    );
    expect(version.rows[0].status).toBe('SUPERSEDED');

    // The application still explains itself entirely from its own columns.
    const application = await client!.query(
      `SELECT "ruleCode","versionNumber","benefitKind","benefitRate",authority,"discountAmount",sequence
         FROM "restaurant_promotion_applications" WHERE "id" = $1`,
      [id('application', 'a')]
    );
    expect(application.rows[0]).toMatchObject({
      ruleCode: 'RULE_A',
      versionNumber: 1,
      benefitKind: 'PERCENTAGE_OFF',
      authority: 'AUTOMATIC',
      sequence: 1,
    });
    expect(Number(application.rows[0].discountAmount)).toBe(10);
  });
});
