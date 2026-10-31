-- Existing digest opt-ins authorize in-app capture only. WhatsApp starts off.
ALTER TABLE "pharmacy_owner_digest_settings" ADD COLUMN "whatsappPhoneHash" TEXT;
