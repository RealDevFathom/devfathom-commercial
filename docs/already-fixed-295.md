# GitHub issue #295: already fixed

Issue #295 reported that the `family-khata.test.ts` database mock did not provide
`financeJournalEntry.findFirstOrThrow`, causing one test to fail with a missing-function error.

The current code already contains the required mock method:

- `src/lib/pharmacy/family-khata.test.ts:234-239` defines the shared counter Khata fixture and
  supplies `financeJournalEntry.findFirstOrThrow` as a resolved Vitest mock.
- `src/lib/pharmacy/family-khata.test.ts:262-265` exercises that fixture through the Khata balance
  and charge-authorization path that previously encountered the incomplete mock.
- `src/lib/finance/journal.ts:192-195` shows the production journal helper calling
  `financeJournalEntry.findFirstOrThrow`, which is the interface the test double must implement.

No product-code or test-code change is needed. The fix is already present in the current tree, so
this evidence note is the only change made for issue #295.
