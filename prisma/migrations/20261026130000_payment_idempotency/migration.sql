-- Existing payments predate idempotent commands, so derive a stable, unique key
-- from their immutable primary key before making the command key required.
ALTER TABLE "payments" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "payments" SET "idempotencyKey" = 'legacy:' || "id";
ALTER TABLE "payments" ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "payments_organizationId_idempotencyKey_key"
  ON "payments"("organizationId", "idempotencyKey");
