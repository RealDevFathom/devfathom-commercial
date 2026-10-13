-- Proposed only. Every FK validates existing rows; any orphan/correlation failure
-- aborts the entire migration. No repairs, grants, RLS changes, or backfills.
-- RESTRICT prevents deletion/key updates of referenced parents while children exist.
BEGIN;

ALTER TABLE "public"."finance_journal_entries"
  ADD CONSTRAINT "finance_journal_entries_visibility_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "public"."organizations" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_accounting_periods"
  ADD CONSTRAINT "pharmacy_accounting_periods_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_bank_statement_lines"
  ADD CONSTRAINT "pharmacy_bank_statement_lines_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_bookkeeping_transactions"
  ADD CONSTRAINT "pharmacy_bookkeeping_transactions_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_daily_closes"
  ADD CONSTRAINT "pharmacy_daily_closes_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_drawer_sessions"
  ADD CONSTRAINT "pharmacy_drawer_sessions_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_money_idempotency_keys"
  ADD CONSTRAINT "pharmacy_money_idempotency_keys_visibility_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "public"."organizations" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_receipt_number_sequences"
  ADD CONSTRAINT "pharmacy_receipt_number_sequences_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_sales"
  ADD CONSTRAINT "pharmacy_sales_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_settlement_batches"
  ADD CONSTRAINT "pharmacy_settlement_batches_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_tax_profile_versions"
  ADD CONSTRAINT "pharmacy_tax_profile_versions_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_unfulfilled_demand_events"
  ADD CONSTRAINT "pharmacy_unfulfilled_demand_events_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."restaurant_tax_official_sources"
  ADD CONSTRAINT "restaurant_tax_official_sources_visibility_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "public"."organizations" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_restock_interests"
  ADD CONSTRAINT "pharmacy_restock_interests_visibility_fkey" FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "public"."pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "public"."pharmacy_counter_keymap_preferences"
  ADD CONSTRAINT "pharmacy_counter_keymap_preferences_visibility_fkey" FOREIGN KEY ("organizationId")
  REFERENCES "public"."organizations" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
