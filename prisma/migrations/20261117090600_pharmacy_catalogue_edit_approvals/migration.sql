BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_catalogue_edits" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL,
  "editorId" TEXT NOT NULL,
  "operation" TEXT NOT NULL DEFAULT 'UPDATE_MEDICINE',
  "changes" JSONB NOT NULL CHECK (jsonb_typeof("changes") = 'object'),
  "expectedUpdatedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
  "reviewerId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "soloPinVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "editorId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "reviewerId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT,
  CHECK (("status" = 'PENDING' AND "reviewerId" IS NULL AND "reviewedAt" IS NULL AND "soloPinVerifiedAt" IS NULL)
    OR ("status" <> 'PENDING' AND "reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL)),
  CHECK ("editorId" <> "reviewerId" OR "status" <> 'APPROVED' OR "soloPinVerifiedAt" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "pharmacy_catalogue_edits_organizationId_status_createdAt_idx"
  ON "pharmacy_catalogue_edits" ("organizationId", "status", "createdAt");
ALTER TABLE "pharmacy_catalogue_edits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalogue_edits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_catalogue_edits";
CREATE POLICY tenant_isolation ON "pharmacy_catalogue_edits"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

-- Old assertions have no reliable author evidence; do not invent an author.
ALTER TABLE "pharmacy_medicine_provenance" ADD COLUMN IF NOT EXISTS "editorId" TEXT;

CREATE OR REPLACE FUNCTION public.pharmacy_catalogue_edit_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'catalogue proposals must begin pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalogue proposals are retained' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" = 'PENDING'
    OR (NEW."id",NEW."organizationId",NEW."medicineId",NEW."editorId",NEW."changes",NEW."operation",NEW."expectedUpdatedAt",NEW."createdAt")
      IS DISTINCT FROM (OLD."id",OLD."organizationId",OLD."medicineId",OLD."editorId",OLD."changes",OLD."operation",OLD."expectedUpdatedAt",OLD."createdAt") THEN
    RAISE EXCEPTION 'catalogue proposal is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND NEW."editorId" = NEW."reviewerId"
    AND COALESCE(current_setting('app.pharmacy_catalogue_solo_pin_user_id',true),'') <> NEW."reviewerId" THEN
    RAISE EXCEPTION 'catalogue approval needs another reviewer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_catalogue_edit_transition ON "pharmacy_catalogue_edits";
CREATE TRIGGER pharmacy_catalogue_edit_transition BEFORE INSERT OR UPDATE OR DELETE ON "pharmacy_catalogue_edits"
  FOR EACH ROW EXECUTE FUNCTION public.pharmacy_catalogue_edit_transition();

COMMIT;
