# Authentication, roles and permissions

> **Audience:** engineers and coding agents, especially anyone touching pharmacy dispensing, safety or catalogue review.
> **Based on:** `origin/main` @ `16a2a370` (2026-10-22) and CTO answers from 2026-10-22.
> Related: [architecture.md](./architecture.md) · `docs/security/separation-of-duties.md` (PR 5)

DevFathom has two separate identity systems: **tenant users**, who work inside an organization, and **platform staff**, who run the DevFathom platform. Fine-grained access for tenant users goes through **ABAC capabilities**.

---

## 1. Tenant users

- Auth: next-auth 5 (beta). Route handlers live in `src/app/api/auth`, `api/sso` and `api/scim`.
- Model: `User`, with the enum **`Role` = `ADMIN` | `EMPLOYEE` | `HR`**.
- Fine-grained permissions come from the ABAC layer (section 3): `OrganizationRole`, `RolePermission` and `UserPermissionOverride`.
- Supporting features: invitations, password reset, two-factor (`two-factor` router; TOTP is required at sign-in only once a user has enabled it, so it is off by default), SSO and SCIM provisioning. SCIM token rotation is documented in `docs/security/scim-token-rotation.md`.

The coarse `Role` only feeds the static policies in `src/lib/abac/policies.ts` (for example `admin:access` is `ADMIN`-only; `hr:access` is `ADMIN` or `HR`). Vertical capabilities (`pharmacy:*`, restaurant, catering and so on) have empty static policies (`[]`) and come only from an organization role or a per-user override. `ADMIN` gets no default capability set for them.

## 2. Platform staff

- Separate model and session: `PlatformUser`, **`PlatformSession`** (distinct from tenant sessions).
- Enum **`PlatformRole` = `SUPER_ADMIN` | `OPERATIONS` | `SALES` | `FINANCE` | `SUPPORT` | `AUDITOR`**.
- 2FA with recovery codes.
- **Support impersonation:** `PlatformSupportSession`. TODO(confirm): what is audited, its time limits, and whether tenant consent is required.
- UI: `/platform` (organizations, operators, catalog, commercial, audit, health). Actions are logged to `PlatformAuditLog`.

TODO(confirm): the permission matrix per `PlatformRole`.

## 3. ABAC capabilities

Capabilities are strings such as `pharmacy:dispense`. The engine is `can(subject, action, resource?, { db })` in `src/lib/abac/index.ts`. In a tRPC router, use `capabilityProcedure('<action>')` from `src/server/trpc.ts`. (`src/server/authz.ts` holds resource-level helpers such as `assertProjectAccess`, not capability checks.)

- Action catalogue and static policies: `src/lib/abac/policies.ts` (default-deny).
- Grant matching and exact-grant-only actions: `src/lib/abac/capabilities.ts`.
- Grants are exact actions, `*`, or a namespace wildcard like `pharmacy:*`.
- Organization role templates per vertical: `src/lib/vertical-catalog.ts` (marked provisional).

### Evaluation order (on `main` today)

`can()` first checks the user's organization grants (`customDecision`, `src/lib/abac/index.ts:49-57`) and stops at the first rule that matches:

1. a per-user **DENY** override → deny
2. a per-user **ALLOW** override → allow
3. an organization-role **DENY** → deny
4. an organization-role **ALLOW** → allow
5. none of these → fall through to the static policies in `policies.ts`; if none returns true, deny.

So a per-user ALLOW beats a role DENY. Only a per-user DENY is guaranteed to revoke. Expired overrides are ignored. TODO(confirm): this order may change when `fix/abac-deny-precedence` lands.

### Restaurant capabilities

Restaurants have their own model: `RestaurantJobRole` / `Capability`, **`StaffCapabilityGrant` (audited)**, operator credentials, registered devices, and co-authorization for sensitive actions. TODO(confirm): how this relates to the organization-level ABAC.

## 4. Pharmacy separation of duties

Three pharmacy capabilities are in **`EXACT_GRANT_ONLY_ACTIONS`** (`src/lib/abac/capabilities.ts`):

| Capability | Covers | Enforced in router |
|---|---|---|
| `pharmacy:dispense` | Pharmacist decisions, substitution evidence and dispensing | `pharmacy-dispensing`, `pharmacy-prescriptions` |
| `pharmacy:safety` | Controlled-drugs register: view, corrections, register-incident approval, inspection packs, retention class and legal holds | `pharmacy-safety` |
| `pharmacy:catalogue-review` | Confirm or reject regulated connector proposals for the medicine catalogue | `pharmacy-medicine`, `pharmacy-staged-review` |

### The rules

1. **No default policy grants them.** Their static policies in `policies.ts` are `[]`, so no coarse `Role`, including `ADMIN`, gets them.
2. **Wildcards never grant them.** Neither `*` nor `pharmacy:*` ALLOWs any of the three (`capabilities.ts:24`). Only an exact grant of the exact string does. A wildcard **DENY** does revoke them (`capabilities.ts:23`).
3. **Role templates can include them, by exact name.** In `src/lib/vertical-catalog.ts` (`PHARMACY_ROLE_TEMPLATES`, provisional):
   - **Pharmacist:** `pharmacy:dispense`, `pharmacy:catalogue-review`.
   - **Owner / Operator** (optional, explicitly assigned): all three.
   - **Owner** (`pharmacy:*`) and all other templates: none of the three.

   A template is a role the org assigns on purpose, so this does not contradict rule 1.
4. **One person may hold all three.** A single-pharmacist shop must work, so this must not be blocked.
5. **Each capability is checked on its own.** Holding one never implies another. (The `controlledPharmacists` lookup in `pharmacy-safety` accepts `safety` or `dispense`.)
6. **DENY behaviour follows the evaluation order above.** It is not final. Don't write code that depends on it until `fix/abac-deny-precedence` lands. TODO(confirm).

### For developers

- Never add these three to a wildcard expansion, an "all permissions" helper or an admin default.
- A new endpoint that dispenses, writes to the controlled register or publishes catalogue changes must check the **exact** capability in its router.
- Add tests that prove: no wildcard grants it, `ADMIN` alone lacks it, an exact grant works, a wildcard DENY revokes it, and one user can hold all three.

> Controlled-register and DRAP regulatory behaviour shown to users is **DRAFT – pending legal review**. This page describes only the access-control mechanics.

## 5. Tenant isolation is not authorization

ABAC decides *what* a user may do. **RLS** decides *which organization's rows* the database will return at all. Both apply. See [architecture.md § Multi-tenancy](./architecture.md#multi-tenancy-and-rls).

## 6. Secrets

Never put credentials, tokens, SCIM secrets or demo logins in docs, code comments, tests or screenshots.
