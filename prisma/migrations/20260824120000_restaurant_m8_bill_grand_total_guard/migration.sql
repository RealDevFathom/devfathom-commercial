-- WHA-132 / M8 correction B — a bill's grand total may never be negative.
--
-- M5 pinned the fraction constraints and M8 added `discountTotal >= 0`, but nothing
-- stopped the two deductions on a bill (a comp and a loyalty redemption) from being
-- applied to the same money twice and driving `grandTotal` below zero. The command
-- layer now clamps the comp and releases the redemption instead (`bills.compLine`,
-- `loyalty.releaseLoyaltyRedemption`); this is the durable floor under it, so no
-- future writer can persist a negative grand total.
--
-- FAILS CLOSED. A financial invariant does not deploy "mostly". This migration
-- refuses to finish on a database that already violates it, in two independent ways:
--
--   1. an explicit precondition that RAISEs when it can see an offending row — the
--      loud, readable failure an operator gets first;
--   2. an UNGUARDED `VALIDATE CONSTRAINT`. This is the one that cannot be fooled:
--      the validation scan reads the heap directly, so it sees rows the precondition
--      cannot (`restaurant_bills` is FORCE ROW LEVEL SECURITY, and a migration runs
--      with no `app.current_organization_id`, so the precondition's own SELECT is
--      policy-filtered), and it also catches a row committed between the two steps.
--
-- Neither path is caught or downgraded to a WARNING: a deploy that cannot establish
-- the invariant must stop, not proceed with a NOT VALID constraint and known-bad
-- history. Diagnostics are AGGREGATE ONLY — a row count and the constraint name,
-- never a bill, customer, line, tender or payment — so a failed deploy log carries no
-- financial or personal detail.
--
-- Additive and re-runnable: the constraint is added only when absent and `VALIDATE`
-- on an already-valid constraint is a no-op, so re-running this migration on a
-- healthy database succeeds and changes nothing.
--
-- No Prisma schema change: `prisma/schema.prisma` cannot express a CHECK, so this
-- introduces no datamodel drift.

-- 1. Precondition. Loud, aggregate-only, and fatal.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM "restaurant_bills" WHERE "grandTotal" < 0;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'restaurant_bills holds % row(s) with grandTotal < 0; constraint restaurant_bills_grandTotal_nonneg_ck cannot be established.',
      offending
      USING
        ERRCODE = 'check_violation',
        HINT = 'Correct every restaurant_bills row where "grandTotal" < 0 (each is a comp or loyalty redemption double-deducted before M8 correction B), then re-run this migration; it is idempotent.';
  END IF;
END
$$;

-- 2. Add the constraint if absent. NOT VALID first, so every INSERT/UPDATE from this
--    point on is rejected while the validation scan below takes only a
--    SHARE UPDATE EXCLUSIVE lock instead of blocking the register.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.restaurant_bills'::regclass
       AND conname = 'restaurant_bills_grandTotal_nonneg_ck'
  ) THEN
    ALTER TABLE "restaurant_bills"
      ADD CONSTRAINT "restaurant_bills_grandTotal_nonneg_ck" CHECK ("grandTotal" >= 0) NOT VALID;
  END IF;
END
$$;

-- 3. Validate the history. UNGUARDED ON PURPOSE: if this raises check_violation the
--    migration fails and the deploy stops.
ALTER TABLE "restaurant_bills" VALIDATE CONSTRAINT "restaurant_bills_grandTotal_nonneg_ck";
