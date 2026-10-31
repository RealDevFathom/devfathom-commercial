-- Additive delivery states and nullable audit fields are safe for existing rows.
ALTER TYPE "PharmacyRestockNotificationStatus" ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE "PharmacyRestockNotificationStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "PharmacyRestockNotificationStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE "pharmacy_restock_notifications"
  ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastError" TEXT;
