-- Retry identity is database-authoritative and treats absent optional attribution
-- as an identity value, so concurrent library callers cannot create duplicates.
CREATE UNIQUE INDEX "restaurant_sop_evidence_retry_identity_key"
ON "restaurant_sop_evidence" (
  "organizationId",
  "occurrenceId",
  "occurrenceStepId",
  "uploaderStaffProfileId",
  "contentHash",
  "mimeType"
) NULLS NOT DISTINCT;
