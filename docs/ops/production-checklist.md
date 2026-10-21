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
      name (staging, pilots), rename the `_prisma_migrations` row **before** deploying, e.g.
      `UPDATE "_prisma_migrations" SET migration_name = '20261021110500_pharmacy_sindh_published_rules'
      WHERE migration_name = '20261021110000_pharmacy_sindh_published_rules';`
      `20261021111000_pharmacy_sindh_pending_review_and_province_checks` then applies normally
      (flags the existing PK-SD row and adds the NOT VALID province CHECKs). The renamed file's checksum
      differs from the old one; `migrate deploy` does not re-verify applied checksums.
- [ ] `APP_ENV` is set (`production`, `staging` or `pilot`); production startup exits otherwise.
