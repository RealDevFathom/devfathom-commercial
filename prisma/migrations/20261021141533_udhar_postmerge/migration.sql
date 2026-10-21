ALTER TYPE "FinanceSourceKind" ADD VALUE 'PHARMACY_KHATA_EVENT';
ALTER TABLE pharmacy_customers ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT 'en';
