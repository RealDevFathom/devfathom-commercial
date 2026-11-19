BEGIN;

-- DEV-962: a refill reminder is recorded only at the branch that dispensed the fill. A fill
-- had no branch, so nothing tied it to that branch and any branch could take its one reminder
-- slot. Each fill now records the branch it was dispensed at. The column stays nullable: a
-- fill whose branch cannot be proven is left without one, and only an organisation admin may
-- record its reminder. Reminders already recorded are not changed.
ALTER TABLE "pharmacy_prescription_fills" ADD COLUMN IF NOT EXISTS "branchId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pharmacy_prescription_fills_organizationId_branchId_fkey'
       AND conrelid = 'pharmacy_prescription_fills'::regclass
  ) THEN
    ALTER TABLE "pharmacy_prescription_fills"
      ADD CONSTRAINT "pharmacy_prescription_fills_organizationId_branchId_fkey"
      FOREIGN KEY ("organizationId", "branchId")
      REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "pharmacy_prescription_fills_organizationId_branchId_idx"
  ON "pharmacy_prescription_fills"("organizationId", "branchId");

-- Backfill only what is provable, one organization at a time with the tenant set (DEV-951):
--   * a counter fill names its sale line in its idempotency key (`controlled:<line>` from the
--     witnessed controlled flow, `rx-reference:<line>` from sale completion); the line's
--     branch is the dispensing branch;
--   * an organization that has only ever had one branch dispensed every fill there.
-- Anything else (a hand-recorded fill in a multi-branch organization) stays NULL. Fills are
-- append-only, so the guard trigger is set aside for this backfill only and restored before
-- the transaction ends. Only NULL branches are written, so re-running changes nothing.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "pharmacy_prescription_fills" DISABLE TRIGGER "pharmacy_prescription_fill_append_only";

DO $$
DECLARE
  tenant_id TEXT;
  only_branch TEXT;
BEGIN
  FOR tenant_id IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);

    UPDATE "pharmacy_prescription_fills" AS fill
       SET "branchId" = line."branchId"
      FROM "pharmacy_sale_lines" AS line
     WHERE fill."organizationId" = tenant_id
       AND fill."branchId" IS NULL
       AND line."organizationId" = tenant_id
       AND (
         fill."idempotencyKey" = 'controlled:' || line."id" OR
         fill."idempotencyKey" = 'rx-reference:' || line."id"
       );

    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(branch."id") END
      INTO only_branch
      FROM "pharmacy_branches" AS branch
     WHERE branch."organizationId" = tenant_id;
    IF only_branch IS NOT NULL THEN
      UPDATE "pharmacy_prescription_fills"
         SET "branchId" = only_branch
       WHERE "organizationId" = tenant_id AND "branchId" IS NULL;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

ALTER TABLE "pharmacy_prescription_fills" ENABLE TRIGGER "pharmacy_prescription_fill_append_only";

COMMIT;
