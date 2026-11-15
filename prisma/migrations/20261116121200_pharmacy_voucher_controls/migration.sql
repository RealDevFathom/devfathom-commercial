BEGIN;

-- pharmacy_vouchers and pharmacy_sale_lines force row-level security. The
-- backfills below must see every tenant's rows, so this transaction runs with
-- platform scope (transaction-local) as other backfill migrations do.
SELECT set_config('app.is_platform_admin', 'true', true);

-- DEV-819 (security review SEC-E): a voucher has a use limit, a required expiry,
-- revocation and a recorded approver. A voucher above the value cap is approved
-- by a second manager (or a solo owner's fresh PIN); the issuer alone is never
-- that approver. The application enforces the cap and re-checks the issuer and
-- approver at each redemption; these columns and checks are the stored record.
ALTER TABLE "pharmacy_vouchers"
  ADD COLUMN IF NOT EXISTS "maxUses" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "usedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalPolicy" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalCredentialId" TEXT,
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "revokeReason" TEXT;

-- Existing redemptions count against the use limit; a voucher already redeemed
-- is used up rather than left with an unlimited count.
UPDATE "pharmacy_vouchers" v
SET "usedCount" = used.count,
    "maxUses" = GREATEST(v."maxUses", used.count)
FROM (
  SELECT "organizationId", "voucherId", COUNT(*)::INTEGER AS count
  FROM "pharmacy_sale_lines"
  WHERE "voucherId" IS NOT NULL
  GROUP BY "organizationId", "voucherId"
) used
WHERE used."organizationId" = v."organizationId"
  AND used."voucherId" = v."id"
  AND v."usedCount" < used.count;

-- An expiry is now required. A voucher issued without one ends 90 days after issue.
UPDATE "pharmacy_vouchers"
SET "validUntil" = "createdAt" + INTERVAL '90 days'
WHERE "validUntil" IS NULL;
ALTER TABLE "pharmacy_vouchers" ALTER COLUMN "validUntil" SET NOT NULL;

-- A voucher issued before these controls has no recorded approver. Within the
-- per-use value cap (Rs 1,000) the issuer's own issue stands as its approval;
-- above it there was never a second approver, so it is revoked and must be
-- reissued with one.
UPDATE "pharmacy_vouchers"
SET "approvedByUserId" = "issuedByUserId",
    "approvalPolicy" = 'VOUCHER_WITHIN_CAP'
WHERE "approvalPolicy" IS NULL
  AND "discountMinor" <= 100000;
UPDATE "pharmacy_vouchers"
SET "active" = false,
    "revokedAt" = CURRENT_TIMESTAMP,
    "revokeReason" = 'Issued above the value cap without a second approver. Reissue it.'
WHERE "approvalPolicy" IS NULL
  AND "revokedAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'pharmacy_vouchers_use_limit'
  ) THEN
    ALTER TABLE "pharmacy_vouchers"
      ADD CONSTRAINT "pharmacy_vouchers_use_limit"
      CHECK ("maxUses" >= 1 AND "usedCount" >= 0 AND "usedCount" <= "maxUses");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'pharmacy_vouchers_approval_recorded'
  ) THEN
    ALTER TABLE "pharmacy_vouchers"
      ADD CONSTRAINT "pharmacy_vouchers_approval_recorded"
      CHECK (
        "revokedAt" IS NOT NULL
        OR ("approvedByUserId" IS NOT NULL AND "approvalPolicy" IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'pharmacy_vouchers_revocation'
  ) THEN
    ALTER TABLE "pharmacy_vouchers"
      ADD CONSTRAINT "pharmacy_vouchers_revocation"
      CHECK ("revokedAt" IS NULL OR "active" = false);
  END IF;
END $$;

COMMIT;
