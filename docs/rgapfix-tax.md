# Restaurant tax static-gap follow-up

Date: 2026-10-22  
Branch: `fix/followup-rgap-tax`

## Verification and issue exclusion

The three highest-ranked **High/Medium** findings in
`docs/rgap-restaurant-tax-20261022.md` are findings 2, 3, and 4. Each was rechecked against the
branch before implementation:

1. **Curated preset replacement (High) — verified, not already fixed.** The activation input did
   not accept a replacement choice and the curated publication call did not pass
   `replaceOpenProfile`, although the shared publisher already supported atomic replacement.
2. **Service-charge administrator flow (High) — verified, not already fixed.** Publish/end router
   commands existed, but configuration did not return policies and the restaurant tax console had
   no service-charge controls or policy history.
3. **Curated effective-date timezone (Medium) — verified, not already fixed.** The browser created a
   UTC-midnight timestamp and curated activation used that instant directly instead of resolving
   the selected date at midnight in the selected branch timezone.

No Git remote is configured in this checkout, so a live GitHub open-issue query is unavailable.
The local `.github` and `docs` issue references were searched for restaurant-tax, service-charge,
curated-preset, and timezone matches; none documents an open issue covering these three findings.
Accordingly, no finding was skipped.

## Changes

- **Curated replacement:** Added `replaceOpenProfile` to the curated activation contract and its
  idempotency payload, exposed the atomic-replacement checkbox, and passed the choice to the shared
  lock-serialized publisher (`src/server/routers/restaurant-tax.ts:54-62,111-120,501-526`;
  `src/components/restaurant/restaurant-tax-console.tsx:195-210,365-383`).
- **Service-charge administration:** Added tenant-scoped policy history to configuration and a
  complete publish/replace/end flow in the tax console, with separate retry-safe idempotency keys
  (`src/server/routers/restaurant-tax.ts:123-195,233-270`;
  `src/components/restaurant/restaurant-tax-console.tsx:74-117,153-185,386-504`). Policy lookups
  and updates also explicitly bind organization and branch identity
  (`src/lib/restaurant/service-charge-policy.ts:85-126,136-184`).
- **Branch-local dates:** Curated tax activation and service-charge commands now accept calendar
  dates and resolve midnight using the tenant-owned branch timezone; the UI sends the selected date
  without browser/UTC reinterpretation (`src/server/routers/restaurant-tax.ts:23-37,54-62,126-179,
  443-525`; `src/components/restaurant/restaurant-tax-console.tsx:161-184,195-210,421-429`).
- **Central authorization and isolation:** All tax reads, previews, and mutations use the central
  `capabilityProcedure('restaurant:configure')`, retaining central `can()` evaluation (including
  DENY-over-ALLOW), while branch commands retain `requireRestaurantBranchScope` and reads include
  explicit organization predicates (`src/server/routers/restaurant-tax.ts:20-22,123-197,233-273,
  384-443`).

Per request, no dependency installation or test command was run.
