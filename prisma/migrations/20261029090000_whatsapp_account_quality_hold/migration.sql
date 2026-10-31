-- A dedicated, reversible state prevents a provider hold from being confused with
-- an owner's terminal refusal. The nullable provenance column is safe for existing rows.
ALTER TYPE "PharmacyCampaignStatus" ADD VALUE IF NOT EXISTS 'ACCOUNT_QUALITY_HOLD';
ALTER TABLE "pharmacy_campaigns" ADD COLUMN "holdPreviousStatus" "PharmacyCampaignStatus";

-- Older deployments may already contain retry-created duplicates. Retain the
-- oldest owner alert before enforcing durable, per-owner webhook idempotency.
DELETE FROM "notifications" newer
USING "notifications" older
WHERE newer."organizationId" = older."organizationId"
  AND newer."type" = 'pharmacy_whatsapp_account_quality'
  AND newer."userId" = older."userId"
  AND newer."type" = older."type"
  AND newer."entityId" = older."entityId"
  AND newer."entityId" IS NOT NULL
  AND newer."createdAt" >= older."createdAt"
  AND (newer."createdAt" > older."createdAt" OR newer."id" > older."id");

-- Other notification types may legitimately repeat for the same entity.
CREATE UNIQUE INDEX "notifications_whatsapp_account_quality_owner_event_key"
ON "notifications"("organizationId", "userId", "type", "entityId")
WHERE "type" = 'pharmacy_whatsapp_account_quality';
