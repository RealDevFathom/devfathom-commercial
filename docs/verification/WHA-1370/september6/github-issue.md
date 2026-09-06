Private purchasing/growth combination fails three existing regression assertions. Production build including full TypeScript passes; this is a test compatibility blocker, not evidence of a failed financial transaction.

WHA-1370 exact tested HEAD `2d3c0effc3af5d5bdd2351f831f231909b4432c0`, tree `d2f27adf7952d49728aefa8caca6698bafe4b29c`, base `8ba9dc87ca7906ba915ec66780df52619b552f6d`. Only ddcf92844f334d476204000a3f8a8d8fa6c1ec51, d5f82ed682af9fdeedb1f1b804efc232e0730bb4, and 7e02c9d314d18aa6e3232e15aef2041042299857 were mechanically cherry-picked, with matching stable patch IDs. Existing supplier-credit growth UI remains intact.

First causal defect: `src/app/(app)/pharmacy/purchasing/purchasing-lifecycle.test.tsx:455` uses unscoped `screen.getByRole('status')`. Returns now legitimately renders both the committed outcome and the growth queue's excluded-record warning. Error: `Found multiple elements with the role "status"`. Failing case: `keeps Returns success and sibling credit draft when Submit becomes Dispatch`.

Two adjacent failures in `src/app/(app)/pharmacy/purchasing/returns/page.test.tsx`:
- Line 17 mocks next/navigation with redirect only; rendering new ActionAttempt fails: `No "useRouter" export is defined on the "next/navigation" mock`.
- Line 61 still expects `Returns for this branch could not be read. Nothing was written.` The accepted corrective source intentionally replaced that misleading copy with text explaining that read failure does not confirm or undo earlier changes.

Reproduce on exact private HEAD with matching installed package/lock, private generated Prisma, no DB or app/browser services:
```sh
bun run test 'src/app/(app)/pharmacy/purchasing/purchasing-lifecycle.test.tsx' 'src/app/(app)/pharmacy/purchasing/returns/page.test.tsx'
```
This two-file command is the minimal reproduction derived from the actual 12-file run; not claimed as a separate execution. Actual command and complete assertions are recorded in `docs/verification/WHA-1370/september6/tests-exit.json` and `tests.json` on the local evidence branch. Fresh actual result: 119 unique tests, 116 passed, 3 failed, 0 skipped/pending/todo; exit 1. Real `bun run build`: exit 0, full types and 164 static pages. Safe first-sale `--list`: exit 0, 1 collected, 0 executed.

Requested correction: supervisor routes to existing purchasing builder WHA-1344 with growth-test ownership coordinated as needed. Update only the affected fixture/mocks/assertion scope to retain the actual behavioral checks. Preserve outcome locks and growth warnings; no implementation, backend/schema/policy/money changes are requested. Release QA made no corrective edits. Re-run affected intersection after exact corrective SHA is supplied; owner/human/browser/release gates remain open.
