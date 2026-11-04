# Pharmacy procedures (SOPs): rollout to existing tenants

Linear: DEV-751. This runbook does **not** approve a merge or a deploy. Each phase needs its
own approval for each environment.

## What changes, and for whom

Pharmacy procedures run on the shared SOP engine. Each procedure is gated on one of three
generic actions: `sop:manage`, `sop:complete` or `sop:verify`. `pharmacy:*` does not match
them. New pharmacy organizations get the grants from their role templates
(`PHARMACY_SOP_TEMPLATE_GRANTS` in `src/lib/vertical-catalog.ts`). Templates are copied only
when an organization is created, so existing tenants have no SOP grants until phase 3.

| System role key (PHARMACY orgs only)  | Phase 3 adds                               |
| ------------------------------------- | ------------------------------------------ |
| `owner`, `owner-operator`, `manager`  | `sop:manage`, `sop:complete`, `sop:verify` |
| `pharmacist`                          | `sop:complete`, `sop:verify`               |
| `cashier`, `procurement`, `inventory` | `sop:complete`                             |
| `finance`, `auditor`                  | nothing                                    |
| `admin` (bootstrap administrator)     | nothing: it already reaches `sop:*`        |

Saad approved these grants (delegated on DEV-751). They cover SOP access only. Owners and
administrators are treated alike for SOPs and for nothing else.

- The bootstrap `admin` role is created with a single `*` ALLOW
  (`src/lib/platform/commands.ts`, the `adminRole` create). `*` matches every `sop:*` action:
  only `pharmacy:dispense`, `pharmacy:prescriptions`, `pharmacy:safety` and
  `pharmacy:catalogue-review` are exact-grant-only (`src/lib/abac/capabilities.ts`). Phase 3
  therefore writes no rows for `admin`.
- Tenant `UserRole.ADMIN` on its own does **not** grant SOP access. `sop:*` have no static
  policy (`src/lib/abac/policies.ts`), so access comes only from the user's organization role
  or a user override. Dry-run check D4 lists any such users.
- Cashiers, procurement and inventory staff only complete procedures assigned to them or to
  a pool role they hold. The router enforces this, not the grant.
- Phase 3 touches system roles only (`isSystem = true`, exact keys above) in organizations
  whose vertical is `PHARMACY`. Tenant-authored roles, other verticals, user overrides and
  every non-`sop:*` capability are untouched. The script refuses to run if its grant map
  contains anything outside `sop:*`, or the keys `admin`, `finance` or `auditor`.
- **An explicit DENY still wins.** If a role already has a row for a capability, ALLOW or
  DENY, phase 3 leaves it as it is (`ON CONFLICT DO NOTHING` on the unique index on
  `(organizationRoleId, capability)`). A user-level DENY override also beats a role ALLOW:
  `customDecision` in `src/lib/abac/index.ts` merges overrides and role rules, and any
  matching DENY returns false before any ALLOW is considered.
- No role gains or loses `pharmacy:close` or any other operation capability. The day-close
  policy (DEV-739, #1413) is on hold and is independent of this rollout. Nothing here
  depends on who holds `pharmacy:close`.

Defaults that stay in place after every phase:

- **Automatic scheduling is OFF for every branch** until a manager turns it on for that
  branch (`src/lib/pharmacy/sop-settings.ts`; no settings row means OFF). Until then, work is
  created only when a manager asks for it, and no background job exists for the
  organization. See "Automatic scheduling: the background job worker" below.
- **No default escalation.** Nothing notifies or escalates to anyone unless a manager sets
  it up.
- Procedures never block, gate or change opening, closing, the counter, Goods-in or any
  other pharmacy workflow.

## Where the SQL lives, and why it is not a migration

- `docs/operations/pharmacy-sop-rollout/up.sql`: phase 3 (grant)
- `docs/operations/pharmacy-sop-rollout/down.sql`: phase 5 (rollback)

Nothing picks these files up automatically:

- `prisma migrate deploy` reads only `prisma/migrations` (`prisma.config.ts`).
- The fresh-database tooling pins exactly the directories listed in
  `prisma/fresh-database-manifest.json` (`prisma/fresh-database.ts`).
- The runner image copies `prisma/` but not `docs/` (`Dockerfile`).

DEV-739 follows the same convention: its phase-2 SQL lives in
`docs/operations/pharmacy-day-close-rollout.md`, not in `prisma/migrations`.

Both scripts:

- run inside an explicit `BEGIN … COMMIT`;
- call `set_config('app.is_platform_admin','true',true)` inside that transaction;
- refuse to run when the flag is not visible. Without the flag, forced RLS matches no rows
  and the script would report success having done nothing (#975).

Both are idempotent and print a `NOTICE` with their counts.

Run them as the migration owner (`MIGRATION_DATABASE_URL`), never as the runtime role.

Inserted rows use the deterministic id `'dev751_sop_' || md5(organizationRoleId || ':' || capability)`.
`down.sql` deletes a row only if all of the following hold:

- its id equals that expression for its own role and capability;
- its effect is still `ALLOW`;
- its capability is one of the three `sop:*` actions;
- its role belongs to a `PHARMACY` organization.

A grant that existed before phase 3 has a different id, so rollback keeps it. System roles
cannot be edited from the tenant role editor (`organization-admin.ts`: "System roles cannot
be modified."), so these rows change only through scripts like these.

Tests: `tests/pharmacy-sop-role-grants.db.test.ts` checks the approved grants, the protection
for custom roles and other verticals, DENY preservation, idempotency, the non-SOP guard,
the forced-RLS behaviour, `can()` results and rollback. Run it with
`PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL` and `PHARMACY_SOP_TEST_OWNER_DATABASE_URL` set
against a disposable database.

## Phase 0: deploy the code with its guards (no tenant data change)

Ship the DEV-751 code and its Prisma migrations through the normal pipeline: migration job
first, then the web revision. The migrations create the SOP site, record-link,
capture-receipt and branch-setting tables. They grant nothing. After phase 0:

- existing pharmacy tenants still have no SOP grants;
- only the bootstrap `admin` role (`*`) and new organizations (from templates) can open
  `/pharmacy/sop`.

**Before any `AUTH_SECRET` rotation**, run the legacy capture-receipt backfill
(`scripts/pharmacy-sop-legacy-capture-backfill.ts`) in every environment that has SOP
captures. Receipts written before the backfill are verified with the current secret. If you
rotate first, they can no longer be verified. Follow that script's own header for
invocation and dry-run. Do not rotate `AUTH_SECRET` between phase 0 and that backfill.

## Phase 1: confirm the guards are serving

Do this on every replica after the new revision serves. No data changes.

1. **`sop:*` gates.** A user whose only role is the system `cashier` or `pharmacist` role is
   refused by every `pharmacySop` procedure (FORBIDDEN) and sees no procedures entry. A user
   with the bootstrap `admin` role can open `/pharmacy/sop`.
2. **Branch scope.** A permitted user sees and acts only on branches where they have an
   active `pharmacy_branch_assignments` row. Requests for another branch's site, occurrence
   or evidence are refused.
3. **Module gate.** In an organization without the `pharmacy-safety` module licensed,
   `/pharmacy/sop` and every `pharmacySop.*` procedure are refused, even for `admin`.
4. Automatic scheduling reads OFF for every branch, and no `pharmacy.sop.autoGenerate` or
   `pharmacy.sop.autoGenerateBranch` job exists (checks 1 and 3 in "Automatic scheduling"
   below return no rows).

Stop if any check fails. Phase 3 must not run before phase 1 passes, because the grants
would then reach code that does not enforce branch scope.

## Phase 2: dry run (read-only counts)

Run this against the target environment and paste the output into the approval request.

```sql
BEGIN READ ONLY;
SELECT set_config('app.is_platform_admin', 'true', true);

-- D1. Per role key: system roles in scope, and the rows phase 3 would insert
--     (a missing (role, capability) row is the only thing it ever writes).
WITH grant_map(role_key, capability) AS (
  VALUES ('owner','sop:manage'),('owner','sop:complete'),('owner','sop:verify'),
         ('owner-operator','sop:manage'),('owner-operator','sop:complete'),
         ('owner-operator','sop:verify'),
         ('manager','sop:manage'),('manager','sop:complete'),('manager','sop:verify'),
         ('pharmacist','sop:complete'),('pharmacist','sop:verify'),
         ('cashier','sop:complete'),('procurement','sop:complete'),('inventory','sop:complete')
)
SELECT g.role_key,
       count(DISTINCT r.id)                                         AS system_roles,
       count(*) FILTER (WHERE r.id IS NOT NULL AND p.id IS NULL)    AS would_insert,
       count(p.id) FILTER (WHERE p.effect = 'ALLOW')                AS existing_allow,
       count(p.id) FILTER (WHERE p.effect = 'DENY')                 AS existing_deny_kept
FROM grant_map g
LEFT JOIN (organization_roles r JOIN organizations o
             ON o.id = r."organizationId" AND o.vertical = 'PHARMACY')
  ON r.key = g.role_key AND r."isSystem" = true
LEFT JOIN organization_role_permissions p
  ON p."organizationRoleId" = r.id AND p.capability = g.capability
GROUP BY g.role_key ORDER BY g.role_key;

-- D2. Baseline to compare after phase 3: every SOP DENY row, and all pharmacy:close rows.
SELECT capability, effect, count(*) FROM organization_role_permissions
WHERE capability IN ('sop:manage','sop:complete','sop:verify','sop:*','*','pharmacy:close')
GROUP BY 1, 2 ORDER BY 1, 2;

-- D3. Pharmacy bootstrap admin roles that would NOT reach sop:* through '*'
--     (expect 0; any row is a tenant decision to review, phase 3 does not change it).
SELECT o.id, o."displayName", r.id AS role_id
FROM organization_roles r JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r.key = 'admin' AND r."isSystem"
  AND NOT EXISTS (SELECT 1 FROM organization_role_permissions p
                  WHERE p."organizationRoleId" = r.id AND p.capability = '*' AND p.effect = 'ALLOW');

-- D4. Tenant ADMIN users in pharmacies with no organization role: no SOP access before or
--     after phase 3 (sop:* has no UserRole.ADMIN policy). Assign them a role if they need it.
SELECT u."organizationId", count(*) FROM users u
JOIN organizations o ON o.id = u."organizationId"
WHERE o.vertical = 'PHARMACY' AND u.role = 'ADMIN' AND u."organizationRoleId" IS NULL
  AND u.status IN ('ACTIVE','ON_LEAVE')
GROUP BY 1;

-- D5. Already applied? Rows owned by this rollout (expect 0 before the first apply).
SELECT count(*) FROM organization_role_permissions p
WHERE p.id = 'dev751_sop_' || md5(p."organizationRoleId" || ':' || p.capability);

ROLLBACK;
```

## Phase 3: apply (per environment, with approval)

1. Get written approval for this environment, citing the phase 2 output.
2. Take a backup or snapshot point you can restore to.
3. Run the script:

   ```sh
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f docs/operations/pharmacy-sop-rollout/up.sql
   ```

4. Check the `NOTICE`: `inserted` must equal the sum of D1 `would_insert`, and
   `kept_existing_deny` must equal the sum of D1 `existing_deny_kept`. The final table lists
   `dev751_rows` per role key.
5. A re-run must print `inserted=0`.

Apply to staging first. Apply to production only after phase 4 passes on staging.

## Phase 4: verify

```sql
BEGIN READ ONLY;
SELECT set_config('app.is_platform_admin', 'true', true);

-- V1. Rows owned by this rollout that are not ALLOW sop:* on an in-scope system role
--     in a PHARMACY organization. Expect 0.
SELECT count(*) FROM organization_role_permissions p
JOIN organization_roles r ON r.id = p."organizationRoleId"
JOIN organizations o ON o.id = r."organizationId"
WHERE p.id = 'dev751_sop_' || md5(p."organizationRoleId" || ':' || p.capability)
  AND NOT (p.effect = 'ALLOW'
       AND p.capability IN ('sop:manage','sop:complete','sop:verify')
       AND p."organizationId" = r."organizationId"
       AND o.vertical = 'PHARMACY' AND r."isSystem"
       AND r.key IN ('owner','owner-operator','manager','pharmacist','cashier',
                     'procurement','inventory'));

-- V2. In-scope system roles still missing an approved SOP row (no row at all; a DENY
--     counts as present). Expect 0.
WITH grant_map(role_key, capability) AS (
  VALUES ('owner','sop:manage'),('owner','sop:complete'),('owner','sop:verify'),
         ('owner-operator','sop:manage'),('owner-operator','sop:complete'),
         ('owner-operator','sop:verify'),
         ('manager','sop:manage'),('manager','sop:complete'),('manager','sop:verify'),
         ('pharmacist','sop:complete'),('pharmacist','sop:verify'),
         ('cashier','sop:complete'),('procurement','sop:complete'),('inventory','sop:complete')
)
SELECT count(*) FROM grant_map g
JOIN organization_roles r ON r.key = g.role_key AND r."isSystem"
JOIN organizations o ON o.id = r."organizationId" AND o.vertical = 'PHARMACY'
WHERE NOT EXISTS (SELECT 1 FROM organization_role_permissions p
                  WHERE p."organizationRoleId" = r.id AND p.capability = g.capability);

-- V3. finance / auditor / custom roles / other verticals received nothing. Expect 0.
SELECT count(*) FROM organization_role_permissions p
JOIN organization_roles r ON r.id = p."organizationRoleId"
JOIN organizations o ON o.id = r."organizationId"
WHERE p.id = 'dev751_sop_' || md5(p."organizationRoleId" || ':' || p.capability)
  AND (r.key IN ('admin','finance','auditor') OR NOT r."isSystem" OR o.vertical <> 'PHARMACY');

-- V4. Re-run D2: every DENY count and every pharmacy:close count is unchanged; only
--     sop:* ALLOW counts went up.
ROLLBACK;
```

In the application, check that:

- a system Manager can open the procedures setup;
- a Cashier can open and complete only the work assigned to them or to their pool role, on
  their assigned branches;
- a Finance or Auditor user still sees no procedures entry;
- a user with a `sop:*` DENY override is still refused.

## Phase 5: rollback

```sh
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/operations/pharmacy-sop-rollout/down.sql
```

The script prints `removed=<n>`. That number equals the rows phase 3 inserted, unless a row
was since changed to DENY: such rows are kept on purpose. Grants that existed before
phase 3, all DENY rows, and all non-SOP capabilities stay as they are. D5 must then read 0.

After rollback:

- Holders of the affected system roles lose the SOP screens and actions on their next
  request.
- SOP history, evidence and in-flight occurrences are not deleted. They wait until access is
  restored.
- The bootstrap `admin` role and organizations created after phase 0 (template grants) keep
  access. Rolling those back is a code change, not this script.
- To withdraw SOP access from the whole product, turn off the `pharmacy-safety` module for
  the organization. That is a separate decision.

## Automatic scheduling: the background job worker

Turning automatic scheduling on for a branch does two things. It creates that branch's due
procedures straight away, and it queues one `pharmacy.sop.autoGenerate` job for the
organization on the existing restaurant job queue (`restaurant_jobs`), due at the start of
the next hour. Both happen in the same request transaction as the setting, so either all
three are saved or none is. The jobs only create procedures: they escalate nothing, sweep
nothing and never touch a pharmacy operation table (`src/lib/pharmacy/sop-auto-schedule-job.ts`).

Each hour runs as a parent job and one child job per branch:

- **Parent, `pharmacy.sop.autoGenerate`** (one per organization per hour). Reads which
  branches are on. When none is, it queues nothing and the hourly job stops. Otherwise it
  queues the next hour's parent and one child per branch that is on, and finishes. It
  creates no procedures itself, so it takes a moment and rarely fails.
- **Child, `pharmacy.sop.autoGenerateBranch`** (one per branch per hour; payload
  `{ slot, pharmacyBranchId }`, key `pharmacy.sop.autoGenerateBranch:<pharmacyBranchId>:<slot>`).
  Reads the branch again and, if it is still on, creates its due procedures from its
  schedules, in its timezone. A branch turned off since the parent ran is skipped.

How it uses the database: the worker runs each job inside one transaction in that
organization's tenant context, on one pooled connection, and both job types do all their
work in that transaction. Neither opens a second connection while the transaction is open.

What happens when something fails:

- **A failing branch fails alone.** The child for that branch is retried by the scheduler
  (30 s, 1 min, 2 min, 4 min) and, after 5 attempts, is left `DEAD` with its last error.
  Other branches have their own children and are not affected.
- **The hourly job keeps going.** The next hour's parent was already saved by the parent
  that queued the failing child. Next hour, a new child for the same branch runs. Once the
  cause is fixed, the branch catches up on that run without duplicates, because procedures
  are created idempotently.
- **A failing parent** retries the same way. It fails only if the queue writes themselves
  fail. If it ends `DEAD`, the hourly job for that organization has stopped. Fix the cause,
  then turn any branch off and on again in Setup to restart it.

- **The worker must be running.** The hourly runs happen only where the job worker
  (`bun run restaurant:jobs`, `scripts/run-restaurant-jobs.ts`) runs against the
  environment's database. Without it, turning a branch on still creates that branch's work
  once, but nothing more is created automatically. This change adds no deployment config:
  where the worker does not already run, someone must decide to run it.
- **Nothing exists until a branch opts in.** No settings row and no job are created by this
  rollout or by deploy.

Verify (read-only, as a platform reader):

```sql
-- 1. Queued or running hourly parents: one row per organization with a branch on.
SELECT "organizationId", "status", "scheduledAt", "idempotencyKey"
  FROM restaurant_jobs
 WHERE "type" = 'pharmacy.sop.autoGenerate' AND "status" IN ('QUEUED', 'RUNNING');

-- 2. Branches whose procedures could not be created (one row per failed branch and hour).
SELECT "organizationId", "payload"->>'pharmacyBranchId' AS "pharmacyBranchId",
       "payload"->>'slot' AS "slot", "attempts", "lastError", "updatedAt"
  FROM restaurant_jobs
 WHERE "type" = 'pharmacy.sop.autoGenerateBranch' AND "status" = 'DEAD'
 ORDER BY "updatedAt" DESC
 LIMIT 50;

-- 3. Recent runs of both job types and their outcome (SUCCEEDED expected).
SELECT j."organizationId", j."type", j."payload", j."status", e."attempt", e."outcome",
       e."error", e."finishedAt"
  FROM restaurant_jobs j
  LEFT JOIN restaurant_job_executions e ON e."jobId" = j."id"
 WHERE j."type" IN ('pharmacy.sop.autoGenerate', 'pharmacy.sop.autoGenerateBranch')
 ORDER BY j."scheduledAt" DESC, e."attempt"
 LIMIT 50;
```

In the application, the branch's procedures board lists the work created from its
schedules, due at the times set in Setup.

Stop: turn automatic scheduling off for the branch in Setup. The setting is appended at
once. The parent already queued for the next hour still runs, finds the branch off, queues
no child for it, and (if no other branch in the organization is on) queues nothing more. A
child already queued for that branch finds it off and creates nothing. Procedures already
created stay as they are.

Limits:

- A `DEAD` child is not retried again. The branch is covered by the next hour's child, and
  each run creates the current business day and the next, so one lost hour is normally
  invisible. A branch whose child fails every hour shows one `DEAD` row per hour (check 2)
  until the cause is fixed. Nothing alerts on it.
- Each child must finish within the worker's 30 s transaction limit. One branch with a very
  large number of schedules could exceed it, and its child would then fail every hour.
- Turning a branch on while its child is running can make one of them fail once on a
  duplicate procedure. A child is retried 30 s later and finds nothing left to create; a
  refused request is retried by the manager.
- Turning a branch on creates its procedures inside the request. If that fails, the whole
  change is refused and the setting stays off.

## Not covered here

- Who may close the day (DEV-739, #1413): on hold and independent.
- Whether tenant `UserRole.ADMIN` users without an organization role (D4) should get SOP
  access without a role: needs a separate product decision and code change.
