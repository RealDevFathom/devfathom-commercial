# Pharmacy procurement authorization verification

## Behavior

- Purchasing mutations require procurement permission. A user or role DENY wins across the canonical and retained legacy procurement aliases.
- Branch operations require an active branch in the session tenant and an active staff assignment. The branch of an existing order, requisition, quote, receipt, or supplier link is checked from the stored record. Omitting a new order's optional branch cannot bypass checks on linked demand.
- Authenticated supplier-link relationship creation, issuance, revocation, manual evidence, and proposal decisions require the same procurement and branch authorization. External supplier token flows retain their existing access protocol.
- Tenant ADMIN and trusted system owner/owner-operator roles retain all capabilities unless explicitly denied. A custom role merely named owner gets no implicit authority. Owners receive assignments to existing and newly created branches, including after role/status changes; purchasing checks also repair their assignments.
- A maker may decide their own purchase order only as the sole ACTIVE owner in its tenant or branch, after fresh PIN verification against their own active staff profile. Unassigned active staff count against the exception; staff exclusively assigned elsewhere do not. Revoked, locked, missing, or incorrect PINs fail. A shared five-attempt/15-minute limiter survives approval rollback.
- Multi-staff approval requires a different authorized actor, who cannot be the order creator or requisition requester. Sole-owner decisions record a named approval policy and an audit entry in the approval transaction. The database replacement for the creator check requires same-transaction audit/credential evidence and independently checks sole-owner staffing. Other purchase-order constraints remain enforced.
- The order screen shows eligible sole owners a masked PIN field through existing purchasing form controls. Other makers retain the second-person message. A typed SELF_APPROVAL denial from the rolled-back approval transaction returns a retryable PIN error; generic or unknown write failures retain the existing outcome lock. PIN input is excluded from approval audit payloads and redacted globally even on validation/authentication failures.

## Test execution

The local supplied DATABASE_URL was privileged. A temporary local LOGIN role was created with NOSUPERUSER/NOBYPASSRLS and removed after each run. The wrapper below passes that restricted connection as DATABASE_URL, TEST_DATABASE_URL, M8_TEST_RUNTIME_DATABASE_URL, and WHA1316_RUNTIME_DATABASE_URL, and passes the local migrator connection separately. No connection values or credentials are printed.

Exact regression command:

```sh
node /tmp/w-h3-run-security-tests.cjs \
  tests/pharmacy-procurement-security.db.test.ts \
  src/server/routers/pharmacy-purchasing.test.ts \
  src/lib/pharmacy/procurement-access.test.ts \
  src/lib/abac/index.test.ts \
  src/lib/abac/capabilities.test.ts \
  src/server/audit.transaction.test.ts \
  src/lib/pharmacy/purchasing.test.ts \
  src/lib/pharmacy/purchasing.db.test.ts \
  src/lib/pharmacy/purchasing-console.test.ts \
  src/lib/pharmacy/central-purchasing.test.ts \
  tests/pharmacy-supplier-links.db.test.ts \
  tests/pharmacy-supplier-links-migration.test.ts \
  'src/app/(app)/pharmacy/purchasing'
```

Result: **18 files, 367 tests passed, zero skipped**. This includes existing purchasing arithmetic, transition, database constraint, RLS, supplier-link, receiving, returns, and UI lifecycle checks, plus the new authorization regressions.

Typecheck command:

```sh
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
```

Result: passed. The default 4 GB Node heap was insufficient for this repository after Next generated its route types.

The changed TypeScript/TSX files were checked with `npx eslint` and `npx prettier --check`; `git diff --check` also passed.

Production build command:

```sh
node /tmp/w-h3-build.cjs
```

The wrapper executes `NODE_OPTIONS=--max-old-space-size=8192 next build --webpack` with an ephemeral AUTH_SECRET supplied only in the child environment. No repository environment files are changed.

The standard Turbopack build could not resolve Next through this workspace's linked node_modules. Webpack is used without changing repository build settings or skipping TypeScript checks.

Result: **production build passed**, including full TypeScript checking, generation of 213 static pages, optimization, tracing, and standalone output. The initial no-secret attempt was rerun with the ephemeral build secret; no validation was disabled.

## Browser and visual QA

Exact browser command:

```sh
node_modules/.bin/tsx --tsconfig tsconfig.json /tmp/w-h3-security-visual-qa.ts
```

The script starts the production standalone server with an isolated local pharmacy, a restricted database role, an ephemeral session secret, and an explicit local client-IP header setting. Secrets stay in memory. It removes the temporary runtime role and stops the server when finished.

| Contract check            | Result                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 375, 768, 1024, 1440 px   | Passed                                                                                                                                     |
| Light and dark themes     | Passed                                                                                                                                     |
| Normal and reduced motion | Passed; all 16 width/theme/motion combinations                                                                                             |
| Keyboard                  | PIN and decision controls reachable; tab order and visible focus verified; Escape does not disrupt the form                                |
| Layout                    | No document horizontal overflow; existing Studio shell, cards, controls and semantic tokens retained                                       |
| States                    | Default and empty content, pending/loading, disabled buttons, inline invalid-PIN error, retry, committed success, multi-staff maker denial |
| Destructive action        | Existing Reject variant retained; no new destructive confirmation interaction introduced                                                   |
| Console                   | No hydration, render, accessibility or client-fetch console errors in the visual matrix                                                    |
| Product parity            | Existing tenant Studio shell and form vocabulary reused                                                                                    |

Screenshots were captured in `/tmp/w-h3-security-visual-qa/`; mobile dark/reduced-motion and desktop light screenshots were inspected. The loading/disabled, invalid-PIN, and multi-staff maker-denied states were also captured.

Live browser flows passed:

1. Submit an incorrect PIN: approval is rejected, the error is visible beside the PIN, and retry remains available.
2. Re-enter the correct fresh PIN: the sole owner's order is approved and the separate solo-owner audit entry exists without plaintext PIN.
3. Add another active assigned procurement staff member: the maker sees the second-person requirement and no self-approval control.
4. Switch to that second staff member: ordinary approval succeeds, is attributed to that person, and does not use the solo-owner exception.

No Azure-related files were changed. No tests were removed, weakened, or skipped in the verification runs.
