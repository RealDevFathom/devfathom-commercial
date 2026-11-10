# Auth and permissions

> Checked against `develop` at `1906b530`. Code: `src/lib/abac/`, `src/server/trpc.ts`, `src/lib/vertical-catalog.ts`, `src/lib/pharmacy/purchase-approval.ts`.

## 1. Two separate identity systems

| | Tenant users | Platform (SuperAdmin) users |
|---|---|---|
| Model | `User` (belongs to one `Organization`) | `PlatformUser` (no tenant) |
| Sign-in | next-auth on the tenant host (`/login`, `/api/auth/*`), optional SSO and SCIM | Separate login on the admin host (`/platform/login`), separate session (`PlatformSession`) |
| Second factor | TOTP is opt-in per user (`two-factor` router) | MFA enrolment is required at first sign-in; recovery codes are in `PlatformRecoveryCode` |
| Roles | Legacy `Role` enum (`ADMIN`, `EMPLOYEE`, `HR`) plus a tenant `OrganizationRole` with capability grants | `PlatformRole`: `SUPER_ADMIN`, `OPERATIONS`, `SALES`, `FINANCE`, `SUPPORT`, `AUDITOR` |
| Getting into a tenant | n/a | Only through an audited `PlatformSupportSession`. TODO(confirm): time limits and whether the tenant must consent. |

A platform session never works as a tenant session, and the reverse is also true.

## 2. Capabilities (ABAC)

- A **capability** is a `namespace:action` string, for example `pharmacy:counter` or `restaurant:pos`. Grants come from the user's `OrganizationRole` permissions plus per-user `permissionOverrides`, which can expire.
- A grant may be exact (`pharmacy:orders`), a namespace wildcard (`pharmacy:*`) or `*`.
- **Deny wins.** `can()` evaluates every matching rule, and any DENY beats any ALLOW. A wildcard DENY still revokes exact-only actions.
- **Exact-grant-only actions.** `EXACT_GRANT_ONLY_ACTIONS` in `src/lib/abac/capabilities.ts`:
  - `pharmacy:dispense`
  - `pharmacy:prescriptions`
  - `pharmacy:safety`
  - `pharmacy:catalogue-review`

  An ALLOW for one of these must name it exactly; **neither `*` nor `pharmacy:*` grants them**. A tenant admin with `*` can't dispense or sign off safety work unless they're given the exact capability too.
- **Owner access.** `hasAllCapabilityAccess` is true only for the system `owner` role, or for an `ADMIN` with a live `*` grant. The legacy `role === 'ADMIN'` flag on its own no longer counts.
- **Procedure builders** (`src/server/trpc.ts`): use `capabilityProcedure('ns:action')` for one capability, or `denyByDefaultProcedure` with `meta({ capabilities: [...] })`. A new procedure without a capability fails closed. **Don't add new `publicProcedure`s** for tenant or platform data. One exists today (`aiSettings.currentMonth`, listed in [known issues](known-issues.md)).
- **Module check.** Separately from capabilities, every tRPC path must map to a licensed module in `src/lib/module-catalog.ts`. When you add a router, add its module mapping.
- **Navigation follows access.** The pharmacy menu comes from the `pharmacyAccess` router (`src/server/routers/pharmacy-access.ts`), so a link only appears when the user's capabilities and modules admit the page.

## 3. Branch and property scope

Capabilities say *what* a user may do; scope says *where*.

- **Pharmacy:** active `PharmacyBranchAssignment` rows (helpers in `src/lib/pharmacy/branch-scope.ts`). Inventory, purchasing and transfers re-check the branch on every request. Owner and `*` admins are admitted to every branch. New tenants get a `MAIN` branch, and the bootstrap admin is assigned to it.
- **Restaurant:** `src/server/restaurant-branch-scope.ts`. **Hotel:** `src/server/hotel-property-scope.ts`.

## 4. Pharmacy role templates

`PHARMACY_ROLE_TEMPLATES` in `src/lib/vertical-catalog.ts` (around line 781). New pharmacy tenants also get `PHARMACY_SOP_TEMPLATE_GRANTS` (around line 874) so procedures work from day one.

| Template | Grants (summary) |
|---|---|
| Owner | `pharmacy:*`, both report capabilities, plus the exact `pharmacy:safety` |
| Owner / Operator (solo) | 12 exact grants, including `procurement-approve` |
| Pharmacist | `dispense`, `catalogue-review`, `close` |
| Manager | `manage`, `orders`, `procurement`, `procurement-approve` |
| Cashier | `counter`, `orders` |
| Procurement / Inventory / Finance / Auditor | one grant each |

Check the file for the exact lists; they change often.

## 5. Separation of duties (SoD)

These rules stop one person from both doing and approving the same regulated work. **Keep them when you change these areas, and add a test for each new rule.**

| Area | Rule | Where |
|---|---|---|
| **Dispense** | Prescription review, substitution and controlled-medicine supply need the exact `pharmacy:dispense` (or `pharmacy:prescriptions`) grant. A controlled-medicine sale needs a pharmacist's PIN and a prescription, or a recorded emergency-supply reason. Controlled register entries record a witness (`witnessedByUserId`). For a controlled purchase receipt, the witness must be the qualified person named on the receipt, checked by their PIN. TODO(confirm): whether the code refuses a witness who is the same person as the recorder. | `pharmacy-dispensing.ts`, `src/lib/pharmacy/controlled-register.ts`, `controlled-witnesses.test.ts`, `controlled-purchase-witness.test.ts` |
| **Safety** | Batch state changes (quarantine, release), recalls, price-notice confirmation and side-effect (PV) reporting need the exact `pharmacy:safety` grant. A `*` admin without it is refused. | `pharmacy-safety.ts`, `pharmacy-inventory.ts` (`regulatory`), `pharmacy-medicine.ts` (`priceNotices`, `confirmPrices`) |
| **Catalogue review** | Reference-connector proposals for the regulated catalogue are decided only with the exact `pharmacy:catalogue-review` grant (the Pharmacist template has it). | `pharmacy-medicine.ts` (`referenceConnectorProposals`, `decideReferenceConnectorProposal`) |
| **Purchasing** | Requester ≠ approver. A receipt that bypasses an approved PO must be approved by someone other than the receiver. | `purchase-approval.ts`, `receiving.ts` |
| **Solo-owner exception** | When the owner is the **only** active person at the branch, they may approve their own purchase or receiving bypass by re-entering their PIN. This is recorded with policy `PHARMACY_SOLO_OWNER_PIN`. An unqualified second staff member still counts as a person, so the exception switches off as soon as anyone else is active at the branch. | `soloOwnerApprovalAllowed()` in `purchase-approval.ts` |
| **Refunds** | Refunds need counter receipt access (`requireCounterReceiptAccess`). **Manager/owner PIN approval for refunds is a decision, not built.** | `pharmacy-sales.ts` (`refundTender`, `returnLine`) |

**Known SoD gap:** `pharmacyDispensing.decideReview` records the decision without checking that the decider is different from the person who queued the review (`requestedByUserId`). A pharmacist can verify or sign their own request. This is listed in [known issues](known-issues.md); don't copy the pattern.

## 6. Restaurant and hotel

Restaurant staff act through job roles and `restaurant:*` capabilities. Sensitive POS steps (voids, comps, refunds, cash) take an operator PIN (`src/lib/restaurant/operator-credentials.ts`). Hotel uses `hotel:*` capabilities plus property scope.

## 7. Never

- Never put credentials, tokens, SCIM secrets or demo logins in docs, code comments, tests or screenshots.
- Never widen `EXACT_GRANT_ONLY_ACTIONS` matching, or make `*` imply a regulated pharmacy action.
