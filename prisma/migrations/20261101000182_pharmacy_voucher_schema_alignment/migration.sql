-- Match the Prisma tenant default without changing existing redemption evidence
-- or rewriting either deployed voucher migration.
ALTER TABLE "pharmacy_voucher_redemptions"
  ALTER COLUMN "organizationId" SET DEFAULT current_setting('app.current_organization_id', true);
