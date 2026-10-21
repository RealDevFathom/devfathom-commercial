-- Consent proof expires one year after archival. Preserve existing FORCE RLS.
ALTER TABLE growth_wa_consent_retention ADD COLUMN "expiresAt" timestamptz;
UPDATE growth_wa_consent_retention SET "expiresAt" = "retainedAt" + interval '365 days';
ALTER TABLE growth_wa_consent_retention ALTER COLUMN "expiresAt" SET DEFAULT (now() + interval '365 days');
ALTER TABLE growth_wa_consent_retention ALTER COLUMN "expiresAt" SET NOT NULL;
CREATE INDEX growth_wa_consent_retention_expiry ON growth_wa_consent_retention ("expiresAt");
-- Existing archives contain unnecessary free text. Remove rather than preserve it.
DELETE FROM growth_wa_consent_retention;
