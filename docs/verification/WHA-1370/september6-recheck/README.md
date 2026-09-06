# WHA-1370 corrective composition — READY (private scope only)

Tested HEAD: `37906386a59700ce4a168e410ca68594baa97c75`.
Tested tree: `d4d077c986250ee69952ecaff508798143a8d2e7`.
Starting clean evidence HEAD: `8bd6419c5c7dba9ee72aab5361949c11c65d482a`, parent `2d3c0effc3af5d5bdd2351f831f231909b4432c0` (prior tested product base), tree `06e7b2263ad0b6f164bc21ba050ed41b2573f8b5`.
Assigned cwd/branch and API workspace `179fb4a8-e43c-4e7f-9966-cabce9dd22f4` sourceIssueId verified for WHA-1370 before writes. No branch switch or producer edits.

## Exact source/private mapping

Both source parents are `2d3c0effc3af5d5bdd2351f831f231909b4432c0`. Both cherry-picks exit 0 without conflicts; stable patch IDs and final owned-file blobs match original sources. See map.json.

- `ceab91e8b75cd47f7ed0c3ab7bcce18ef6193ab7` => `2a32649afacd9763d97778acbf7a41bbeb256975`, tree `f49434cc2a7317a40f1e6aee96203d352c8e205b`.
- `9bc0ce70ebec8be01f87e8380f78cc8ba2659439` => `37906386a59700ce4a168e410ca68594baa97c75`, tree `d4d077c986250ee69952ecaff508798143a8d2e7`.

Exact test changes: `src/app/(app)/pharmacy/purchasing/purchasing-lifecycle.test.tsx` (+10/-2); `src/app/(app)/pharmacy/purchasing/returns/page.test.tsx` (+4/-2). All further files in this commit are evidence under this directory.

Read full producer comments `604ecae2-9258-402a-b1bb-d84cb1d1ea20` (WHA-1344) and `0ced8c04-8ee6-4ed0-8b1c-529864bfbaaa` (WHA-1371). Their standalone executions are historical, not counted here. Inspected both complete source diffs and exact parents independently.

## Behavior and assertion strength

Before: ambiguous global status query matched return success and retained growth warning; returns page tests omitted useRouter and asserted obsolete read-failure copy.
After: unique View saved record link identifies outcome container; scoped status must match complete anchored success text. Exact growth warning independently retains role=status. Draft, focus, selection, Dispatch, and single-write assertions remain intact. Returns tests supply minimal refresh mock and assert full accepted read-failure warning while preserving visibility, denial/no-priority, branch-read, empty, and loading assertions. No first-match query, skipped test, blanket product mock, warning removal, or product change.

## Fresh bounded checks

- Original 12-file intersection, same 119 unique test identities as prior run: **119 passed, 0 failed, 0 skipped, 0 pending, 0 todo; exit 0**, zero unhandled errors. One run, no retries. All three historical failures pass. Raw assertions: tests.json; exact command/environment categories: tests-exit.json; comparison: test-summary.json.
- `node docs/verification/WHA-1370/september6-recheck/focused-types.cjs`: exit 0, zero compiler config/options/syntactic/semantic diagnostics for both changed tests. Real transitive imports resolve; transitive/full-program diagnostics were not rerun. Repository compiler options retained; noEmit, incremental false; test setup included. Script persisted.
- `node node_modules/eslint/bin/eslint.js <both changed paths>`: exit 0, no diagnostics.
- `node node_modules/prettier/bin/prettier.cjs --check <both changed paths>`: exit 0.
- `git diff --check 8bd6419c5c7dba9ee72aab5361949c11c65d482a HEAD`: exit 0.

Exact commands, return codes, and logs are alongside this report. Reproduction from repository root: `python3 docs/verification/WHA-1370/september6-recheck/run-checks.py tests` and `python3 docs/verification/WHA-1370/september6-recheck/run-checks.py checks`, with PAPERCLIP_RUN_SCRATCH_DIR pointing to own scratch. Scripts are evidence helpers, not product changes; this run invoked each once.

## Build reuse and preservation proof

Prior actual `bun run build` on `2d3c0effc3af5d5bdd2351f831f231909b4432c0`: exit 0, full TypeScript passed, static pages 164/164. Reused, not freshly executed. All 1,811 baseline tracked blobs other than the two test files are identical, including runtime, configuration, package.json, bun.lock, schema, and old evidence. Exact Git modes/types/object IDs are in unchanged-blobs.txt; verification and manifest SHA256 in blob-proof.json. Test files participate in TypeScript, so their changed diagnostics were checked freshly as scoped above. No full-build/full-type replay claim.

Prior failed report remains untouched: SHA256 `8c45a7e7c890241d6ad80f0e559e59ddc55ba75e5be279cb4a14a9fadc1e0af4`. Its 116 passed/3 failed record stays historical. Prior safe first-sale collection (exit 0, one collected, zero executed) reused because configuration and every transitive input are unchanged; no new collection or browser run.

## Limits and handoff

No causal defect remains in this bounded composition. GitHub #98 stays open for supervisor disposition; no automatic close or release approval. Evidence-only final HEAD is reported separately in GitHub/Paperclip handoff after committing this directory.

Used existing private node_modules, own caches/scratch. Sanitized test environment excludes credentials/database variables; no auth secret needed. Read full Studio contract and installed Next TypeScript/Vitest guides. These mocked rendering checks do not establish async Server Component/browser or Studio visual acceptance. Graph/Claude-Mem and Ponytail tools unavailable in tool catalog; supplied exact Git/file paths used; no claim of unavailable runtime verification. Commit messages follow caveman-commit guidance.

No implementation repairs beyond authorized original test combinations; no staging seed/account, DB, service/browser, owner ports, devices, nested CLI/agents, installs, pushes, merges, rebases, deployment, or destructive cleanup. Existing human policy/owner approvals, Studio/browser/physical and release gates remain open. No runtime rollback needed; preserve this private branch and failed evidence. Supervisor decides further consumption; no verifier loop requested.
