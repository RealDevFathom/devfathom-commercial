# Pharmacy vertical — test plan

| Item | Value |
| --- | --- |
| Product | DevFathom Commercial, Pharmacy vertical |
| Branch | `qa/pharmacy-restaurants-agencies` |
| Commit | `fa3658b715bf2e672f7e38f983b558d8d86b5a75` |
| Build under test | Local VM, this commit, no product-code changes |
| Owner | QA (this pass). Fixes belong to another team. |
| Companion docs | `00-product-understanding.md`, `02-test-cases.md`, `03-execution-report.md` |

## 1. Objective

Prove or disprove that a super admin can onboard a pharmacy customer, that the customer can run a store from first login through a sale and the surrounding operations, and that a second tenant, a lesser role, and a revoked entitlement cannot see or change what they should not.

## 2. Scope

In scope:

- Platform control desk: create a PHARMACY organization, package selection, module grant and revoke, lifecycle activation, suspension.
- Tenant first login and the twelve-gate onboarding checklist.
- Branch and regulatory profile, users and roles, medicine catalog, inventory, batches and expiry, purchasing and suppliers, counter POS and billing, returns and refunds, discounts, customers (khata, loyalty, orders), reports, notifications and WhatsApp, settings.
- Permission and role isolation, multi-tenant leakage, input validation, empty / loading / error states, UI consistency with DevFathom Studio, mobile / tablet / desktop, keyboard and label accessibility, contrast smoke, copy, performance smoke, and security basics (unauthenticated API, IDOR, XSS, injection).

Out of scope:

- Restaurant, hospitality, and agency product journeys, except when they appear inside a pharmacy session.
- Live Meta WhatsApp, live cameras, Azure, payments providers, email delivery, and production data.
- Changing product code, migrations, or seeds. QA artifacts live only under `qa/pharmacy/`.

## 3. Environment

Recorded in `03-execution-report.md` after setup. Intended shape:

- PostgreSQL 16 on localhost, database `devfathom`, migrated with `prisma migrate deploy`, seeded with `bun run db:seed`.
- Application runtime role `devfathom_app`: `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, not the table owner, so forced RLS is actually in force. Migrations and seed run as the `postgres` superuser because they must create objects. The Next.js process uses the restricted role.
- Hosts: `admin.localhost` (control desk), `<slug>.localhost` (tenant). `/etc/hosts` maps the QA slugs.
- Browser: Playwright Chromium, desktop 1440×900, tablet 768×1024, mobile 390×844.
- Platform MFA stays at the product default (`PLATFORM_MFA_ENFORCE` unset, so super-admin enrollment is required) unless setup cannot complete enrollment. Any relaxation is recorded as an environment deviation, not as a pass.
- WhatsApp, email, Ably, and cameras are unconfigured. Expected behavior is a clear unavailable state, not a silent success.

## 4. Approach

1. Read the product (done in `00-product-understanding.md`) before writing cases.
2. Bring the stack up. A failure to migrate, seed, or boot is a defect or a setup blocker, filed either way.
3. Execute cases in `02-test-cases.md` through the browser and through HTTP calls against the running server. No case is marked passed from code reading alone.
4. Evidence is a screenshot, a response status, or a quoted UI string, stored under `qa/pharmacy/evidence/`.
5. Every failed case becomes a GitHub issue if one does not already exist. Title: `[QA][Pharmacy][SEV] short summary`. Labels: `qa`, `pharmacy`, severity, plus `ux`, `security`, or `a11y` when they apply.

Order of execution:

1. Setup and boot smoke.
2. Super-admin create, wrong-vertical package rejection, module list.
3. Tenant first login, empty states, onboarding gates.
4. Regulatory profile, users and roles.
5. Catalog, stock, batches, expiry.
6. Supplier, purchase, receive.
7. Counter sale, discount, customer, return.
8. Reports, finance, marketing, WhatsApp, settings.
9. Second role and second tenant.
10. Revoke module and suspend organization.
11. API authz, IDOR, XSS, injection.
12. Responsive, keyboard, contrast, copy, performance smoke.

## 5. Priorities

| Priority | Meaning | Release effect |
| --- | --- | --- |
| P0 | Cannot onboard, cannot sign in, data crosses tenants, money or stock is wrong, authz bypass | Blocks a pharmacy release |
| P1 | A primary journey step fails or a role can do another role’s work | Blocks unless the product owner accepts the gap in writing |
| P2 | Validation, empty/error states, secondary surfaces | Ship with a known-issue list |
| P3 | Copy, spacing, minor contrast, polish | Does not block |

## 6. Pass / fail rules

- **Pass** — observed result matches the expected result in the case, with evidence.
- **Fail** — observed result contradicts the expected result. File an issue.
- **Blocked** — a prior defect or a missing environment dependency prevents the step. Name the blocker. Blocked is not a pass.
- **Gap** — the product documents the behavior as not built (six attested gates, camera simulator, WhatsApp stub). Pass only if the UI says so honestly. Fail if the UI claims the work happened.

A flaky result is rerun once. If it flakes again it is a fail.

## 7. Data

| Actor | How created | Used for |
| --- | --- | --- |
| Platform super admin | Seed from `PLATFORM_ADMIN_EMAIL` | All control-desk cases |
| Clifton Chemist admin | `organization.create`, slug `qa-clifton`, Pharmacy Professional | Primary tenant |
| Clifton cashier | Invited or created in the tenant with the cashier template | Role isolation |
| Rival Pharmacy admin | Second organization, slug `qa-rival` | Leakage and IDOR |
| Disposable strings | `<script>alert(1)</script>`, `' OR 1=1 --`, 300-character names, emoji, Urdu text | Validation and XSS |

No production customer data. Passwords stay in `.env.local` and are not copied into the report.

## 8. Oracles

- UI copy and status pills on the screen after a reload (not only the toast).
- Database rows read with the restricted role and the tenant GUC set, to confirm what the UI claimed.
- HTTP status and JSON body for API cases. Unauthenticated calls must not return another tenant’s objects.
- A second browser context is a second user. Cookies are not reused across tenants.

## 9. Risks to the test itself

- Next.js 16 dev mode blocks the React debug channel unless the origin is in `allowedDevOrigins` (`next.config.ts`, currently only `127.0.0.1`). If `admin.localhost` does not hydrate, QA switches to `next start` or records a setup blocker. Product source is not edited to widen the allowlist.
- Activation needs all twelve gates. Six are attestation-only. The test attests them through the product UI when the UI allows it, and does not write gate rows by hand to fake a pass.
- Punjab jurisdiction rules may be unconfirmed (`RULE_SET_UNCONFIRMED`). Activation may legitimately refuse. That is a pass for the guard and a product gap for a go-live pharmacy.
- Dot capabilities versus colon ABAC actions may make non-admin roles look broken. That is a product defect if the role template is what the UI offers.
- Memory on this VM is limited. A failed production build is recorded; it is not “fixed” by skipping typecheck in product config.

## 10. Entry and exit

Entry: this commit checked out, PostgreSQL reachable, dependencies installed.

Exit: every case in `02-test-cases.md` has a status in `03-execution-report.md`, every fail has an issue link or an explicit duplicate, evidence is committed under `qa/pharmacy/`, and the branch pushed is `qa/pharmacy-restaurants-agencies` only.

## 11. Release recommendation rule

Recommend **no** for a first pharmacy customer if any open P0 exists, or if the super-admin → first sale path cannot be completed in the UI. Recommend **conditional** if that path completes and remaining issues are P1 with workarounds. Recommend **yes** only if P0 and P1 are clear and P2/P3 are listed.
