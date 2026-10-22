# Restaurant menus gap fixes — 2026-10-22

## Selection and verification

This follow-up addresses the three findings ranked **High** or **Medium** in
`docs/rgap-restaurant-menus-20261022.md` (findings 3–5). The two Critical findings are not part of
this requested High/Medium pass.

Before changing code, each selected finding was verified against the current branch:

1. **Finding 3 was present.** Publishing rejected only `PUBLISHED`, publication children could be
   changed without a draft-state guard, and deletion paths did not inspect their parent
   publication. No matching entry was found in `TICKETS.md`, `BUGS.md`, `docs/status-ledger.md`, or
   `scripts/.qa-gh-map.json`.
2. **Finding 4 was present.** `setItemOverride` was gated only by `menu:price`, accepted
   `isAvailable`, and defaulted omitted availability to `true`. No matching entry was found in the
   local issue mirrors listed above.
3. **Finding 5 was present.** The console converted the branch-local form value to a browser-local
   `Date`, the router accepted that instant, and the console rendered it through the browser
   timezone. No matching entry was found in the local issue mirrors listed above.

No selected finding was already fixed, so none was skipped. A live open-GitHub-issue check could
not be completed: this checkout has no GitHub remote and `gh issue list --state open --limit 100`
reported that GitHub CLI authentication is not configured. Consequently, local coverage was
verified, but private/unmirrored open-issue coverage cannot be guaranteed from this environment.

## Changes

- Publication transitions now accept only `DRAFT -> PUBLISHED` and `PUBLISHED -> RETIRED`, with the
  expected source status included in the update predicate. Channel, daypart, exception, and item
  override mutations reject non-draft parents, including child deletion paths
  (`src/server/routers/restaurant-menus.ts:646-891`).
- The console disables all publication-configuration controls unless the selected publication is a
  draft (`src/components/restaurant/menus/menus-console.tsx:1303-1578`).
- An availability change in the combined item override requires both `menu:price` and
  `menu:publish`. A price-only update retains the existing availability value rather than silently
  resetting it (`src/server/routers/restaurant-menus.ts:812-884`). The console likewise requires
  both permissions for its combined override editor
  (`src/components/restaurant/menus/menus-console.tsx:578-585,1490-1578`).
- Availability exception input is now a validated `YYYY-MM-DD` value, normalized to a UTC database
  date on the server and rendered directly as a calendar value without browser-timezone conversion
  (`src/server/routers/restaurant-menus.ts:85-96,140-142,756-788`;
  `src/components/restaurant/menus/menus-console.tsx:247-249,569-576,1449-1457`).
- Behavioral Vitest coverage exercises retired-publication rejection, published configuration
  immutability, price-only permission behavior, availability co-authorization, valid date
  normalization, invalid calendar dates, and read-only published controls
  (`src/server/routers/restaurant-menus.test.ts:296-516`;
  `src/components/restaurant/menus/menus-console.test.tsx:171-215`).

No schema migration was required.
