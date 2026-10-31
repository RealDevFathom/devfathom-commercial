-- RPT-03 — persist pending owner-digest WhatsApp work in the same transaction as
-- the capture, so a failure before the send reservation is retried instead of lost.
-- Nullable additions are safe for non-empty tables; existing captures stay delivered.
ALTER TABLE "pharmacy_owner_digest_captures" ADD COLUMN "whatsappPendingAt" TIMESTAMP(3);
ALTER TABLE "pharmacy_owner_digest_captures" ADD COLUMN "whatsappParameters" JSONB;
