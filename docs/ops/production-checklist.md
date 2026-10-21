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
      must leave it unset or `production`.
