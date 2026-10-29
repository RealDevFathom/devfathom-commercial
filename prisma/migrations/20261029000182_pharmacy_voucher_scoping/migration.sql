-- #756: voucher campaigns are opt-in and redeemable only against the explicit
-- non-drug category allowlist. Existing campaigns remain non-voucher campaigns.
ALTER TABLE "pharmacy_campaigns"
  ADD COLUMN "voucherEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "eligibleCategoryAllowlist" JSONB NOT NULL DEFAULT '["FRONT_SHOP"]'::jsonb;

ALTER TABLE "pharmacy_campaigns"
  ADD CONSTRAINT "pharmacy_campaign_voucher_categories_ck"
  CHECK (
    NOT "voucherEnabled"
    OR "eligibleCategoryAllowlist" = '["FRONT_SHOP"]'::jsonb
  );
