# DEV-217 / issue #491: archived Sev1 retest disposition

**Decision:** keep the recovered historical QA evidence in existing
[PR #965](https://github.com/RealDevFathom/devfathom-commercial/pull/965), on
`salvage/qa-artefacts`. Restoration of the deleted `qa/retest-sev1-129-130-142`
branch is unnecessary. Do not open another PR from its tag or repeat its four
cherry-picks. This resolves the recovery decision, not the product defects named
in the historical reports.

## Inspected refs and preserved payload

Static inspection on 2026-11-03 used:

- Archive tag `archive/qa/retest-sev1-129-130-142`:
  `17064c861a4a721240be4bc2508a67c0f81fa80b`.
- Existing PR head before this work:
  `3a840db341645e7c16f5ae1a8281f6dd599a1f2a`.
- Current `develop` source and integration parent:
  `47ea6c8d090194248910359a20b3c243788da77a`.
- Conflict-free ordinary develop merge:
  `bf2fce6c1d440cf1c8580daa7f27b0d01a034c3a`.

The four archived diffs change only
[`qa/retests/sev1-129-130-142.md`](../../qa/retests/sev1-129-130-142.md).
Each report version is already preserved by the following existing salvage
commit, with an identical report blob and matching per-commit change counts:

| Archive commit | Existing salvage commit | Report delta | Disposition |
| --- | --- | --- | --- |
| `65217005769c62d6a6c35d8d616592f5a9fe3eb6` | `07addf133712b8a17836adbdb6accd37a8ef40af` | Initial retest, +305/-0 lines | Already recovered; retain history, do not replay |
| `6d0c3e2b6e0114c7a88c2e9b6974c769f93cda08` | `4668726391ae9419bc2a82a0eed5812ca9a43ec9` | Second retest, +88/-209 lines | Already recovered; retain history, do not replay |
| `1e42926c51b78f9cd47cd400e0b501a580aa4d5a` | `1f3323cb14eb2acef0563fd9eb96672be35452c5` | Third retest and Goods-in, +82/-107 lines | Already recovered; retain history, do not replay |
| `17064c861a4a721240be4bc2508a67c0f81fa80b` | `89f1a7b7e01c27c171ac20afb3c1fb1fa704b590` | Final retest, +67/-83 lines | Already recovered; retain history, do not replay |

The final report blob is `bd68f103bc789840adf09bc68ae8550584503d20` in both
the archive and the existing PR. Earlier report versions remain in its history.
There is no application fix, schema change, or migration in these four commits.

Retain all 325 existing bundled archive files: 119 pharmacy, 195 restaurant,
and 11 retest files, including the restaurant #144/#145/#146 evidence. These
include historical reports, issue drafts, captures, and 17 archival scripts;
the whole bundle is not solely documentation. Static Git diffs show no change
to those 325 files through the develop merge. Relative to develop, that merge
adds only the existing archive payload. Modern runtime changes arriving through
develop integration are inherited upstream work, not DEV-217-authored fixes.

The earlier completion claim for `8a19f1b` is not publication evidence: that
object is unavailable in this checkout, and neither inspected tree contained
this decision record. The hosted report alone lacked an explicit disposition.

## Historical results are not current acceptance

The retained report is dated 2026-10-21. Its final table says Sindh #129 **FAIL**
at `ee28700c`, capability names #130 **FAIL** at `c533e62a`, catalog isolation
#142 **PASS** at `f945ef46` (unchanged, explicitly not rerun), and Goods-in #177
**PASS** at `f3a66256`. It also records migration workarounds and remaining
findings, including receiving-page access despite denied posting. Preserve
those statements as historical observations; do not relabel them as current
passes or execute their workaround instructions as part of this recovery.

Current develop has relevant source and regression definitions, inspected only
to establish that supported implementations have their own maintained evidence:

| Area | Source/regression evidence at the develop SHA above | What it establishes and does not establish |
| --- | --- | --- |
| Sindh rules | `src/lib/pharmacy/regulatory.ts:70-116`; `tests/e2e/platform-control-plane-pharmacy-onboarding.spec.ts:21-23,115-148,364-420` | Regulatory guards reject unconfirmed rules. The E2E fixture inserts Sindh rules as a stand-in for out-of-band confirmation; it does not prove deployed rule availability or migration success. |
| System Owner capabilities | `src/lib/vertical-catalog.ts:766-772`; `prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql:56-69`; `src/lib/hotel/foundation.test.ts:23-27,44-65` | Canonical Owner grants and a bounded system-Owner backfill exist; conflict handling preserves existing report DENY entries. The catalog digest is a source assertion, not proof of applied grants or a passing test run. |
| Goods-in access | `src/lib/pharmacy/procurement-access.ts:17-55`; `src/lib/pharmacy/procurement-access.test.ts:53-110`; `src/app/(app)/pharmacy/purchasing/purchasing-console.test.tsx:214-237` | Source and assertions cover DENY precedence, cashier exclusion, and a bounded legacy-admin fallback. They do not establish current browser/API acceptance or resolve every historic receiving-page finding. |
| Restaurant catalog isolation | `src/lib/restaurant/catalog.ts:871-893`; `src/lib/restaurant/catalog-scope.ts:5-18`; `tests/restaurant-catalog-tenant.db.test.ts:20-25,121-176` | List/get predicates explicitly scope organization; tests describe privileged and restricted-connection isolation. The suite skips without `CATALOG_TEST_DATABASE_URL`; no execution or database acceptance is claimed. |

## Scope and validation limits

This decision document is the only newly authored repository file. No runtime
fix is inferred from an old PASS, PR title, or completion comment. PR #120 is
unrelated receipt-print work; its machine report supplies no acceptance or
failure requirement for DEV-217.

Only static file, diff, history, and status inspection was performed. No tests,
machine checks, `git diff --check`, formatter, lint, typecheck, build, dependency
installation, migration, scan, or live browser/database validation was run.
Current execution and acceptance remain for the user's reserved validation.
Keep the archive tag and existing bundled PR; review this disposition there.
