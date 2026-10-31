-- #743 review fixes: scheduler deferral evidence, single-use Rx cycle approvals and
-- branch-scoped isolation matching the sibling pharmacy tables.
SET lock_timeout = '5s';

-- A failing automatic cycle is deferred instead of being retried at the head of every run.
ALTER TABLE "pharmacy_chronic_refill_subscriptions"
  ADD COLUMN "schedulerRetryAt" TIMESTAMP(3),
  ADD COLUMN "schedulerFailure" TEXT;

ALTER TABLE "pharmacy_chronic_refill_events"
  DROP CONSTRAINT IF EXISTS "pharmacy_chronic_refill_events_kind_check";
ALTER TABLE "pharmacy_chronic_refill_events"
  ADD CONSTRAINT "pharmacy_chronic_refill_events_kind_check"
  CHECK ("kind" IN ('EDIT', 'PAUSE', 'REACTIVATE', 'CANCEL', 'SCHEDULER_FAILED'));

-- A pharmacist signature consumed by a chronic refill cycle authorises that cycle's dispense
-- only. The reviewed sale it was recorded on can never also complete, so one signature can
-- never yield two dispenses. Cycles are append-only, so the claim is permanent.
CREATE FUNCTION pharmacy_reject_claimed_chronic_review_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'COMPLETED' AND OLD."status" IS DISTINCT FROM 'COMPLETED' AND EXISTS (
    SELECT 1
    FROM "pharmacy_sale_lines" line
    JOIN "pharmacy_pharmacist_review_items" item
      ON item."organizationId" = line."organizationId" AND item."saleLineId" = line."id"
    JOIN "pharmacy_pharmacist_review_decisions" decision
      ON decision."organizationId" = item."organizationId" AND decision."reviewItemId" = item."id"
    JOIN "pharmacy_chronic_refill_cycles" cycle
      ON cycle."organizationId" = decision."organizationId"
     AND cycle."pharmacistDecisionId" = decision."id"
    WHERE line."organizationId" = NEW."organizationId"
      AND line."branchId" = NEW."branchId"
      AND line."saleId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'pharmacist approval on this sale was consumed by a chronic refill cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_sale_chronic_review_claim_guard
  BEFORE UPDATE OF "status" ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_claimed_chronic_review_sale();

-- Branch-scoped isolation: when a branch is active in the session, rows of other branches are
-- invisible and unwritable, as for the other branch-owned pharmacy tables.
DROP POLICY tenant_isolation ON "pharmacy_chronic_refill_subscriptions";
CREATE POLICY tenant_isolation ON "pharmacy_chronic_refill_subscriptions"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)));
DROP POLICY tenant_isolation ON "pharmacy_chronic_refill_cycles";
CREATE POLICY tenant_isolation ON "pharmacy_chronic_refill_cycles"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)));
DROP POLICY tenant_isolation ON "pharmacy_chronic_refill_events";
CREATE POLICY tenant_isolation ON "pharmacy_chronic_refill_events"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
     "branchId" = current_setting('app.current_branch_id', true)));
