# WHA-1368 consumer recheck — PASS (source only)

Recommendation to current Codex supervisor: accept private Pharmacy consumer `5a1549376377af8321314d3bbfb2ff3a4e987230` for the reviewed source scope. No blocking finding in this bounded review. This does not approve composition, release, authorization, browser visual quality, or physical printing.

## Exact source and preservation

- Consumer HEAD: `5a1549376377af8321314d3bbfb2ff3a4e987230`; tree: `dd17efc975ee25cef2b00f1b49c905ceac742db6`; immediate parent: `57cb2f0d77b7b4b68214797faf13ee52927599ca`.
- Six owned paths: `src/lib/pharmacy/counter-receipt-presentation.ts`, `src/lib/pharmacy/counter-browser-print.ts`, `src/lib/pharmacy/counter-browser-print.test.ts`, `src/components/pharmacy/counter/counter-receipt-view.tsx`, `src/components/pharmacy/counter/counter-receipt-view.test.tsx`, `src/lib/pharmacy/COUNTER-PRINTING.md`. Parent diff: 389 insertions, 72 deletions. No source fixes made by reviewer.
- Assigned checkout stays at backend `c49b1afa252f20905269a044d09bdb0406eb7b60`, tree `e8be20e3dfc4ef326842c9892f6363cc4a2ac3d0`, on its original assigned branch. Initial dirty state was only the existing untracked `docs/reviews/` backend report; its SHA-256 was captured and verified unchanged at end. Consumer owner's worktree status was clean. No dirty artifacts were copied or overwritten.
- Tested an exact `git archive 5a154937` in run-owned scratch. Six reviewed paths byte-compared to Git after checks: identical. Scratch-only node_modules directory linked installed consumer dependencies read-only; local cache redirected to scratch. No install, generated-client mutation, database, nested CLI, extra agent, app/browser service, push, merge, deploy, or device access.

Original-to-private dependency mapping verified against every source dependency's changed file, with each private copy verified an ancestor of consumer HEAD:

| Original | Private copy | Byte-identical paths |
| --- | --- | ---: |
| `c49b1afa252f20905269a044d09bdb0406eb7b60` | `0b7bca3a662f904ce55e7a70a5229a67bbe37c52` | 7 |
| `806f1138395c595ca27e3eb086581b9961fb441e` | `cab383313b1a661e74a5065bb5f599be2b24de9a` | 15 |
| `411306de8d88b8eea574caa93750a972afa028d7` | `120855488ed740aa448d702b9d0b33f5c188ef52` | 6 |
| `bdea63a2cd3d35eab300dc585e7e1352cf64c4e4` | `1e920422ed17ea8e8d6b422c151b495c50c16bd2` | 1 |
| `513d05ad34f3268c2229c2ea5703786726e7ccde` | `57cb2f0d77b7b4b68214797faf13ee52927599ca` | 8 |

Original `8fccc771aeb4fdd07141ada88e8a74e39459a588` is an ancestor of `2cdef75b9f9bb85f9706ec113a13c3a6267d5183`, itself an ancestor of consumer HEAD. Console, query-refresh helper and query-refresh tests are byte-identical between `2cdef75b` and consumer HEAD. All seven backend repair paths are also byte-identical between `c49b1afa` and consumer HEAD. Prior independent backend **53 passed, 0 failed, 0 skipped** therefore remains applicable as prior source/DB evidence only; it was not rerun or counted in this consumer pass. Existing backend report and [GitHub evidence](https://github.com/WhatTheStack1/devfathom-commercial/issues/90#issuecomment-5553982149) remain intact.

## Fresh independent verification

**48 passed, 0 failed, 0 skipped**: owner's four specified files independently rerun, 47/0/0; one reviewer edge check, 1/0/0. No failing test execution or skipped assertions.

Commands from the isolated archive:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.review.config.mts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.test.tsx src/lib/pharmacy/counter-query-refresh.test.ts src/lib/pharmacy/counter-receipt.test.ts --reporter=json --outputFile=../consumer-tests.json
# exit 0: browser 16, view 10, cart race 3, receipt model 18; 47/0/0
node node_modules/vitest/vitest.mjs run --config vitest.review.config.mts src/lib/pharmacy/review1368-consumer-edge.test.ts --reporter=json --outputFile=../consumer-edge-tests.json
# exit 0: 1/0/0
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.review.json
# exit 0; no diagnostics
node node_modules/eslint/bin/eslint.js src/lib/pharmacy/counter-receipt-presentation.ts src/lib/pharmacy/counter-browser-print.ts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.tsx src/components/pharmacy/counter/counter-receipt-view.test.tsx
# exit 0; no diagnostics
# From assigned Git checkout:
git diff --check 5a154937^ 5a154937
# exit 0
```

TypeScript preserves strict repository options and Next plugin; roots are five consumer TS/TSX paths, existing auth/test declarations, plus scratch Next and Next image global references. No generated route types or full production build claimed. Vitest config differs only by scratch cache location; `.mts` avoids package-mode config loading differences. Fixture, configs, and JSON reports accompany this report as an uploaded evidence bundle.

## Findings and coverage

- Presentation trusts only `identityStatus === 'ISSUED'` for historical labels. It maps every allocation's batch, expiry and canonical units beneath one financial sale line. UI and browser reuse this adapter; no catalog query/substitution or repricing introduced. Existing tests verify both allocations (3 and 7 units), one amount row and unchanged totals/source serialization.
- Missing or explicit unavailable status yields English/Urdu historical-unavailable text. Added edge check covers issued null batch/expiry despite populated singular live fields, and missing-status legacy allocations containing populated stale labels, across both locales and all three formats. No fallback labels/dates leak.
- Shared semantic preview parses layout/facts. Unicode logical lines retain graphemes for pre-wrap; browser escapes all receipt text, React uses text children. Tests verify hostile markup inert, unrelated patient/prescription/fiscal/return extras excluded, control characters refused, invalid semantic input disables printing.
- 58 mm, 80 mm and A4 HTML geometry checked. This is CSS/DOM evidence, not paper measurement. Popup denied/print exception paths give retry guidance. Console rejects missing, mismatched, incomplete, refetching or errored receipts and says only that the browser dialog was requested; physical printing explicitly unconfirmed.
- Cart cancellation is awaited before cart invalidation, followed by receipt invalidation. Three real QueryClient/QueryObserver tests exercise pending old-response completion orders and settled-cache refresh. Relevant source is unchanged from the preserved original cart repair.
- Full Studio contract and bundled Next use-client guide read. Existing Button, Label, StatusPill and semantic tokens retained; controls/states covered by jsdom. Claude-Mem/graph tools unavailable; exact-path source fallback used. Ponytail skill read; no tool installation/setup repair.

## Explicit separate gates

- No actual browser rendering, responsive/theme/motion/keyboard matrix, console/hydration capture or screenshots performed: services expressly prohibited. Board/Verification owner retains authorized staging visual acceptance.
- No OS dialog, cancellation delivery inference, physical printer, margins/page breaks, font coverage or hardware capability verified. Board/Verification hardware owner retains those gates.
- [GitHub #89](https://github.com/WhatTheStack1/devfathom-commercial/issues/89) staff/branch/capability policy remains unresolved. Saved Pharmacy layout/settings authorization and persistence are not implemented and are not accepted here. Shared Restaurant composition/transport gates remain with their existing owners.
- Explicit human-only artifact confirmation on WHA-1364 remains owner pending; reviewer did not act as Saad or resolve that interaction.

Reviewer deliverables only: this new report and evidence bundle. Prior backend report remains unchanged. Recovery: omit the private consumer commit before integration if rejected; preserve dependency snapshots and issuance events. Current supervisor owns integration decisions; this completed independent source review is not blanket release approval.
