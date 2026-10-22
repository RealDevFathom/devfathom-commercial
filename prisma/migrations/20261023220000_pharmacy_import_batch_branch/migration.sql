-- Import batches are operated on inside one pharmacy branch, as well as one tenant.
ALTER TABLE "pharmacy_migration_batches" ADD COLUMN "branchId" TEXT;

-- Legacy profiling batches predate branch selection. Preserve them by assigning
-- the tenant's oldest active branch; fail deployment rather than leave an
-- unscoped batch when a tenant has no valid branch.
UPDATE "pharmacy_migration_batches" batch
SET "branchId" = (
  SELECT candidate.id
  FROM "pharmacy_branches" candidate
  WHERE candidate."organizationId" = batch."organizationId" AND candidate.active = true
  ORDER BY candidate."createdAt", candidate.id
  LIMIT 1
);

ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "pharmacy_migration_batches"
  ADD CONSTRAINT "pharmacy_migration_batches_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "pharmacy_migration_batches_org_branch_status_idx"
  ON "pharmacy_migration_batches"("organizationId", "branchId", "status");
