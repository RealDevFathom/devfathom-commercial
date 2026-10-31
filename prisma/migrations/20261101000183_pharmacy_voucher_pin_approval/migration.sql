-- Existing approvals deliberately retain NULL evidence: only a verified owner
-- PIN may authorize monetary voucher capture/redemption. No credentials or
-- historical redemption records are rewritten.
ALTER TABLE "pharmacy_campaigns"
  ADD COLUMN "ownerApprovalPinCredentialId" TEXT;
