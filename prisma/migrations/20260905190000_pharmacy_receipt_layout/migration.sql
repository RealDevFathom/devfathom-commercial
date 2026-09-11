-- Additive storage; existing pharmacy branch ENABLE/FORCE RLS remains unchanged.
ALTER TABLE "pharmacy_branches"
  ADD COLUMN "receiptLayout" JSONB,
  ADD COLUMN "receiptLayoutRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "PharmacyBranch_receiptLayout_object"
    CHECK ("receiptLayout" IS NULL OR jsonb_typeof("receiptLayout") = 'object'),
  ADD CONSTRAINT "PharmacyBranch_receiptLayoutRevision_nonnegative"
    CHECK ("receiptLayoutRevision" >= 0);
