-- #474: retain only pseudonymous WhatsApp consent proof when a tenant is purged.
CREATE TABLE "pharmacy_whatsapp_consent_archives" (
  "id" TEXT NOT NULL,
  "organizationFingerprint" TEXT NOT NULL,
  "customerFingerprint" TEXT NOT NULL,
  "optedIn" BOOLEAN NOT NULL,
  "consentChangedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_whatsapp_consent_archives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_wa_consent_archive_org_hash_check" CHECK ("organizationFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "pharmacy_wa_consent_archive_customer_hash_check" CHECK ("customerFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "pharmacy_wa_consent_archive_expiry_check" CHECK ("expiresAt" > "archivedAt")
);

CREATE UNIQUE INDEX "pharmacy_wa_consent_archive_event_key"
  ON "pharmacy_whatsapp_consent_archives" ("organizationFingerprint", "customerFingerprint", "consentChangedAt");
CREATE INDEX "pharmacy_wa_consent_archive_expiry_idx"
  ON "pharmacy_whatsapp_consent_archives" ("expiresAt");

-- This is control-plane compliance evidence, not tenant-readable data.
REVOKE ALL ON TABLE "pharmacy_whatsapp_consent_archives" FROM PUBLIC;
