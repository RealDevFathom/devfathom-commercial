ALTER TABLE "pharmacy_customers"
ADD COLUMN "preferredLanguage" VARCHAR(2) NOT NULL DEFAULT 'en';

ALTER TABLE "pharmacy_customers"
ADD CONSTRAINT "pharmacy_customers_preferred_language_check"
CHECK ("preferredLanguage" IN ('en', 'ur'));
