# Fix #299 verification notes

## Authorization behavior

- The Cashier system template grants the canonical `pharmacy:counter` capability
  (`src/lib/vertical-catalog.ts:797-800`).
- The Pharmacist system template intentionally grants the regulated,
  exact-grant-only `pharmacy:dispense` capability
  (`src/lib/vertical-catalog.ts:784-788`; `src/lib/abac/capabilities.ts:7-14`).
- Counter authorization treats dispense, receipt, counter, and their retained
  legacy dotted spellings as one access family
  (`src/server/routers/pharmacy-sales.ts:299-330`). Any matching `DENY` is
  evaluated before an `ALLOW`, including across user overrides and role rules
  (`src/server/routers/pharmacy-sales.ts:404-416`).
- Non-Khata tender still passes through central `can()` checks. The accepted
  central grants are canonical `pharmacy:counter` for Cashier and exact
  `pharmacy:dispense` for Pharmacist
  (`src/server/routers/pharmacy-sales.ts:363-379`). Tenant membership and active
  branch assignment are then checked before access
  (`src/server/routers/pharmacy-sales.ts:381-430`).

## Focused regression coverage

- The canonical Cashier grant is exercised against receipt, cart, return
  history, CASH, and CARD paths
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:324-356`).
- The restored Pharmacist assertion exercises cart, receipt, return history,
  CASH, and CARD using only the template's exact dispense grant
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:358-385`).
- A focused regression proves that an explicit counter-family `DENY` defeats the
  Pharmacist dispense `ALLOW` before settlement is invoked
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:387-406`).

## Validation constraints

Per the issue instructions, dependencies were not installed and the test suite
was not executed in this no-database/npm-403 environment. Validation was limited
to static inspection and repository checks such as `git diff --check`.
