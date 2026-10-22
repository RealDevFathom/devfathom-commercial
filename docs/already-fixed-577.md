# GitHub issue #577 is already fixed

The reported `--grants-only` failure no longer exists in the current code:

- `scripts/pharmacy-e2e-environment.ts:13-21` selects credentials by seed mode. A grants-only
  seed requires only `PHARMACY_E2E_ADMIN_PASSWORD`; the admin email remains required for a full
  seed.
- `scripts/seed-staging-demo.ts:104-121` invokes the pharmacy seed in grants-only mode without
  setting `PHARMACY_E2E_ADMIN_EMAIL`, matching the intended contract.
- `scripts/seed-pharmacy-e2e.ts:963-971` handles the grants-only branch and returns before the
  full-seed branch reads `PHARMACY_E2E_ADMIN_EMAIL` at line 973.
- `tests/staging-demo-seed-guard.test.ts:118-126` directly covers a grants-only seed with
  `PHARMACY_E2E_ADMIN_EMAIL` unset. Lines 128-137 retain the fail-closed password requirement,
  while lines 109-116 verify that both credentials are still required for a full seed.

No runtime code was changed for issue #577 because the focused implementation and regression
coverage are already present.
