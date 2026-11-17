# Counter scan and search performance (DEV-575)

Refs https://github.com/RealDevFathom/devfathom-commercial/issues/1147

Already on develop before this change (pull request 1643): exact tenant + barcode lookup
that bypasses fuzzy search, 150 ms typed-search debounce with stale-request cancellation,
no search per scanner digit, trigram/prefix name index and a 20-row result limit.

This change covers the remaining scope: before/after timings, the 300 ms target, 50 rapid
scans with no drops, and the client-side catalogue cache.

## Change

- **Local scan draft.** `CounterScanInput` keeps the field's draft locally, so a scanner
  digit no longer repaints the whole bill. Typed text still searches 150 ms after the last
  keystroke; a draft shorter than two characters returns the results panel to idle at once.
- **Catalogue cache.** `CounterCatalogueCache` holds at most 100 exact numeric OTC barcode
  rows per mounted counter, keyed by branch and code, for ten seconds from the original
  read. It never holds Rx, controlled, restricted, high-alert, LASA, blocked, out-of-stock,
  fuzzy or serialized rows. It is cleared on a branch or access change, unmount, and any
  refused or failed add, and debits stock after a confirmed add without extending its age.
  It is a lookup hint only: every add still goes to the server, which re-checks
  permission, restrictions and stock, allocates the lot and prices the line.
- **One operation per scan.** Develop derived the add-line idempotency key from the sale,
  medicine, unit and quantity, so a second scan of the same item into the same bill
  replayed the first allocation and was silently dropped. Each add now gets its own key,
  kept across an explicit retry of an uncertain add and discarded after a confirmed add.
- **Scans during a save are buffered, not dropped.** Develop disabled the field while a
  line was saving, so digits of the next scan were lost. The field now stays live while a
  line saves. Scanner digits typed meanwhile are kept (a completed add no longer clears or
  selects them), and a complete scan ending in Enter is queued and added in order through
  the normal barcode path once the save finishes. A human edit (a name, a cleared field)
  still cancels the pending scan as before. A repeated Enter on the code being saved is a
  duplicate press and is ignored. If a line is not added, the scans queued behind it are
  discarded and the notice says how many to scan again. A branch change discards them too.
  The field stays disabled for payment-recovery and other non-add busy states.

## Before/after timings

Fixture: `adds 50 consecutive digit bursts as distinct operations with one warm catalogue
lookup` in `src/components/pharmacy/counter/counter-console.test.tsx`. It renders the
real counter in jsdom with mocked tRPC, types each 13-digit code one digit at a time,
presses Enter and waits for the add to complete. The timing covers the first digit to the
completed component update (scan-to-cart in the component).

```sh
env -u DATABASE_URL -u MIGRATION_DATABASE_URL bunx vitest run \
  src/components/pharmacy/counter/counter-console.test.tsx \
  -t '50 consecutive digit bursts' --silent=false
```

"Before" is the same test run against `counter-console.tsx` from develop `44f119a`.
Two runs each, 2026-11-17, this cloud container:

| Metric (50 scans)                      | Develop (before)     | This change (after)  |
| -------------------------------------- | -------------------: | -------------------: |
| Scans whose add reached the server     | 50                   | 50                   |
| Distinct add operations (not replayed) | 1                    | 50                   |
| Barcode lookups                        | 50                   | 1                    |
| p95 scan-to-cart                       | 271.97 / 338.65 ms   | 131.32 / 101.69 ms   |
| Maximum scan-to-cart                   | 357.17 / 360.43 ms   | 142.97 / 105.41 ms   |

After the change every scan in the fixture completes under the 300 ms target; before it,
the p95 of one run and the maximum of both runs were over it. On develop only one of the
50 adds would have allocated stock, because the other 49 reused its idempotency key.

These are component timings with mocked transport. They exclude network, database and
browser paint, and no physical scanner was used. An end-to-end measurement against a
deployed develop environment with a real scanner still has to be made there.

## 50 rapid scans, no drops

`adds 50 rapid scans entered while earlier lines are still saving, in order, none
dropped`: the first scan's save is held open, the other 49 codes are typed digit by digit
and submitted while it is pending, then saves are released one at a time. All 50 codes
are looked up exactly once with every digit intact, all 50 lines are added in scan order
with 50 distinct operation keys, and the field is never disabled. On develop and on the
earlier pull request 1958 this test fails because the field is disabled during a save.

## Regression tests

`src/components/pharmacy/counter/counter-console.test.tsx` (DEV-575 block):

- 50 consecutive digit bursts as distinct operations with one warm catalogue lookup
- a failed add keeps its key for an explicit retry, and rotates it after success
- a refused add drops cached hints, and the next lookup reads current restrictions
- the field stays live while a line saves and never clears or selects a scan typed meanwhile
- 50 rapid scans entered while earlier lines are saving, in order, none dropped
- scans buffered behind a refused line are discarded with a notice
- a repeated Enter on the code being saved is a duplicate press
- results return to idle when the field is edited below two characters
- existing: 150 ms debounce with abort, no search per scanner digit

`src/lib/pharmacy/counter-catalogue-cache.test.ts`: expiry without renewal, alias debits,
response immutability, exhaustion, the five restriction flags, fuzzy/serialized/blocked/
out-of-stock exclusions, capacity, clearing, separate instances and branch isolation.

The existing barcode-safety tests (stale results, branch switch, unmount, edit during a
pending scan or sale create, GS1 recall, controlled authorization) pass unchanged.
