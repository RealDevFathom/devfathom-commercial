# Restaurant delivery gap fixes — 2026-10-22

## Verification and issue deduplication

The three highest-impact findings in `docs/rgap-restaurant-delivery-20261022.md` were checked against the current branch before implementation.

The repository has no configured Git remote (`git remote -v` returns no entries), so a live GitHub issue search cannot be associated with this checkout. The repo-local issue ledgers (`BUGS.md`, `TICKETS.md`, `ENHANCEMENTS.md`, `IMPROVEMENTS.md`, `FIXES.md`, and `status.md`) were searched and contain no matching open item. None of the three findings was therefore skipped as already fixed or tracked; maintainers should still perform remote issue deduplication if this checkout is later associated with a GitHub repository.

## Findings and resolution

1. **High — zone deactivation was irreversible: verified and fixed.** Before this change, the server exposed only `deactivateZone`, the domain helper could only write `active: false`, and inactive rows had no recovery action. A tenant-and-branch-scoped `reactivateDeliveryZone` helper was added (`src/lib/restaurant/delivery.ts:133-142`), exposed through the centrally capability-protected and audited router mutation (`src/server/routers/restaurant-delivery.ts:190-203`), and connected to an explicit confirmation flow for inactive rows (`src/components/restaurant/delivery/delivery-console.tsx:353-370,481-524`). Behavioural coverage verifies scoped persistence, authorization/audit delegation, and the confirmed UI operation (`src/lib/restaurant/delivery.test.ts:106-120`; `src/server/routers/restaurant-delivery.test.ts:169-215`; `src/components/restaurant/delivery/delivery-console.test.tsx:220-238`).

2. **Medium — unchecking the current default address falsely appeared to work: verified and fixed.** The update helper intentionally has no valid transition to a state with no default address, but the edit form previously presented the current default as an ordinary checkbox. The current default is now visibly checked but disabled, with an explanation directing the operator to make another address the default (`src/components/restaurant/delivery/delivery-console.tsx:746-760`). A behavioural test verifies that the misleading uncheck action is unavailable (`src/components/restaurant/delivery/delivery-console.test.tsx:266-288`).

3. **Medium — set-default API had no UI flow: verified and fixed.** The existing narrow `setDefaultAddress` mutation is now wired into the console, included in pending/error/success handling and list invalidation (`src/components/restaurant/delivery/delivery-console.tsx:118-162`), and exposed as **Make default** only on non-default address cards (`src/components/restaurant/delivery/delivery-console.tsx:431-443`). The action submits only the selected customer and address identifiers rather than resubmitting PII; behavioural coverage verifies that exact payload (`src/components/restaurant/delivery/delivery-console.test.tsx:240-264`).

## Scope notes

- No schema or migration change was needed.
- Tenant and branch predicates remain mandatory for zone state changes.
- Every new server mutation continues to use the central `restaurant:configure` capability procedure and branch-scope check.
- The fourth, lower-ranked customer-pagination finding is outside this top-three change.

## QA follow-up — 2026-10-31

- Give **Make default** its own success handler so a delayed response refreshes saved addresses and reports success without closing an unrelated editor or confirmation. Regression tests cover unsaved input in both Edit and Add address forms.
- Allow saved-address actions to wrap so all three buttons remain inside the card at 320px.
- Validation: all 65 tests across the delivery console, domain, and router passed. A Chromium component harness using the real console, shared components, and global styles with mocked data passed 20 combinations of 320/375/768/1024/1440px, light/dark themes, and normal/reduced motion. Checks covered bounded action rows, no canvas overflow, keyboard focus trapping/restoration and Escape, delayed Make default responses preserving Edit/Add drafts, loading/empty/error/denied states, and destructive confirmation. No page errors occurred. These checks do not replace authenticated end-to-end or database-backed validation.
