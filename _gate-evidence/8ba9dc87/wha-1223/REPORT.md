# WHA-1223 — bounded locator correction recheck

**Correction PASS. Safe collection PASS: one test collected, zero executed. Full journey and Studio acceptance remain UNRUN.**

2026-09-06, run 04e49f09-c319-4e17-8483-d1e9f9c1846c. Exact candidate `8ba9dc87ca7906ba915ec66780df52619b552f6d`, parent `dce6fef1407a9211aa8801cc8ab0c115c40107a7`. This resolves only the source/component-proven accessible-name locator finding from the preserved dce6 FAIL review. Invitation98bc PASS and all other prior evidence retain their original scope.

## Identity and scope

Source `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.paperclip/worktrees/WHA-1203-wha-1195a-build-first-run-checklist-and-first-sale-scenario`, native branch `codex/WHA-1203-pharmacy-fresh-first-sale`, common Git repo `/Users/Saad/Downloads/Projects & Code/DevFathom hub/company-hub/.git`. Initial/final source clean at candidate. Pinned `git archive 8ba9dc87ca7906ba915ec66780df52619b552f6d` into owned `$PAPERCLIP_RUN_SCRATCH_DIR/candidate`; no moving HEAD, overlay, source writes or branch mutation.

Reviewer cwd `/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1223-gate-candidate-b20b577f-browser-suite-wha-1132-contract-on-the-runner-with-the-working-postgresql-path-self-cho`; original branch unchanged, HEAD remains `b20b577f9d397855458cbef15ea8d178870d85a3`. Only report artifacts added. Historical FAIL, original QA whitespace attempt, original8b107092 and other workers untouched.

Parent independently verified. Exact two-file +61/-1 delta, post-check archive hashes match pinned Git blobs:

- `tests/e2e/fixtures/pharmacy-first-sale.ts`: `19564016b058b70d1856c6b1b3b11c1ad7b947eb`.
- `tests/e2e/fixtures/pharmacy-first-sale.test.tsx`: `b9c1dc2a5ffc556647c3270cd08c401245b8f149`.

## Finding resolution

Real helper exports pharmacyChecklistLinkName. It escapes regex metacharacters in both link label and gate, anchors the complete name, and tolerates whitespace only around the em dash. follow uses that actual matcher within the existing row, asserts exactly one matching link, then clicks. No new contains/.first fallback, raw navigation, or accessible markup removal.

All nine call-site lines equal parent byte-for-byte: inventory, regulatory, medicines, suppliers, receiving four times (including colleague), and counter. Six unique gate/label/destination contracts match unchanged shared ReadinessChecklistItem output. No call or flow step changed.

New single regression imports the real matcher and renders actual shared component for six destinations. It checks old bare-name miss, unique corrected match, href/text, both dash-space forms and prefix/suffix/wrong-gate negatives. **One test covers six contracts; not six tests.** Independent probe additionally exercises literal regex punctuation in both arguments, not covered by production labels. Original final counterexample copied byte-for-byte, SHA256 `88c41b520ce3e628ef7df5c303f6c84fc3fb971e3f80fa865404eef038a5bf89`, retaining exact short-name-null and suffix-name-positive assertions. No weaker oracle substituted.

## Commands and results

Read-only dependency links from verified WHA1376 checkout `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/WHA-1376-verify-ph-growth-independently-verify-gross-margin-comparison-addf0323`. Candidate/dependency-owner package.json, bun.lock and tsconfig SHA256 equality asserted (same hashes documented in previous review). Own node_modules excludes shared .vite/.vite-temp/.cache. **No generation or install** required; own scratch caches only.

- `./node_modules/.bin/vitest run tests/e2e/fixtures/pharmacy-first-sale.test.tsx tests/qa-wha1223/checklist-name.test.tsx tests/qa-wha1223/literal-matcher.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=$PAPERCLIP_RUN_SCRATCH_DIR/regression.json`: exit0, **3 files/3 tests passed; zero failed/skipped/pending/todo**, 2.74s. Breakdown: new regression1, unchanged original counterexample1, escaping probe1.
- `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.locator.json`: exit0, zero diagnostics. Own config extends unchanged repository tsconfig; includes two changed files plus next-env/vitest setup and transitive imports. Focused test-source check, not full build/generated Next-route validation; no suppression added.
- `./node_modules/.bin/eslint --max-warnings=0 tests/e2e/fixtures/pharmacy-first-sale.ts tests/e2e/fixtures/pharmacy-first-sale.test.tsx`: exit0, no warnings/errors.
- `./node_modules/.bin/prettier --check` on those two paths: exit0, both formatted; no writes.
- `git diff --check dce6fef1407a9211aa8801cc8ab0c115c40107a7 8ba9dc87ca7906ba915ec66780df52619b552f6d`: exit0, no diagnostics.
- `PHARMACY_E2E=1 ./node_modules/.bin/playwright test --config tests/e2e/time-to-first-sale.config.ts --list`: exit0, **1 test in1file collected, 0 executed**.

All checks passed first attempt in this recheck. Builder comment `0db4ed80-549d-4311-9778-427a6f5f39fa` read in full: builder reports BEFORE1failed/AFTER1passed; this remains builder-reported history, not added to independent counts. Original reviewer whitespace-positive-control failure remains in untouched dce6 report/logs; this recheck copied its final counterexample unchanged.

## Preserved boundaries

Exact diff and blob comparisons establish unchanged product/Team/pack/navigation/renderer/permissions and complete Restaurant spec. Helper delta is only pure exported matcher plus follow lookup/assertion; input validation, response handling, activation sequence and actual separate-colleague flow remain unchanged. Prior dce6 report supplies accepted/rejected boundary details; no repeat Team12/pending, pack79+10, navigation11 or broad flow audit.

Config reread before safe collection: no webServer/globalSetup, one testMatch, no default app URL. Config/spec/Restaurant import helpers byte-identical to previously fully inspected import-safe versions; new export initializes no network/service. Collection starts no browser, application, DB or external request.

Previously read full Studio contract remains exact same blob; installed Next use-client/Link/Vitest guidance remains applicable to unchanged renderer. Bounded/evidence skills remain active. Graph/Claude-Mem/Ponytail unavailable; rg previously unavailable; exact-path Git/Python checks used. No nested agents/session or global changes.

Equal operator-supplied source/deployed SHA strings remain **manual attestation, not automatic deployed-revision proof**. Authorized isolated SHARED environment, credentials, actual jurisdiction/licence/qualified-person/source/evidence and host prerequisites remain runtime responsibilities. No input/credential supplied or runtime executed in this recheck.

UNRUN: full fresh organization, actual second person, activation-last, first sale, no4xx/raw-ID runtime acceptance, click/time and full Studio viewport/theme/reduced-motion/keyboard/overflow/state/console matrix. No app/browser/DB/RLS/migration/seed/staging/production/device/owner3218/3217, build, install, shared generation, source modification, fetch/reset/rebuild/switch/composition or deployment.

Disposition: bounded recheck complete, WHA-1223 done. No new defect established. Supervisor routes any authorized runtime/Studio work; original WHA-1203 retains follow-through. No new issue, acknowledgment wake or automatic further-review dispatch. Prior FAIL remains historical evidence; this report supersedes only its locator finding on exact8ba9 artifact.
