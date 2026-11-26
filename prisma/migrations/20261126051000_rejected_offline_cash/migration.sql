BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TYPE "PharmacyDrawerMovementKind" ADD VALUE IF NOT EXISTS 'REJECTED_OFFLINE_CASH';
ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_REJECTED_OFFLINE_CASH';
ALTER TYPE "FinanceAccountCode" ADD VALUE IF NOT EXISTS 'OFFLINE_CASH_SUSPENSE';

CREATE OR REPLACE FUNCTION pharmacy_cash_shift_expected(org text, shift text, opening integer)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT opening::bigint + COALESCE(SUM(CASE
    WHEN m."kind"::text IN ('CASH_SALE', 'PAID_IN', 'REJECTED_OFFLINE_CASH') THEN m."amountMinor"::bigint
    WHEN m."kind" IN ('CASH_REFUND', 'PAID_OUT') THEN -m."amountMinor"::bigint
    ELSE 0 END), 0)
  FROM "pharmacy_drawer_movements" m
  WHERE m."organizationId" = org AND m."shiftId" = shift
$$;
COMMIT;
