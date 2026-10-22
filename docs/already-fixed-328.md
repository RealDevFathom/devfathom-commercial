# GitHub issue #328 is already fixed

Issue #328 reported that the controlled-actor integration fixture granted the legacy dotted
`pharmacy.dispense` capability, so the pharmacist case was rejected before reaching the actor
check. The current tree already contains the fix:

- `src/server/routers/pharmacy-sales.controlled-actor.test.ts:108-119` now gives the pharmacist
  fixture the canonical, exact `pharmacy:dispense` grant and verifies that it gets past the actor
  check without invoking a witness credential or adding the sale line.
- `src/lib/abac/capabilities.ts:1-14` documents and enforces the intended contract: malformed or
  legacy grants are not normalized during authorization, and `pharmacy:dispense` is an
  exact-grant-only action.
- `src/lib/abac/capabilities.test.ts:42-64` explicitly verifies that `pharmacy.dispense` is ignored,
  while `src/lib/abac/capabilities.test.ts:97-121` verifies exact grants and DENY-over-ALLOW
  wildcard revocation for sensitive pharmacy actions.

The stale fixture was corrected by commit `8ed640780d62b417f22f7ada0a1224cde119c980`; no production
authorization change is required.
