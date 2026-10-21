# Production release checklist

Run through before any production deploy (go-ahead comes from Saad via Inky).

## Pharmacy regulatory rules

- [ ] **Counsel sign-off — Sindh (PK-SD v1) jurisdiction rules.** Counsel has confirmed in writing
      the licence categories (RETAIL, WHOLESALE), schedules (G, H), H as prescription-only and
      controlled-register-tracked, 40 h/week qualified-person coverage and 1825-day prescription
      retention. Sign-off reference: ____ (name, date). Until then the rule set carries
      `pendingLegalReview: true`, which production enforcement refuses
      (`RULE_SET_PENDING_LEGAL_REVIEW`). Clearing it needs a migration that sets the flag false.
- [ ] `APP_ENV` is set correctly: `staging` / `pilot` allow pending-review rule sets; production
      sets `production` (startup exits if it is missing).

## Migration history

- [ ] **Renamed Sindh migration.** `20261021110000_pharmacy_sindh_published_rules` was renamed to
      `20261021110500_pharmacy_sindh_published_rules`. On any database that already applied the old
      name (staging, pilots), rename the `_prisma_migrations` row **before** deploying:

      ```sql
      BEGIN;
      DO $$
      DECLARE changed integer;
      BEGIN
        IF EXISTS (SELECT 1 FROM "_prisma_migrations"
                   WHERE migration_name = '20261021110500_pharmacy_sindh_published_rules') THEN
          RAISE NOTICE 'new name already recorded; nothing to do';
          RETURN;
        END IF;
        UPDATE "_prisma_migrations"
           SET migration_name = '20261021110500_pharmacy_sindh_published_rules'
         WHERE migration_name = '20261021110000_pharmacy_sindh_published_rules'
           AND finished_at IS NOT NULL
           AND rolled_back_at IS NULL;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed <> 1 THEN
          RAISE EXCEPTION 'expected exactly 1 finished row to rename, got %', changed;
        END IF;
      END $$;
      COMMIT;
      ```

      `20261021111000_pharmacy_sindh_pending_review_and_province_checks` then applies normally
      (flags the existing PK-SD row and adds the NOT VALID province CHECKs, idempotently).
      **Checksum warning:** the renamed file's checksum differs from the one recorded for the old
      name; `prisma migrate deploy` does not re-verify applied checksums, but `migrate dev`/`diff`
      tooling will flag it. Do not "fix" it by editing the row's checksum without review.
- [ ] `APP_ENV` is set (`production`, `staging` or `pilot`) by the deploy infrastructure (the per-stage
      runtime environment config), not by hand; production startup exits otherwise and
      logs the value it started with.
