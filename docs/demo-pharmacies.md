# Demo pharmacies

Run `npm run seed:demo` from the repository root against a migrated local/demo PostgreSQL `DATABASE_URL`. The command persists two synthetic, PKR-denominated workspaces:

| Pharmacy / slug                                 | Mode    | Accounts                                                                                                                   |
| ----------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Solo Demo Pharmacy / `solo-demo-pharmacy`       | SOLO    | `owner@solo-demo-pharmacy.example`                                                                                         |
| Staffed Demo Pharmacy / `staffed-demo-pharmacy` | STAFFED | `owner@staffed-demo-pharmacy.example`, `pharmacist@staffed-demo-pharmacy.example`, `cashier@staffed-demo-pharmacy.example` |

Supply all four password environment variables through your secret manager or shell environment before running the command:

- `DEMO_SOLO_OWNER_PASSWORD`
- `DEMO_STAFFED_OWNER_PASSWORD`
- `DEMO_STAFFED_PHARMACIST_PASSWORD`
- `DEMO_STAFFED_CASHIER_PASSWORD`

These are synthetic password-authenticated tenants. The seed records its ownership in organization notes; `isDemo` stays false because that flag is reserved for the restaurant access-code demo seats. Reruns upgrade the seed's older pharmacy fixtures without changing their accounts or history.

Missing or blank variables stop the command before database writes. There are no password defaults, command-line password arguments, or logged passwords/hashes. Passwords are bcrypt hashed for newly created accounts. A rerun preserves existing credentials and operating-mode choices; use the application's password and mode workflows to change them. The `.example` addresses are sign-in identities, not delivery addresses.

Each pharmacy receives 40 familiar Pakistani-market medicines with brand, generic alias, strength, dosage form, manufacturer, and illustrative retail pack MRP in PKR. Prices are fixture values, not a current regulated-price feed. Each medicine has two manufacturing batches, printed MRPs, and received lots. Expired, near-expiry, and low-stock batches are included. Insulin is stored in the refrigerator; controlled medicines are catalog/stock examples and are not sold by the fixture.

The fixture includes three clearly synthetic suppliers with synthetic licence evidence, three replenishment draft POs with lines, and 30 distinct business dates ending on each pharmacy's initial seed date (reruns preserve that history window). Completed cash sales alternate OTC and non-controlled Rx products; the Rx examples have synthetic patient/prescriber records, prescription references, and immutable fills. OTC discounts occur on three days; five returns go into quarantine and receive matching cash refunds. Drawer sessions and finance/stock ledger entries are posted through the existing services. No payment provider, messaging service, or external clinical service is invoked.

Stable keys, a transaction-scoped advisory lock, and one transaction per pharmacy make the command resumable and idempotent. Immutable records are created only when absent; stock balances are projected from ledger movements. Sales have durable seed receipts in the audit log, so reruns do not duplicate sales, tenders, returns, refunds, or fills. Existing non-demo organizations occupying either slug cause refusal. A failed tenant transaction rolls back together; an already completed other tenant remains available for a rerun.

## Approval behavior

Operating mode is an organization policy, independent of feature entitlements. The seed enables the pharmacy modules and gives each account its role permissions and branch assignment. Owners retain #683 proprietor access; the staffed cashier receives only counter permissions.

SOLO self-approval requires the active system owner, #683's singleton-owner and branch eligibility, fresh PIN verification, and a transaction-bound audit record. Enroll the owner's operator PIN through the application before demonstrating approvals; the seed does not install a shared or default PIN. The password variables do not configure PINs.

STAFFED requires different maker and checker identities. Rx approvals require a pharmacist with dispensing permission. Overrides, discounts, returns/refunds, adjustments, writeoffs, transfers, and opening-stock sign-off require an owner or manager checker. Procurement approvals retain their explicit procurement permission requirement. A checker named by another actor must reauthenticate with their own PIN. The cashier cannot self-approve. Existing controlled-drug, branch, supplier, stock, margin, and refund-cap guards still apply.

Only the active system owner can change operating mode, with fresh PIN reauthentication in either direction (including an unchanged setting). Changes are audited, preserve staff accounts, and do not change module licensing. Selecting SOLO does not waive #683's singleton-owner requirement on document self-approval.

## Verification

`tests/demo-pharmacies-seed.db.test.ts` runs the seed twice against a disposable local database and checks persisted users/modes, 40 medicines and 80 batches per pharmacy, 30 sales days, Rx fills, discounts, returns/refunds, suppliers/POs, low-stock/expiry examples, password hashing, missing-secret refusal, and stable counts. `src/lib/pharmacy/operating-mode.db.test.ts` exercises the policy matrix with real PINs and RLS; the existing #683 regression suites cover audit rollback, stale evidence, lockout, branch restrictions, and roster races.

All names, clinical records, supplier evidence, and transactions are demo data and must not be used for real dispensing or financial reporting.
