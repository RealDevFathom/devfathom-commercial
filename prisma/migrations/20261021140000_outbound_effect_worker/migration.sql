-- Retry scheduling and dead letters for the outbound effect worker.
-- PENDING rows wait until availableAt. Exhausted rows become DEAD and are not claimed.
ALTER TABLE "outbound_effects" ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "outbound_effects" DROP CONSTRAINT "outbound_effects_status_check";
ALTER TABLE "outbound_effects" ADD CONSTRAINT "outbound_effects_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD'));

CREATE INDEX "outbound_effects_status_available_idx" ON "outbound_effects"("status", "availableAt");
