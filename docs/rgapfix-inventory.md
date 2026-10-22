# Restaurant inventory gap follow-up — 2026-10-22

## Verification and issue deduplication

The three highest-impact High/Medium findings in `docs/rgap-restaurant-inventory-20261022.md`
(findings 2–4; the Critical finding was outside the requested severity set) were verified against
current code before implementation:

1. **Finding 2 was present.** The Inventory page checked only `inventory:read` and
   `inventory:count` and exposed no form for the existing wastage or sale-reversal mutations.
2. **Finding 3 was present.** Transfer procedures existed, while the page only rendered transfer
   rows and did not expose create, add-line, or completion actions.
3. **Finding 4 was present.** The router's shared quantity schema accepted every non-empty string,
   including negative, zero, and non-decimal movement quantities.

No matching issue reference was found in repository documentation or source. Live GitHub
issue deduplication could not be completed: this checkout has no Git remote and `gh issue list`
reported that GitHub CLI is unauthenticated. Therefore none of the three findings was skipped, but
this document does not claim exhaustive live-issue deduplication.

## Changes

- `src/app/(app)/restaurant/inventory/page.tsx:109-115` now evaluates `inventory:adjust` and
  `inventory:waste` in addition to the existing read/count capabilities.
- `src/app/(app)/restaurant/inventory/page.tsx:280-369` adds server actions for wastage,
  sale reversals, and the complete transfer lifecycle; every write still passes through the
  capability-gated inventory router.
- `src/app/(app)/restaurant/inventory/page.tsx:543-659` adds permission-aware forms for wastage,
  spoilage, staff meals, and sale reversals.
- `src/app/(app)/restaurant/inventory/page.tsx:926-1081` adds permission-aware transfer creation,
  draft line entry, and completion controls alongside the transfer history.
- `src/server/routers/restaurant-inventory.ts:49-54` defines canonical non-negative and positive
  decimal quantity schemas. Counts and thresholds accept zero; transfers, wastage, and sale
  reversals require a value greater than zero at the API boundary.
- `src/server/routers/restaurant-inventory.test.ts:315-359` adds behavioral coverage proving that
  invalid count and movement quantities are rejected before domain mutation services run.

No migration was required.
