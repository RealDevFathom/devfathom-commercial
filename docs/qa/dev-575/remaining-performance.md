# Counter performance remaining-scope evidence

Ticket: https://linear.app/devfathom/issue/DEV-575

Refs https://github.com/RealDevFathom/devfathom-commercial/issues/1147

Original baseline: `37afe6d570527a893aabae8e4460751603999db8`.
Recovery base: `6198264f66aa285ba998c4e7a773d0a5b7087be2` (freshly fetched `origin/develop`).
Date: 2026-11-17. Automated software validation; no human QA or hardware sign-off.

## Change

- Keep scanner drafts in the existing shared Input locally, so each digit does not repaint the bill. Typed searches still debounce for 150 ms; stale lookup cancellation, branch admission and GS1 authentication remain in place.
- Keep at most 100 exact numeric OTC barcode hints in the mounted operator's memory, for ten seconds from the original read. Clear on branch/access/unmount changes and on refused/failed adds. Never cache restricted, controlled, high-alert, LASA, blocked, unavailable or serialized rows. Debit aggregate availability after confirmed adds without extending expiry; exhausted hints fetch again.
- Every add still reaches the existing authenticated server mutation, which re-reads medicine restrictions, authorizes the branch/operation, allocates stock and prices the sale. Hints do not create cart lines or authorize a transaction; normal cart and search invalidations remain.
- Keep an operation key across an explicit retry of an uncertain add, and discard it only after confirmed success. A subsequent scan receives a new key rather than replaying the preceding allocation. Keys are short opaque UUIDs; no catalogue IDs are embedded.
- Always use the resolved scan row, including refreshed restrictions, instead of the previously staged selection.

## Before/after local fixture

Reproduction (Bun 1.4.2, Node 24.22.1):

```sh
bunx vitest run src/components/pharmacy/counter/counter-console.test.tsx -t '50 consecutive digit bursts' --reporter=verbose
```

The test renders the real counter console and input in jsdom with synthetic catalogue data and mocked tRPC reads/mutations. Each scan enters all 13 digits individually, asserts the complete code, presses Enter, awaits the add, and asserts the field cleared and one additional mutation occurred. `performance.now()` covers the first digit through the completed component update. The next burst starts immediately after that update. The fixture records operation keys, not real database commits.

| Metric | Unchanged base (negative control) | Candidate |
| --- | ---: | ---: |
| Completed digit bursts | 50 | 50 |
| Distinct allocation operation keys | 1 | 50 |
| Explicit catalogue lookups | 50 | 1 |
| p95 first-digit-to-completed-component-update | 614.02 ms | 233.84 ms |
| Maximum first-digit-to-completed-component-update | 825.93 ms | 291.05 ms |

Negative control: the new 50-scan regression on unchanged base failed `expect(keys.size).toBe(50)` with actual `1`. The candidate passes the same assertion and the single-lookup assertion. The candidate's measured maximum is under 300 ms in this fixture; runtime timing is reported rather than asserted as a scheduler-dependent unit-test deadline.

The before/after numbers are local component measurements, not database/network/browser-paint measurements. No physical scanner was used. The test does not claim that a burst entered while a previous write is pending is buffered: the existing busy-input and pending-lookup replacement behavior remains.

## Regression evidence

`src/components/pharmacy/counter/counter-console.test.tsx`:

- `adds 50 consecutive digit bursts as distinct operations with one warm catalogue lookup`
- `keeps a failed allocation key for an explicit retry, then rotates it after success`
- `drops warm catalogue hints after a refused write and reads current restrictions on retry`
- Existing 150 ms debounce, no per-digit search, duplicate Enter, stale-result cancellation, branch switch, controlled authorization and recalled GS1 cases remain intact.

`src/lib/pharmacy/counter-catalogue-cache.test.ts`: ten tests cover exact TTL, no TTL renewal on sale, alias debits, response immutability, exhaustion, five restricted-product flags, fuzzy/serialized/blocked/unavailable exclusions, capacity, clearing and separate instances.

`src/lib/pharmacy/counter-search-latency.test.ts`: existing exact tenant barcode and concurrent fuzzy lookup tests remain intact.

Original focused verification: **283 tests passed in 3 files**. Current recovery verification is recorded below. The five full checks are deferred to serialized quiet landing under the latest owner instruction; no full-suite or build pass is claimed for the recovered head.

## Remaining acceptance gates

- Measure authenticated end-to-end scan-to-cart including server/database latency and browser paint against develop; this fixture does not establish that environment's 300 ms target.
- Run 50 native keyboard scan bursts against that integrated local/develop fixture, including the agreed arrival cadence. The current test covers consecutive bursts after each completed add, not overlapping writes.
- Complete relevant browser interaction/viewport checks and automated review before landing. The component retains the same shared Input, semantic styling, label, focus ref and disabled state; no visual layout was changed.
- A pharmacy E2E database/application was not configured for this run (`PHARMACY_E2E_DATABASE_URL` is absent). No deployment, production access, hardware acceptance, PR merge, issue closure or Linear completion is part of this change.

Use Refs, not Fixes: full ticket acceptance is still open.


## Focused recovery and draft publication

The latest GitHub issue and Linear comments still identify timings, the 300 ms target,
50 scans, and catalogue caching as remaining scope. Inspection of the freshly fetched
base confirmed it still reused the old allocation key and lacked this barcode cache.
The original implementation commit `e75d57b3378df1534d1e3a0c3e21500bad30ca88`
was preserved and develop integrated into the existing task branch with merge commit
`050817d55a0f8a4706e17da81d812fff3a32e4b7`. The single scan-input conflict
retains both the new disabled-control description and local draft handling. The diff
against the recovery base preserves existing assertions, timeouts and permission gates.

Focused command:

```sh
env -u DATABASE_URL -u MIGRATION_DATABASE_URL bunx vitest run src/components/pharmacy/counter/counter-console.test.tsx src/lib/pharmacy/counter-catalogue-cache.test.ts src/lib/pharmacy/counter-search-latency.test.ts src/components/pharmacy/counter/counter-disabled-controls.test.tsx src/components/pharmacy/counter/counter-search-results.test.tsx --reporter=verbose
```

Result: **319 passed in 5 files; zero failed and zero skipped**.

The same 50-scan test was then run in isolation against the recovery base's unmodified
counter-console implementation and against the restored candidate, with the same test
assertions and 30-second timeout. All other tracked files were unchanged by this
negative-control check, and the candidate source was restored byte-for-byte afterward.

| Metric | Recovery base negative control | Recovered candidate |
| --- | ---: | ---: |
| Complete digit bursts | 50 | 50 |
| Distinct operation keys | 1 | 50 |
| Explicit catalogue lookups | 50 | 1 |
| p95 component completion | 295.41 ms | 117.73 ms |
| Maximum component completion | 412.09 ms | 133.54 ms |

The base fails the expected `1` versus `50` operation-key assertion. The candidate
passes both the 50-key and single-lookup assertions. The isolated command selects one
test by name; other tests reported as filtered are not new skip declarations. These
remain **mocked-transport jsdom timings**, not committed database writes or physical
scanner measurements. The integrated 300 ms/native-input acceptance gates remain open.

Evidence logs are preserved in the task workspace under `work/dev-575/`:
`recovery-focused.log`, `recovery-negative-control.log`, and
`recovery-after-timing.log`, alongside the original logs. No database or preview was
started. No full Vitest suite or production build was run during recovery, and the old
unrelated copy-guard timeout was not retried. All five full checks and automated review
remain gates for serialized quiet landing. No human QA sign-off is claimed.
