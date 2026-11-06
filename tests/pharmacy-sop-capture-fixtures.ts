import type { Client } from 'pg';

/**
 * DEV-751 — shared PostgreSQL fixtures for the capture-receipt suites
 * (`pharmacy-sop-captures.db.test.ts`, `pharmacy-sop-legacy-capture-backfill.test.ts`).
 * Every caller runs inside its own transaction and rolls it back, so the
 * append-only rows seeded here never outlive a suite.
 */

export function runtimeUrl() {
  return (
    process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL ??
    process.env.WHA1316_RUNTIME_DATABASE_URL ??
    process.env.TEST_DATABASE_URL
  );
}

export function ownerUrl() {
  return process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL ?? process.env.WHA1316_OWNER_DATABASE_URL;
}

/** Set the tenant scope GUCs for the current transaction; `null` is the platform escape. */
export async function scopeAs(
  client: Client,
  organizationId: string | null,
  branchId: string | null = null
) {
  await client.query(
    `SELECT set_config('app.is_platform_admin', $1, true),
            set_config('app.current_organization_id', $2, true),
            set_config('app.current_branch_id', $3, true)`,
    [organizationId === null ? 'true' : 'false', organizationId ?? '', branchId ?? '']
  );
}

/** Run one statement expected to fail, without aborting the outer transaction. */
export async function refused(client: Client, sql: string, params: unknown[] = []) {
  await client.query('SAVEPOINT attempt');
  try {
    await client.query(sql, params);
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? 'ERROR';
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
  }
}

/**
 * One tenant: pharmacy branches `<org>_pb` (bound to engine branch `<org>_rb`
 * through a pharmacy SOP site) and `<org>_pb2` (no site); engine branches
 * `<org>_rb` and `<org>_rb_unbound`, each with one occurrence (`<org>_occ`,
 * `<org>_occ_unbound`) and one step; staff profiles `<org>_sp` and `<org>_sp2`.
 * Call under the platform escape (`scopeAs(client, null)`).
 */
export async function seedSopTenant(client: Client, org: string) {
  const q = (sql: string, params: unknown[]) => client.query(sql, params);
  await q(
    `INSERT INTO "organizations" ("id","slug","legalName","displayName","updatedAt")
     VALUES ($1,$1,$1,$1,now())`,
    [org]
  );
  await q(
    `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","updatedAt")
     VALUES ($1,$2,'PB1','Main','1 Road','Lahore','PB',now()), ($3,$2,'PB2','Second','2 Road','Lahore','PB',now())`,
    [`${org}_pb`, org, `${org}_pb2`]
  );
  await q(
    `INSERT INTO "restaurant_branches" ("id","organizationId","name","timezone","updatedAt")
     VALUES ($1,$2,'Main · SOP','Asia/Karachi',now()), ($3,$2,'Unbound','Asia/Karachi',now())`,
    [`${org}_rb`, org, `${org}_rb_unbound`]
  );
  await q(
    `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","updatedAt")
     VALUES ($1,$2,'Staff',now()), ($3,$2,'Other staff',now())`,
    [`${org}_sp`, org, `${org}_sp2`]
  );
  await q(
    `INSERT INTO "restaurant_sop_templates" ("id","organizationId","name","updatedAt")
     VALUES ($1,$2,'Pharmacy — opening',now())`,
    [`${org}_tpl`, org]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_versions" ("id","organizationId","templateId","versionNumber","status","updatedAt")
     VALUES ($1,$2,$3,1,'PUBLISHED',now())`,
    [`${org}_ver`, org, `${org}_tpl`]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_steps" ("id","organizationId","templateVersionId","stepOrder","title","updatedAt")
     VALUES ($1,$2,$3,1,'Record temperature',now())`,
    [`${org}_tstep`, org, `${org}_ver`]
  );
  for (const [suffix, branch] of [
    ['', `${org}_rb`],
    ['_unbound', `${org}_rb_unbound`],
  ] as const) {
    await q(
      `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","startDate","assigneeTargetType","assigneeStaffProfileId","updatedAt")
       VALUES ($1,$2,$3,$4,'2026-11-01','PERSON',$5,now())`,
      [`${org}_asg${suffix}`, org, branch, `${org}_tpl`, `${org}_sp`]
    );
    await q(
      `INSERT INTO "restaurant_sop_occurrences" ("id","organizationId","assignmentId","templateVersionId","branchId","businessDate","dueAt","windowEndsAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'2026-11-02','2026-11-02 03:00','2026-11-02 05:00',now())`,
      [`${org}_occ${suffix}`, org, `${org}_asg${suffix}`, `${org}_ver`, branch]
    );
    await q(
      `INSERT INTO "restaurant_sop_occurrence_steps" ("id","organizationId","occurrenceId","templateStepId","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [`${org}_ostep${suffix}`, org, `${org}_occ${suffix}`, `${org}_tstep`]
    );
  }
  await q(
    `INSERT INTO "pharmacy_sop_sites" ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
     VALUES ($1,$2,$3,$4,'user_seed')`,
    [`${org}_site`, org, `${org}_pb`, `${org}_rb`]
  );
}

export type SeedEvidence = {
  id: string;
  organizationId: string;
  occurrenceId: string;
  occurrenceStepId: string | null;
  contentHash: string;
  mimeType: string;
  uploaderStaffProfileId: string | null;
  storageRef: string | null;
};

/** Insert one engine evidence row exactly as given. */
export async function insertEvidence(client: Client, row: SeedEvidence) {
  await client.query(
    `INSERT INTO "restaurant_sop_evidence" ("id","organizationId","occurrenceId","occurrenceStepId","contentHash","mimeType","sizeBytes","storageRef","uploaderStaffProfileId")
     VALUES ($1,$2,$3,$4,$5,$6,5,$7,$8)`,
    [
      row.id,
      row.organizationId,
      row.occurrenceId,
      row.occurrenceStepId,
      row.contentHash,
      row.mimeType,
      row.storageRef,
      row.uploaderStaffProfileId,
    ]
  );
}
