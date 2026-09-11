-- Additive storage on the existing tenant-scoped, FORCE RLS branch table.
-- No policy changes, new table, backfill, or tenant data rewrite.
ALTER TABLE "restaurant_branches"
  ADD COLUMN "receiptLayout" JSONB,
  ADD COLUMN "receiptLayoutRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "RestaurantBranch_receiptLayout_object"
    CHECK ("receiptLayout" IS NULL OR jsonb_typeof("receiptLayout") = 'object'),
  ADD CONSTRAINT "RestaurantBranch_receiptLayoutRevision_nonnegative"
    CHECK ("receiptLayoutRevision" >= 0);
