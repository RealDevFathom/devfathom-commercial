-- G9 adds a review gate to the existing RX-07 capture and mock scheduler.
-- Do not rewrite capture evidence or introduce another outbox/send claim.
CREATE UNIQUE INDEX "pharmacy_refill_capture_org_branch_id_key"
  ON "pharmacy_refill_reminder_captures" ("organizationId", "branchId", "id");

CREATE TABLE "pharmacy_refill_reminder_reviews" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "captureId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  PRIMARY KEY ("organizationId", "captureId"),
  CONSTRAINT "pharmacy_refill_review_org_branch_capture_key" UNIQUE ("organizationId", "branchId", "captureId"),
  CONSTRAINT "pharmacy_refill_review_capture_fkey"
    FOREIGN KEY ("organizationId", "branchId", "captureId")
    REFERENCES "pharmacy_refill_reminder_captures" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_review_actor_fkey"
    FOREIGN KEY ("organizationId", "decidedByUserId")
    REFERENCES "users" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_review_decision_check" CHECK (
    ("status" = 'DRAFT' AND "decidedByUserId" IS NULL AND "decidedAt" IS NULL) OR
    ("status" IN ('APPROVED', 'SKIPPED') AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL)
  )
);
CREATE INDEX "pharmacy_refill_review_branch_status_idx"
  ON "pharmacy_refill_reminder_reviews" ("organizationId", "branchId", "status");

CREATE FUNCTION pharmacy_refill_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refill review cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decidedByUserId', 'decidedAt'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'decidedByUserId', 'decidedAt']) OR
     OLD."status" <> 'DRAFT' OR NEW."status" NOT IN ('APPROVED', 'SKIPPED') THEN
    RAISE EXCEPTION 'invalid refill review transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_refill_review_transition
  BEFORE UPDATE OR DELETE ON "pharmacy_refill_reminder_reviews"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refill_review_guard();

ALTER TABLE "pharmacy_refill_reminder_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_refill_reminder_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_refill_reminder_reviews"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  );
