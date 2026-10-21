# Migration RLS sweep — QA sev2 #218

Branch: `fix/migration-rls-218`, based on `origin/integration/consolidation-20261019` at `2f6ce748`. Seat-only commit `9c31b191` reverted with `git revert` in `d0e0e168`; seat changes belong to PR #215 and are excluded. No pre-existing migration SQL was edited.

## Audit

All migration files containing `app.is_platform_admin` or case-insensitive `SET LOCAL` were read/classified. Policy references were checked for migration-time DML versus function/trigger bodies. Scope setters were checked for a real SQL transaction versus PL/pgSQL block. Six silently-missed data changes have distinct, explicit-transaction, idempotent repair migrations.

| Original migration | Finding and action |
| --- | --- |
| `20260728092000_row_level_security` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260728100000_platform_sessions` | Guarded failure, not silent: tokenHash SET NOT NULL validates hidden rows. No replay can repair an applied database with missing tokenHash. |
| `20260728101000_platform_settings` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260728103000_enterprise_sso` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260728104000_platform_mfa` | Missing platform scope: UPDATE on forced platform_users can affect zero rows. Repair 20261021180400; only unenrolled, still-required rows change. |
| `20260802130000_pending_login_intents` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260803120000_meeting_occurrences` | Unscoped local setting, but immediate row_security_active guard raises before DML. No silently-applied repair needed; populated autocommit execution must abort. |
| `20260818120000_package_module_inheritance_cleanup` | Silent DELETE no-op under FORCE RLS. Repair 20261021180800 repeats the conservative redundancy predicate; preserves overrides. |
| `20260818130000_organization_vertical_foundation` | NOT NULL validations reject missed vertical updates. No silently-applied repair needed. |
| `20260818140000_restaurant_staff_operators_devices` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260818160000_restaurant_brands_catalog_menus` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260819000000_restaurant_orders_kitchen_floor` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260819120000_restaurant_money` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260819130000_restaurant_inventory_purchasing` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260820000000_restaurant_scheduler_sop_notifications` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260821010000_restaurant_customers_loyalty_insights` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260824120000_restaurant_m8_bill_grand_total_guard` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260825120000_m8_historical_loyalty_liability_correction` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260827070000_restaurant_cameras` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260827070000_restaurant_terminal_payments` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260827120000_restaurant_menu_ocr_import` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260827120000_restaurant_staff_shifts` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260828100000_vertical_configurable_departments` | Default INSERT SELECT can miss RLS-hidden organizations; user FK validates compatibility rows, but not defaults for empty organizations. Repair 20261021180500; conflicts preserved. |
| `20260828120000_restaurant_sop_job_roles_assignment` | Unscoped SET LOCAL, but assignee_target CHECK validates every existing row and rejects missed assignment updates. Applied state cannot contain those invalid legacy targets; no replay. |
| `20260828140000_restaurant_promotions_core` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260828160000_restaurant_staff_capability_deny_override` | Unscoped SET LOCAL warning; no migration DML. ADD COLUMN DEFAULT ALLOW initializes existing tuples independently of RLS; no replay. |
| `20260829090000_restaurant_print_bridge` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260829180000_restaurant_order_events_append_only_rls` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260829180000_restaurant_tax_refund_allocations` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260830070000_restaurant_notification_webhook` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260830180000_restaurant_workforce_v1` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260830235000_restaurant_activation_acknowledgements` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260830235900_restaurant_recipe_ingredient_substitutes` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902120000_pharmacy_medicine_identity` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902130000_pharmacy_batch_stock_ledger` | DML is inside runtime trigger functions, not executed by migration; no backfill to replay. |
| `20260902130000_pharmacy_medicine_catalog_review` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902130000_pharmacy_regulatory_profiles` | Jurisdiction seed INSERT executes before RLS is enabled on its new table; no replay. |
| `20260902131500_pharmacy_purchasing` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902140000_pharmacy_patient_prescriptions` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902150000_pharmacy_goods_receiving` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902150000_pharmacy_inventory_operations` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902160000_pharmacy_onboarding_and_branch` | Branch seed reads forced seam tables, but subsequent validated composite FKs reject any missing branch aggregate. No silently-applied repair needed. |
| `20260902170000_pharmacy_rx_review_substitution_controlled_register` | DML is runtime trigger code, not migration backfill; no replay. |
| `20260902170500_pharmacy_supplier_returns_stock_signals` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260902201000_pharmacy_safety_inspection_retention` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904100000_pharmacy_cold_chain_locations` | Range CHECK rejects missed updates for existing coldChain=true rows. No silently-applied repair needed. |
| `20260904110000_pharmacy_customer_loyalty_p0_lite` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904110500_pharmacy_fiscal_documents` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904120000_pharmacy_owner_digest` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904133000_restaurant_sales_demo` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904190000_pharmacy_anomaly_signals` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904192000_pharmacy_supplier_action_links` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904193000_pharmacy_family_khata` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904195000_pharmacy_central_purchasing` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904196000_pharmacy_permissioned_marketing` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904198000_pharmacy_refill_support` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260904200000_pharmacy_pharmacovigilance` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260905030000_pharmacy_drap_monitoring` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260905040000_pharmacy_pack_authentication` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260905070000_pharmacy_reference_connector_automation` | Local setting lost across autocommit statements; forced role source yields zero permission grants. Repair 20261021180100; ON CONFLICT preserves decisions. |
| `20260908100000_hospitality_vertical` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260908150000_hospitality_extras` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260915003000_hotel_property_access` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260915010000_hotel_property_maintenance` | PERFORM set_config and guard reads are in the same DO statement; local scope survives for that statement. No replay. |
| `20260929120000_pharmacy_whatsapp_channel` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20260929120000_vertical_neutral_camera_evidence` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261012110000_pharmacy_migration_source_tenant_anchor` | SET LOCAL timeouts already inside explicit BEGIN/COMMIT. No data writes; no repair. |
| `20261014000000_print_bridge_enrollment_only` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261014010000_printer_inventory_foundation` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261019213000_restaurant_wallet_passes` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261021100000_hospitality_inventory` | INSERT is in runtime status-event trigger, not executed by migration; no replay. |
| `20261021101000_hospitality_meal_plans` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261021102000_hospitality_function_spaces` | UPDATE is in runtime rebuffer trigger, not executed by migration; no replay. |
| `20261021103000_hospitality_journey_templates` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261021120000_pharmacy_branch_assignments` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261021130000_outbound_effects` | Platform scope appears only in policy definitions/comments; no migration-time data change requiring replay. |
| `20261021133000_pharmacy_branch_assignment_backfill` | Security known case, lines 9–10: local scope expires before INSERT. Forced source tables hide eligible users/branches and guard also sees zero. Repair 20261021180200; deterministic IDs and ON CONFLICT. |
| `20261021140000_controlled_register_sellable_balance` | INSERT is in runtime reconciliation trigger, not executed by migration; no replay. |
| `20261021160000_outbound_effect_worker` | Local scope lost before forced outbox UPDATE/DELETE. Repair 20261021180300 strips secret/url and deletes FAILED; raw rate keys delete is already unprotected and safely repeated. |

Audited original migrations: **79**. New repairs: **6**.

## Verification

- Full scratch deploy: **165 migrations applied**. Separate populated database: all six pending repairs applied by `prisma migrate deploy`, followed by SQL assertions for every repaired count; passed.
- PostgreSQL 17 local disposable database, timezone UTC. Database and all migrated objects owned by `migsweep218`, `NOSUPERUSER NOBYPASSRLS`. Full `prisma migrate deploy` from empty database; no RLS disabled and no session platform flag.
- Regression fixture explicitly sends local scope and subsequent writes as separate autocommit queries. This reproduces zero-row writes. Repairs are then executed with their own BEGIN/COMMIT, twice, without an outer test transaction.
- The reproduction establishes the statement-by-statement failure mode; it does not claim every Prisma/driver execution path splits a whole SQL file into separate transactions.
- Count expectations after repair: redundant module copy **1 → 0**; operator override **1 → 1**; pharmacy catalogue grant **0 → 1**; other-vertical grant **0 → 0**; active/on-leave branch assignments **0 → 2**; failed outbox row **1 → 0**; sanitized webhook **0 → 1**; unenrolled legacy MFA requirement **1 → 0**; enrolled MFA requirement **1 → 1**; restaurant department defaults **0 → 2**. All unchanged on replay; unscoped branch visibility **0**.
- MFA replay retains the original unenrolled-user predicate; it does not alter enrolled MFA users. Department defaults use conflict handling to preserve configured keys/names. No seat backfill is included.
- Focused command: `TZ=UTC MIGSWEEP_DATABASE_URL=<disposable-owner-url> bun run test tests/migration-rls-sweep.db.test.ts --maxWorkers=1`.
- Focused DB regression: **1 passed**, no skips with the owner URL supplied. Typecheck: **passed**.
- Typecheck: `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`. No build or full suite run.
