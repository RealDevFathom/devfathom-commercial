# Production release checklist

Run through before any production deploy (go-ahead comes from Saad via Inky).

## Pharmacy regulatory rules

- [ ] **Counsel sign-off — Sindh (PK-SD v2) jurisdiction rules.** Counsel has confirmed in writing
      the licence categories (RETAIL, WHOLESALE), schedules (G, H), H as prescription-only and
      controlled-register-tracked, 40 h/week qualified-person coverage and 1825-day prescription
      retention. Sign-off reference: ____ (name, date). Until then the rule set carries
      `pendingLegalReview: true`, which production enforcement refuses
      (`RULE_SET_PENDING_LEGAL_REVIEW`). Clearing it requires counsel sign-off and a new appended version with explicit false flags.
- [ ] `APP_ENV` is set correctly: `staging` / `pilot` allow pending-review rule sets; production
      sets `production` (startup exits if it is missing).

## Migration history

- [ ] Keep `20261021110000_pharmacy_sindh_published_rules` byte-for-byte as originally
      deployed (SHA-256 `694a324e4b2d054d5346c7a2d355449ec4d75508a5d9772ca705fcf6492f1a24`).
      Do not rename migration history or rewrite recorded checksums.
- [ ] Deploy `20261021153500_pharmacy_sindh_v2_pending_legal_review`. It appends flagged
      PK-SD v2 under FORCE RLS using a transaction-local platform-admin statement;
      v1 remains unchanged. The overlap constraint now includes version, so immutable
      versions can share an effective window. It also adds province CHECKs idempotently.
      Verify both fresh deploy and upgrade from the original migration with a
      NOSUPERUSER NOBYPASSRLS migration role. The latest PK-SD row must be v2 and all
      seven rule fields must have `pendingLegalReview: true`.
- [ ] Runtime selects the latest effective rule version, including for profiles referencing
      v1. Unflagged Sindh fields are treated as pending legal review. Production refuses
      pending rules; staging and pilots may exercise them.
- [ ] Licence expiry is inclusive through 23:59:59.999 in the workspace time zone: a licence
      expiring today is valid both when saving a profile and when operating a branch.
- [ ] `APP_ENV` is set (`production`, `staging` or `pilot`) by deploy infrastructure;
      production startup exits otherwise and logs the value it started with.
