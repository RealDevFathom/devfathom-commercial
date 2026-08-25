-- WHA-179: tenant-safe relations, concurrent publication, and full reversals.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP TRIGGER "tax_profile_overlap" ON "restaurant_tax_profile_versions";
DROP FUNCTION "guard_tax_profile_overlap"();

CREATE UNIQUE INDEX "restaurant_branches_org_id_key"
  ON "restaurant_branches"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_tax_sources_org_id_key"
  ON "restaurant_tax_official_sources"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_tax_profiles_org_id_key"
  ON "restaurant_tax_profile_versions"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_tax_rules_org_id_key"
  ON "restaurant_tax_rule_versions"("organizationId", "id");
CREATE UNIQUE INDEX "restaurant_tax_snapshots_org_id_key"
  ON "restaurant_tax_transaction_snapshots"("organizationId", "id");

ALTER TABLE "restaurant_tax_profile_versions"
  DROP CONSTRAINT "restaurant_tax_profile_branch_fkey",
  ADD CONSTRAINT "restaurant_tax_profile_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE CASCADE;

ALTER TABLE "restaurant_tax_rule_versions"
  DROP CONSTRAINT "restaurant_tax_rule_profile_fkey",
  DROP CONSTRAINT "restaurant_tax_rule_source_fkey",
  ADD CONSTRAINT "restaurant_tax_rule_profile_fkey"
    FOREIGN KEY ("organizationId", "profileVersionId")
    REFERENCES "restaurant_tax_profile_versions"("organizationId", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "restaurant_tax_rule_source_fkey"
    FOREIGN KEY ("organizationId", "officialSourceId")
    REFERENCES "restaurant_tax_official_sources"("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "restaurant_tax_transaction_snapshots"
  DROP CONSTRAINT "tax_snapshot_branch_fkey",
  DROP CONSTRAINT "tax_snapshot_profile_fkey",
  DROP CONSTRAINT "tax_snapshot_reversal_fkey",
  ADD CONSTRAINT "tax_snapshot_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tax_snapshot_profile_fkey"
    FOREIGN KEY ("organizationId", "profileVersionId")
    REFERENCES "restaurant_tax_profile_versions"("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tax_snapshot_reversal_fkey"
    FOREIGN KEY ("organizationId", "reversesSnapshotId")
    REFERENCES "restaurant_tax_transaction_snapshots"("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  DROP CONSTRAINT "tax_bucket_snapshot_fkey",
  DROP CONSTRAINT "tax_bucket_rule_fkey",
  ADD CONSTRAINT "tax_bucket_snapshot_fkey"
    FOREIGN KEY ("organizationId", "snapshotId")
    REFERENCES "restaurant_tax_transaction_snapshots"("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tax_bucket_rule_fkey"
    FOREIGN KEY ("organizationId", "ruleVersionId")
    REFERENCES "restaurant_tax_rule_versions"("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "restaurant_tax_profile_versions"
  ADD CONSTRAINT "restaurant_tax_profile_published_no_overlap"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "branchId" WITH =,
    tsrange("effectiveFrom", "effectiveTo", '[)') WITH &&
  ) WHERE ("status" = 'PUBLISHED');

CREATE UNIQUE INDEX "restaurant_tax_snapshot_single_reversal_key"
  ON "restaurant_tax_transaction_snapshots"("reversesSnapshotId")
  WHERE "reversesSnapshotId" IS NOT NULL;

CREATE FUNCTION "guard_tax_full_reversal"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original "restaurant_tax_transaction_snapshots"%ROWTYPE;
BEGIN
  IF NEW."reversesSnapshotId" IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO original
  FROM "restaurant_tax_transaction_snapshots"
  WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."reversesSnapshotId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal target must belong to the same organization' USING ERRCODE = '23503';
  END IF;
  IF original."reversesSnapshotId" IS NOT NULL
    OR NEW."branchId" <> original."branchId"
    OR NEW."profileVersionId" <> original."profileVersionId"
    OR NEW."currency" <> original."currency"
    OR NEW."subtotal" <> -original."subtotal"
    OR NEW."discountTotal" <> -original."discountTotal"
    OR NEW."serviceChargeTotal" <> -original."serviceChargeTotal"
    OR NEW."taxTotal" <> -original."taxTotal"
    OR NEW."grandTotal" <> -original."grandTotal"
  THEN
    RAISE EXCEPTION 'reversal must be one exact full accounting inverse' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "tax_snapshot_full_reversal"
  BEFORE INSERT ON "restaurant_tax_transaction_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "guard_tax_full_reversal"();
