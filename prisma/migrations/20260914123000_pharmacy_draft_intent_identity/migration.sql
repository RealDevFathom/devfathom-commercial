-- Additive, unapplied source migration. Historical append-only actions retain NULL
-- identity: their original semantic input cannot be reconstructed reliably.
-- Existing RLS, foreign keys, one-draft-reference checks and append-only triggers
-- remain intact. NULLs do not collide in PostgreSQL's ordinary unique index.
BEGIN;
ALTER TABLE "pharmacy_stock_signal_actions"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "payloadHash" TEXT;
CREATE UNIQUE INDEX "pharmacy_stock_signal_actions_org_branch_intent_key"
  ON "pharmacy_stock_signal_actions" ("organizationId", "branchId", "idempotencyKey");
COMMIT;
