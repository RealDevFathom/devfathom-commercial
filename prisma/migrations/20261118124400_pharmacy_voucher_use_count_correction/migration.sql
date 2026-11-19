BEGIN;

-- DEV-951: 20261116121200_pharmacy_voucher_controls counted each voucher's past redemptions
-- with only app.is_platform_admin set. pharmacy_sale_lines forces row-level security with a
-- tenant-only policy, so a NOSUPERUSER NOBYPASSRLS migration owner saw no lines and every
-- voucher kept usedCount 0: a voucher already used could be redeemed once more. This counts
-- them again, one organization at a time with app.current_organization_id set.
--
-- A redemption is a sale line carrying the voucher, as the counter counts it. Lines on a voided
-- sale are left out: a void gives back the uses its lines took. A count is only ever raised,
-- never lowered; maxUses is raised with it where needed so usedCount <= maxUses holds, which
-- leaves that voucher used up. Expiry and revocation are not touched. Re-running changes nothing.
SELECT set_config('app.is_platform_admin', 'true', true);

-- A redemption takes its use on the voucher row before writing its line, in one transaction.
-- Holding redemptions back until this commits means every line it cannot see is already
-- counted in usedCount, and no redemption can act on a count this is about to raise.
LOCK TABLE "pharmacy_vouchers" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  tenant_id TEXT;
BEGIN
  FOR tenant_id IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);
    UPDATE "pharmacy_vouchers" AS v
    SET "usedCount" = used.count,
        "maxUses" = GREATEST(v."maxUses", used.count)
    FROM (
      SELECT line."voucherId", COUNT(*)::INTEGER AS count
      FROM "pharmacy_sale_lines" AS line
      JOIN "pharmacy_sales" AS sale
        ON sale."organizationId" = line."organizationId" AND sale."id" = line."saleId"
      WHERE line."organizationId" = tenant_id
        AND line."voucherId" IS NOT NULL
        AND sale."status"::TEXT <> 'VOID'
      GROUP BY line."voucherId"
    ) AS used
    WHERE v."organizationId" = tenant_id
      AND v."id" = used."voucherId"
      AND v."usedCount" < used.count;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

COMMIT;
