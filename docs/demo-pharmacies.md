# Demo pharmacies

`npm run seed:demo` provisions two idempotently named, PKR-denominated demo organizations:

- **Solo Demo Pharmacy** (`solo-demo-pharmacy`) uses **SOLO** mode and is intended for one owner login.
- **Staffed Demo Pharmacy** (`staffed-demo-pharmacy`) uses **STAFFED** mode and separates owner, pharmacist, and cashier logins.

Set all four secrets before running the seed; the command fails closed when any is absent and never prints or hardcodes them:

```bash
export DEMO_SOLO_OWNER_PASSWORD='...'
export DEMO_STAFFED_OWNER_PASSWORD='...'
export DEMO_STAFFED_PHARMACIST_PASSWORD='...'
export DEMO_STAFFED_CASHIER_PASSWORD='...'
npm run seed:demo
```

The fixture catalog defines 40 familiar Pakistani-market products with generic name, strength, dosage form, PKR MRP, and two stock-batch profiles. It deliberately includes low-stock and near-expiry examples so operational warnings are visible. Demo data must not be used for clinical decisions.

Operating mode is organization-scoped and is unrelated to packages or feature entitlements. Enabling SOLO does not delete staff. It grants only the system owner the PIN-reauthenticated, audited self-approval exception; STAFFED keeps pharmacist approval and independent maker-checker separation.
