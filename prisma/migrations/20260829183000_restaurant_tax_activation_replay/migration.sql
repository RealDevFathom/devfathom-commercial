-- WHA-566: durable tax activation replay identity and immutable eligibility evidence.
ALTER TABLE "restaurant_tax_profile_versions"
  ADD COLUMN "presetId" TEXT,
  ADD COLUMN "activationIdempotencyKey" TEXT,
  ADD COLUMN "activationPayloadHash" TEXT,
  ADD COLUMN "eligibilityEvidence" JSONB;

CREATE UNIQUE INDEX "restaurant_tax_profiles_org_activation_key"
  ON "restaurant_tax_profile_versions"("organizationId", "activationIdempotencyKey")
  WHERE "activationIdempotencyKey" IS NOT NULL;

CREATE UNIQUE INDEX "restaurant_tax_profiles_org_branch_effective_key"
  ON "restaurant_tax_profile_versions"("organizationId", "branchId", "effectiveFrom");

ALTER TABLE "restaurant_tax_profile_versions"
  ADD CONSTRAINT "restaurant_tax_activation_evidence_complete" CHECK (
    ("activationIdempotencyKey" IS NULL AND "activationPayloadHash" IS NULL AND "presetId" IS NULL AND "eligibilityEvidence" IS NULL)
    OR
    (btrim("activationIdempotencyKey") <> '' AND "activationPayloadHash" ~ '^[0-9a-f]{64}$'
      AND btrim("presetId") <> '' AND jsonb_typeof("eligibilityEvidence") = 'object')
  );
