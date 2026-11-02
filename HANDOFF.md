# PR review handoff log

_Generated 2026-11-02 18:51 UTC from the live run state by `handoff/scripts/gen-handoff.py`. Do not hand-edit item sections; edit the resume note instead._

## Resume here

- **Next action:** collect the group 2 review workflow result (run wf_f4d5deac-1fc), then push one fix commit each for the group 2 PRs whose machine checks or reviews failed. Known so far: #1166 (4 ESLint react/display-name errors and 1 failing test in its new `src/components/layout/topbar.search-licensing.test.tsx`), #1161 (new TS2741 in `tests/postgres-backup.test.ts`: the env object needs `NODE_ENV`), and Prettier on files newly unformatted by #1166, #1165, #1164, #1161, #1157, #1156, #1152 and #1150 (`python3 handoff/scripts/format-check.py pr/<n>`), plus any confirmed QA/Security findings.
- **Item:** group 2 (#1148-#1166). Group 1's original 22 are done (all verdicts posted). #1223 and #1224 were opened during the run and have been added to group 1: their machine checks are at the front of the queue and their reviews are running (run wf_77d9fe9a-f1a).
- **Half-written / uncommitted:** nothing on any PR branch. The fix worktree `fixD` is clean. Running in the background: machine-check lanes A and B (`queue.txt`); review runs wf_f4d5deac-1fc (group 2), wf_4756b925-16c and wf_76951271-6f3 (group 3 pharmacy), and wf_77d9fe9a-f1a (#1223, #1224); and the 15-minute handoff sync loop.

## Progress

- Scope: every open PR into develop without a QA+Security verdict comment: group 1 #1172-#1194 (22, plus #1223 and #1224 opened during the run; #1225 is this tracking PR and is not reviewed), group 2 #1148-#1166 (18), group 3 the other 127 (pharmacy first). 118 older PRs already had verdict comments and are out of scope.
- Status: done 22 · in progress 41 · blocked 0 · not started 106 (of 169)
- Machine-check queue (130 left, two lanes, runs serially per lane): 1149 1148 1158 1120 1119 1118 1117 1116 1114 1101 1087 1086 1072 1068 1061 1060 1056 1050 1008 1006 1005 1004 1003 1002 1001 1000 999 998 997 996 995 994 993 986 985 984 983 982 966 965 …
- Last finished checks: #1155@7365a9b9, #1154@07cc0aaf, #1224@dd6cf1de, #1153@617c185c, #1152@9504a99f, #1151@de8a0921

### Posted verdicts

| PR | DEV | Machine | QA | Security | Fix commit | Comment |
|---|---|---|---|---|---|---|
| #1193 | DEV-200 | PASS | PASS | PASS | d5543e9bc7 | https://github.com/RealDevFathom/devfathom-commercial/pull/1193#issuecomment-6584820414 |
| #1192 | DEV-314 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1192#issuecomment-6584820364 |
| #1189 | DEV-320 | PASS | PASS | PASS | 18789590ed | https://github.com/RealDevFathom/devfathom-commercial/pull/1189#issuecomment-6584809227 |
| #1181 | DEV-222 | PASS | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1181#issuecomment-6584844869 |
| #1180 | DEV-164 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1180#issuecomment-6584659906 |
| #1177 | DEV-150 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1177#issuecomment-6584660511 |
| #1172 | DEV-208 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1172#issuecomment-6584668831 |
| #1194 | DEV-272 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1194#issuecomment-6584671210 |
| #1191 | DEV-194 | PASS | PASS | PASS | 8135d4788e | https://github.com/RealDevFathom/devfathom-commercial/pull/1191#issuecomment-6585184312 |
| #1190 | DEV-193 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1190#issuecomment-6584678062 |
| #1188 | DEV-230 | PASS | PASS | PASS | 56de66cb6c | https://github.com/RealDevFathom/devfathom-commercial/pull/1188#issuecomment-6585185281 |
| #1187 | DEV-178 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1187#issuecomment-6584678978 |
| #1186 | DEV-172 | PASS | PASS | PASS | d1236f8082 | https://github.com/RealDevFathom/devfathom-commercial/pull/1186#issuecomment-6585192249 |
| #1184 | DEV-213 | PASS | PASS | PASS | 3c317f346a | https://github.com/RealDevFathom/devfathom-commercial/pull/1184#issuecomment-6585193282 |
| #1183 | DEV-214 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1183#issuecomment-6584688482 |
| #1182 | DEV-158 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1182#issuecomment-6584691749 |
| #1179 | DEV-154 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1179#issuecomment-6584700707 |
| #1178 | DEV-166 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1178#issuecomment-6584709430 |
| #1176 | DEV-167 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1176#issuecomment-6584713605 |
| #1175 | DEV-327 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1175#issuecomment-6584721594 |
| #1174 | DEV-284 | PASS | PASS | PASS | 765302d8c9 | https://github.com/RealDevFathom/devfathom-commercial/pull/1174#issuecomment-6584810383 |
| #1173 | DEV-186 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1173#issuecomment-6584725142 |

## Rules in force

- PRs into develop only. Never merge. Never touch staging or main. No force-push. Do not trigger GitHub Actions: every pushed commit carries `[skip ci]`.
- Commits: no Co-Authored-By lines and no model names. One fix commit per PR, scoped to that PR's own issue.
- Verdict comment format: `Machine checks: PASS/FAIL (details). QA: PASS/FAIL (details). Security: PASS/FAIL (details).` plus the Claude Code footer.
- Machine checks count only failures the PR introduces. The 4 typecheck errors already on develop, test failures that also fail on develop or the merge-base, and suites that only fail because the gate runtime DB role lacks CREATE ROLE are reported but are not counted against the PR. Prettier counts only for files the PR newly leaves unformatted (develop already has 141 unformatted files in the gate's set).

## How to resume (environment)

0. `export REPO=<clone path> HANDOFF_STATE=<state dir>` (scripts default to this run's paths).
1. `git fetch --unshallow origin || true; git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'` (PR heads are read as `pr/<n>`).
2. Local gate-equivalent Postgres 16 on 127.0.0.1:55432 (password `gate-postgres-ci-only`): `bash handoff/scripts/setup-db.sh` creates the cluster, roles, `devfathom_gate_test`, migrates, seeds, and makes `devfathom_gate_template`.
3. Worktrees: `git worktree add --detach $HANDOFF_STATE/laneA origin/develop` (likewise laneB, laneC for retries, fixD for fixes), then `bun install --frozen-lockfile` in each. Export `HANDOFF_STATE` to the directory holding those worktrees, `gate.env`, `baseline/typecheck.errors`, `checks/`, `queue.txt`.
4. Run lanes: `setsid nohup bash handoff/scripts/run-lane.sh $HANDOFF_STATE/laneA devfathom_gate_lane_a_test $HANDOFF_STATE/queue.txt &` (and laneB/`_b_`). Typecheck and build share `heavy.lock` (15 GB RAM cannot fit two tsc runs).
5. Reviews: one QA and one Security reviewer per PR (read-only, via `git show pr/<n>:path`), plus 2 skeptics per blocking finding (3rd on a split); see `handoff/scripts/review-g3.js`.
6. Compose and post: `python3 handoff/scripts/compose.py <n>` writes comments/<n>.md; post it verbatim only after checking the head sha and that no verdict comment exists.
7. Machine-readable state: `handoff/state/items.json` (one row per PR).

## Group 1 (#1172-#1194)

### #1223 · DEV-155, DEV-249, DEV-344, DEV-124, DEV-252, DEV-250, DEV-347, DEV-348, DEV-243, DEV-579, DEV-580, DEV-581, DEV-325, DEV-329, DEV-140, DEV-312, DEV-577 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1223 · branch `saad/nice-thompson-99m17p` · head `e3bb296c64` · group 1
- Title: None
- Verdicts: machine ran, see below · QA PASS (partial) · Security PASS (partial)
- Done so far: checks on e3bb296c64: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 3749 passed / 50 failed in 23 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1223`, then post comments/1223.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1223` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1223`; tests `bunx vitest related --run prisma.config.ts prisma/bootstrap.ts prisma/create-admin.ts prisma/load-env.ts prisma/platform-admin.ts prisma/reset-admin-password.ts prisma/seed-demo.ts prisma/seed-failure.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: test failures not yet compared with develop: tests/restaurant-m5-acceptance.test.ts, tests/restaurant-m5-reconciliation.test.ts, tests/restaurant-m6-acceptance.test.ts, tests/restaurant-menu-import-acceptance.db.test.ts, tests/vertical-foundation.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/lib/pharmacy/supplier-returns.db.test.ts, src/lib/pharmacy/upsell-suggestions.db.test.ts, src/lib/restaurant/catering-endpoints.db.test.ts, src/lib/restaurant/catering-money.db.test.ts, src/lib/restaurant/catering-runtime.db.test.ts, src/lib/restaurant/daily-close-clock.test.ts, src/lib/restaurant/refunds.test.ts, src/lib/restaurant/tenders-posting.test.ts, src/lib/restaurant/terminal-checkout.db.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts, src/server/routers/restaurant-tax.db.test.ts, src/server/routers/restaurant-tax.test.ts, src/lib/pharmacy/accounts/cash-flow.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1224 · none (no DEV-<n> or #<n> in title; Linear search for 'SehatCart QA' finds only product-finding issues such as DEV-31 and DEV-32, no tracking issue for this pass) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1224 · branch `saad/great-brown-id2w5x` · head `dd6cf1de49` · group 1
- Title: None
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on dd6cf1de49: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 0 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1224`, then post comments/1224.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1224` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1224`; tests `bunx vitest related --run qa/sehatcart-2026-11-02/harness/ask.mjs qa/sehatcart-2026-11-02/harness/close-rbac.mjs qa/sehatcart-2026-11-02/harness/data1.mjs qa/sehatcart-2026-11-02/harness/data2.mjs qa/sehatcart-2026-11-02/harness/data3.mjs qa/sehatcart-2026-11-02/harness/hydration-diff.mjs qa/sehatcart-2026-11-02/harness/lib.mjs qa/sehatcart-2026-11-02/harness/login-all.mjs …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1193 · DEV-200 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1193 · branch `codex/dev-200-local-recovery-20261102` · head `d5543e9bc7` · group 1
- Title: DEV-200: share purchase-order eligibility validation when posting receipts
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on d5543e9bc7: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 257 passed / 0 failed in 0 files; build exit 0; fix commit d5543e9bc7 (Prettier on goods-receipt-expiry.test.ts; first run on f140798392 failed on Prettier: src/lib/pharmacy/goods-receipt-expiry.test.ts unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1193#issuecomment-6584820414
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1193#issuecomment-6584820414)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1193` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1193`; tests `bunx vitest related --run src/lib/pharmacy/goods-receipt-expiry.test.ts src/lib/pharmacy/goods-receipt.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1192 · DEV-314 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1192 · branch `codex/dev-314-local-recovery-20261102` · head `49c86e78ef` · group 1
- Title: DEV-314: Recheck consent before claimed WhatsApp sends
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 49c86e78ef: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 97 passed / 0 failed in 1 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1192#issuecomment-6584820364
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1192#issuecomment-6584820364)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1192` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1192`; tests `bunx vitest related --run src/lib/pharmacy/whatsapp/khata-reminders.test.ts src/lib/pharmacy/whatsapp/message-log.db.test.ts src/lib/pharmacy/whatsapp/message-log.test.ts src/lib/pharmacy/whatsapp/message-log.ts src/lib/pharmacy/whatsapp/refill-reminders.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/whatsapp/message-log.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/whatsapp/message-log.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related test src/lib/pharmacy/whatsapp/message-log.db.test.ts fails under the gate runtime role (permission denied to create role) on both the PR and develop; passes 2/2 on the PR and develop when run with a superuser DB role. Environmental, not introduced.

### #1189 · DEV-320 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1189 · branch `codex/dev-320-local-recovery-20261102` · head `18789590ed` · group 1
- Title: DEV-320: restore readable mobile settled receipts
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 18789590ed: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 115 passed / 0 failed in 0 files; build exit 0; fix commit 18789590ed (types the new test's receipt lookup with closest<HTMLElement>(); first run on 458caf2732 failed on 1 new typecheck error (TS2345 at counter-console.test.tsx:387)); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1189#issuecomment-6584809227
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1189#issuecomment-6584809227)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1189` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1189`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: NEW typecheck error introduced: src/components/pharmacy/counter/counter-console.test.tsx(387,36) TS2345 Argument of type 'Element | null' is not assignable to parameter of type 'HTMLElement | SVGElement | null'. Must be fixed on the branch.

### #1181 · DEV-222 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1181 · branch `codex/dev-222-local-recovery-20261102` · head `5498083171` · group 1
- Title: DEV-222: Repair recovered pharmacy test fixtures
- Verdicts: machine PASS · QA FAIL · Security PASS
- Done so far: checks on 5498083171: typecheck exit 0 (0 new vs baseline); eslint 0 errors; tests 232 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1181#issuecomment-6584844869
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1181#issuecomment-6584844869)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1181` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1181`; tests `bunx vitest related --run src/app/(app)/pharmacy/marketing/basket-panel.test.tsx src/components/pharmacy/counter/counter-console.test.tsx src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts src/server/routers/pharmacy-inventory.test.ts src/server/routers/restaurant-catering.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/server/routers/pharmacy-inventory.test.ts | note: Typecheck: PR fixes all 4 develop baseline errors (0 errors). Related test src/server/routers/pharmacy-inventory.test.ts has 1 failing test ('manual quarantine resolution authorization refuses regulatory stock through inventory-only write-off before posting movements': expected BAD_REQUEST, got TRPCError COAUTH_REQUIRED) that fails identically on develop (pre-existing). This PR edits that test file (DEV-222 test fixture repair) so whether it should also repair this assertion is a scope question for QA.
- Decisions: qa verdict set to FAIL by hand: The five fixture repairs are correct (duplicate mock keys removed, required grossMinor and recipeId added, the resolve wrapped in act, no assertion weakened) and they take typecheck to 0 errors. But DEV-222 asks to recover or explicitly retire the archive/fix/qa-b3-pharmacy work (10d268de), and none | QA-1181-1 (qa) confirmed by skeptics: DEV-222's requirement is unmet. The issue asks to recover the archived commits, cherry-pick what is still needed, or rule them obsolete. This PR recovers none of the archived work and records no decision about it, yet it

### #1180 · DEV-164 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1180 · branch `codex/dev-164-local-recovery-20261102` · head `6eb3912cd3` · group 1
- Title: DEV-164: Allow grants-only seed without pharmacy admin email
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 6eb3912cd3: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 23 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1180#issuecomment-6584659906
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1180#issuecomment-6584659906)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1180` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1180`; tests `bunx vitest related --run scripts/pharmacy-e2e-environment.ts tests/staging-demo-seed-guard.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1177 · DEV-150 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1177 · branch `codex/dev-150-local-recovery-20261102` · head `3271854429` · group 1
- Title: DEV-150: Verify bilingual order confirmation facts
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 3271854429: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 1 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1177#issuecomment-6584660511
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1177#issuecomment-6584660511)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1177` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1177`; tests `bunx vitest related --run src/lib/pharmacy/whatsapp/messages.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1172 · DEV-208 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1172 · branch `codex/dev-208-local-recovery-20261102` · head `6c7f10a51b` · group 1
- Title: DEV-208: Harden counter patient denial coverage and refund fixtures
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 6c7f10a51b: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 61 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1172#issuecomment-6584668831
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1172#issuecomment-6584668831)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1172` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1172`; tests `bunx vitest related --run src/server/routers/pharmacy-prescriptions.test.ts src/server/routers/pharmacy-sales.refund-cap.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1194 · DEV-272 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1194 · branch `codex/dev-272-local-recovery-20261102` · head `47c4898685` · group 1
- Title: DEV-272: restore constant API error logging format
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 47c4898685: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 16 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1194#issuecomment-6584671210
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1194#issuecomment-6584671210)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1194` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1194`; tests `bunx vitest related --run src/lib/api-auth.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1191 · DEV-194 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1191 · branch `codex/dev-194-local-recovery-20261102` · head `8135d4788e` · group 1
- Title: DEV-194: recover terminal signature test secret follow-up
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 8135d4788e: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 6 passed / 0 failed in 0 files; build exit 0; fix commit 8135d4788e (Prettier on tests/restaurant-terminal-payments.test.ts; first run on 4d1f259b0a failed on Prettier: tests/restaurant-terminal-payments.test.ts unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1191#issuecomment-6585184312
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1191#issuecomment-6585184312)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1191` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1191`; tests `bunx vitest related --run tests/restaurant-terminal-payments.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1190 · DEV-193 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1190 · branch `codex/dev-193-local-recovery-20261102` · head `6609d96f78` · group 1
- Title: DEV-193: share admitted meeting provider identity contract
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 6609d96f78: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 54 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1190#issuecomment-6584678062
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1190#issuecomment-6584678062)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1190` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1190`; tests `bunx vitest related --run src/lib/meetings/admission.ts src/lib/meetings/provider-identity.test.ts src/lib/meetings/provider-identity.ts src/server/meetings/provider/events.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1188 · DEV-230 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1188 · branch `codex/dev-230-local-recovery-20261102` · head `56de66cb6c` · group 1
- Title: DEV-230: record obsolete security archive disposition
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 56de66cb6c: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 2 passed / 0 failed in 0 files; build exit 0; fix commit 56de66cb6c (Prettier on the new archive-recovery doc; first run on 82550105a7 failed on Prettier: docs/archive-recovery/issue-473-sec-next-upgrade.md unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1188#issuecomment-6585185281
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1188#issuecomment-6585185281)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1188` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1188`; tests `bunx vitest related --run tests/archive-recovery-473.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1187 · DEV-178 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1187 · branch `codex/dev-178-local-recovery-20261102` · head `7c1d5318b6` · group 1
- Title: DEV-178: Centralize administrator session cookie cleanup for enrollment
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 7c1d5318b6: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 10 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1187#issuecomment-6584678978
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1187#issuecomment-6584678978)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1187` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1187`; tests `bunx vitest related --run src/app/api/restaurant/devices/browser-enroll/route.test.ts src/app/api/restaurant/devices/browser-enroll/route.ts src/lib/auth/session-cookies.test.ts src/lib/auth/session-cookies.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1186 · DEV-172 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1186 · branch `codex/dev-172-local-recovery-20261102` · head `d1236f8082` · group 1
- Title: DEV-172: Centralize recipe measurement validation
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on d1236f8082: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 173 passed / 0 failed in 0 files; build exit 0; fix commit d1236f8082 (Prettier on the two new recipe-measurements files; first run on 0495117293 failed on Prettier: src/lib/restaurant/recipe-measurements.ts and its test unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1186#issuecomment-6585192249
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1186#issuecomment-6585192249)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1186` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1186`; tests `bunx vitest related --run src/lib/restaurant/recipe-measurements.test.ts src/lib/restaurant/recipe-measurements.ts src/lib/restaurant/recipes.ts src/server/routers/restaurant-catalog.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1184 · DEV-213 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1184 · branch `codex/dev-213-local-recovery-20261102` · head `3c317f346a` · group 1
- Title: DEV-213: Resolve archived white UI recovery
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 3c317f346a: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 5 passed / 0 failed in 0 files; build exit 0; fix commit 3c317f346a (Prettier on the new archive-recovery doc; first run on 875bcc24b1 failed on Prettier: docs/archive-recovery/issue-506-white-ui-dirty.md unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1184#issuecomment-6585193282
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1184#issuecomment-6585193282)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1184` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1184`; tests `bunx vitest related --run tests/archive-recovery-506.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: Verified the DEV-213 disposition (close as obsolete) against the archived commits via the GitHub API: c85ea42a adds the Nuxt app/, the FastAPI backend/ and a migration doc that makes src/ and Prisma historical; 43a72f44 changes 8 Nuxt shell files; f6f72ee0 has the same tree as its parent (15f6215b).

### #1183 · DEV-214 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1183 · branch `codex/dev-214-local-recovery-20261102` · head `7301b36ff5` · group 1
- Title: DEV-214: Record WHA-66 archive recovery decision
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 7301b36ff5: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 2 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1183#issuecomment-6584688482
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1183#issuecomment-6584688482)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1183` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1183`; tests `bunx vitest related --run tests/archive-wha-66-recovery.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1182 · DEV-158 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1182 · branch `codex/dev-158-local-recovery-20261102` · head `58b125da1b` · group 1
- Title: DEV-158: cover outstanding partial invoice balances
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 58b125da1b: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 1 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1182#issuecomment-6584691749
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1182#issuecomment-6584691749)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1182` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1182`; tests `bunx vitest related --run src/server/routers/finance.summary.db.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1179 · DEV-154 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1179 · branch `codex/dev-154-local-recovery-20261102` · head `67c80e72b0` · group 1
- Title: DEV-154: Isolate webhook test key (partial recovery)
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 67c80e72b0: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 3 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1179#issuecomment-6584700707
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1179#issuecomment-6584700707)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1179` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1179`; tests `bunx vitest related --run src/app/api/restaurant/webhooks/[source]/route.replay.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1178 · DEV-166 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1178 · branch `codex/dev-166-local-recovery-20261102` · head `bf32ae5501` · group 1
- Title: DEV-166: Count invoice payments in Agency monthly revenue
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on bf32ae5501: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 47 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1178#issuecomment-6584709430
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1178#issuecomment-6584709430)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1178` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1178`; tests `bunx vitest related --run src/server/routers/finance.summary.test.ts src/server/routers/finance.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1176 · DEV-167 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1176 · branch `codex/dev-167-local-recovery-20261102` · head `8c91e73510` · group 1
- Title: DEV-167: Guard activity transaction completion without outbox draining
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 8c91e73510: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 8 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1176#issuecomment-6584713605
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1176#issuecomment-6584713605)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1176` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1176`; tests `bunx vitest related --run src/lib/tenancy/scoped-db.options.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1175 · DEV-327 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1175 · branch `codex/dev-327-local-recovery-20261102` · head `a74e184e3b` · group 1
- Title: DEV-327: Name the platform home logo link
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on a74e184e3b: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 4 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1175#issuecomment-6584721594
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1175#issuecomment-6584721594)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1175` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1175`; tests `bunx vitest related --run src/components/platform/platform-shell.test.tsx src/components/platform/platform-shell.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1174 · DEV-284 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1174 · branch `codex/dev-284-local-recovery-20261102` · head `765302d8c9` · group 1
- Title: DEV-284: share dedicated provisioning validation
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 765302d8c9: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 291 passed / 13 failed in 3 files; build exit 0; fix commit 765302d8c9 (Prettier on src/lib/platform/commands.ts; first run on 29a738f1fc failed on Prettier: src/lib/platform/commands.ts unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1174#issuecomment-6584810383
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1174#issuecomment-6584810383)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1174` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1174`; tests `bunx vitest related --run src/lib/platform/commands.organization-update.test.ts src/lib/platform/commands.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, tests/vertical-foundation.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related tests: 13 failures in tests/vertical-foundation.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts; the identical 13 fail on develop (pre-existing, not introduced). 291 other related tests pass.
- Decisions: qa verdict set to PASS by hand: Develop already guards organization.update; this PR moves the guard into one shared assertDedicatedProvisioningConfigured() used by create and update with identical behaviour: it still runs after the row lock and current-state read, an unchanged DEDICATED mode never checks the config, and the tests  | F1 (qa) confirmed by skeptics: The refactored organization.update guard is not Prettier-formatted, so this PR adds a formatting failure to a file it changes. Develop's commands.ts passes Prettier; the PR head does not. The repo's QA gate runs `prettie

### #1173 · DEV-186 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1173 · branch `codex/dev-186-local-recovery-20261102` · head `546467ede4` · group 1
- Title: DEV-186: Preserve frozen service charge across partial tender settlement
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 546467ede4: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 36 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1173#issuecomment-6584725142
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1173#issuecomment-6584725142)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1173` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1173`; tests `bunx vitest related --run src/lib/restaurant/tenders.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

## Group 2 (#1148-#1166)

### #1166 · DEV-52 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1166 · branch `codex/dev-52-recover-20261102` · head `93eac69168` · group 2
- Title: DEV-52: Scope command search to licensed categories
- Verdicts: machine ran, see below · QA FAIL (partial) · Security FAIL (partial)
- Done so far: checks on 93eac69168: typecheck exit 2 (0 new vs baseline); eslint 4 errors; tests 153 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on codex/dev-52-recover-20261102 for: machine-check failure listed below
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1166` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1166`; tests `bunx vitest related --run src/components/layout/topbar.search-licensing.test.tsx src/components/layout/topbar.tsx src/components/ui/command.tsx src/lib/search-access.ts src/server/routers/search.test.ts src/server/routers/search.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW eslint: src/components/layout/topbar.search-licensing.test.tsx:15 react/display-name Component definition is missing display name | NEW eslint: src/components/layout/topbar.search-licensing.test.tsx:18 react/display-name Component definition is missing display name | NEW eslint: src/components/layout/topbar.search-licensing.test.tsx:26 react/display-name Component definition is missing display name | NEW eslint: src/components/layout/topbar.search-licensing.test.tsx:32 react/display-name Component definition is missing display name | NEW test failure: src/components/layout/topbar.search-licensing.test.tsx > command palette category search licensing keeps all five groups and selection available for a fully licensed agency | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: PR-introduced failures in its new test file src/components/layout/topbar.search-licensing.test.tsx: 4 ESLint react/display-name errors (lines 15,18,26,32) and 1 failing test ('keeps all five groups and selection available for a fully licensed agency': no button named 'Matching task Matching project'). File does not exist on develop.

### #1165 · DEV-96 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1165 · branch `codex/dev-96-recover-20261102` · head `6855b75dca` · group 2
- Title: DEV-96: enforce pharmacy record retention periods
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 6855b75dca: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 717 passed / 4 failed in 4 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1165`, then post comments/1165.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1165` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1165`; tests `bunx vitest related --run src/lib/pharmacy/retention.test.ts src/lib/pharmacy/retention.ts tests/pharmacy-retention.test.mjs` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related tests: 4 DB test files fail (pharmacy-offline.db #710 manual totals, pharmacy-sales.drawer-close.db branch refusals x2, counter-evidence.db CAM-2 replay, duplicate-salt-acknowledgement.db prisma create). The identical tests fail on develop (pre-existing). The PR's own retention tests pass.

### #1164 · DEV-108 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1164 · branch `codex/dev-108-recover-20261102` · head `a4f02fc8a4` · group 2
- Title: DEV-108: Clarify pharmacy access-denial guidance
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on a4f02fc8a4: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 27 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1164`, then post comments/1164.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1164` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1164`; tests `bunx vitest related --run src/app/(app)/pharmacy/reports/page.test.tsx src/app/(app)/pharmacy/reports/page.tsx src/components/pharmacy/counter/day-close-console.test.tsx src/components/pharmacy/counter/day-close-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1163 · DEV-97 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1163 · branch `codex/dev-97-recover-20261102` · head `82827d16fd` · group 2
- Title: DEV-97: Gate counter settlement controls by capability
- Verdicts: machine ran, see below · QA FAIL (partial) · Security FAIL (partial)
- Done so far: checks on 82827d16fd: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 518 passed / 2 failed in 2 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1163`, then post comments/1163.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1163` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1163`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/server/routers/pharmacy-sales.open-drawer.test.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related tests: 2 DB test files fail (pharmacy-sales.drawer-close.db branch refusals x2, duplicate-salt-acknowledgement.db prisma create); identical failures on develop (pre-existing). 516 other related tests pass.

### #1162 · DEV-41 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1162 · branch `codex/dev-41-recover-20261102` · head `87130c9b05` · group 2
- Title: DEV-41: Restore direct Counter sign-out and remove payment sandbox
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 87130c9b05: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 132 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1162`, then post comments/1162.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1162` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1162`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1161 · DEV-94 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1161 · branch `codex/dev-94-recover-20261102` · head `c42d7aca78` · group 2
- Title: DEV-94: Add pharmacy PostgreSQL backup and restore drill tooling
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on c42d7aca78: typecheck exit 2 (1 new vs baseline); eslint 0 errors; tests 26 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on codex/dev-94-recover-20261102 for: machine-check failure listed below
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1161` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1161`; tests `bunx vitest related --run tests/postgres-backup.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW typecheck: tests/postgres-backup.test.ts: error TS2741: Property 'NODE_ENV' is missing in type '{ PATH: string; FIXTURE_ROOT: string; TMPDIR: string; PGHOST: string; PGPORT: string; PGUSER: string; PGDATABASE: s | note: NEW typecheck error in the PR's new tests/postgres-backup.test.ts: TS2741 Property 'NODE_ENV' is missing in the env object passed as ProcessEnv.

### #1160 · DEV-98 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1160 · branch `codex/dev-98-recover-20261102` · head `d832236d94` · group 2
- Title: DEV-98: Configure emergency-supply caps by jurisdiction
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on d832236d94: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 1372 passed / 22 failed in 8 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1160`, then post comments/1160.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1160` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1160`; tests `bunx vitest related --run src/lib/pharmacy/controlled-register.test.ts src/lib/pharmacy/controlled-register.ts src/lib/platform/commands.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/lib/pharmacy/stock-ledger.db.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts, tests/vertical-foundation.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1157 · DEV-62 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1157 · branch `codex/dev-62-recover-20261102` · head `4c7b6768b8` · group 2
- Title: DEV-62: Add report date controls and accurate import reference labels
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 4c7b6768b8: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 7 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1157`, then post comments/1157.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1157` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1157`; tests `bunx vitest related --run src/app/(app)/pharmacy/inventory/imports/page.test.tsx src/app/(app)/pharmacy/inventory/imports/page.tsx src/app/(app)/pharmacy/reports/branch-comparison/date-controls.test.tsx src/app/(app)/pharmacy/reports/branch-comparison/page.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1156 · DEV-59 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1156 · branch `codex/dev-59-recover-20261102` · head `4b437e5aa8` · group 2
- Title: DEV-59: Restore bounded owner expiry advice
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 4b437e5aa8: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 219 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1156`, then post comments/1156.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1156` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1156`; tests `bunx vitest related --run src/lib/pharmacy/expiry-advisor-operations.ts src/server/routers/pharmacy-reports.test.ts src/server/routers/pharmacy-reports.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1155 · DEV-44 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1155 · branch `codex/dev-44-recover-20261102` · head `7365a9b98d` · group 2
- Title: DEV-44: Restore grouped owner navigation and dismissible onboarding
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 7365a9b98d: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 282 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on codex/dev-44-recover-20261102 for: machine-check failure listed below
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1155` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1155`; tests `bunx vitest related --run src/app/(app)/settings/settings-content.tsx src/components/layout/sidebar.test.tsx src/components/layout/sidebar.tsx src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/components/restaurant/administrator-staff-profile-callout.test.tsx src/components/restaurant/administrator-staff-profile-callout.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW test failure: src/components/layout/sidebar.test.tsx > Restaurant desktop navigation groups marks the active group and destination, opens by keyboard and restores focus on Escape | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: REGRESSION: src/components/layout/sidebar.test.tsx 'Restaurant desktop navigation groups marks the active group and destination, opens by keyboard and restores focus on Escape' fails on the PR (no menuitem 'Inventory Current') and passes on develop.

### #1154 · DEV-315 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1154 · branch `codex/dev-315-recover-20261102` · head `07cc0aaf13` · group 2
- Title: DEV-315: Guard WhatsApp STOP acknowledgement replay
- Verdicts: machine ran, see below · QA PASS (partial) · Security PASS (partial)
- Done so far: checks on 07cc0aaf13: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 31 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1154`, then post comments/1154.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1154` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1154`; tests `bunx vitest related --run src/lib/pharmacy/whatsapp/inbound.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1153 · DEV-61 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1153 · branch `codex/dev-61-recover-20261102` · head `617c185c1a` · group 2
- Title: DEV-61: Add pharmacy report print and PDF action
- Verdicts: machine ran, see below · QA PASS (partial) · Security PASS (partial)
- Done so far: checks on 617c185c1a: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 6 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1153`, then post comments/1153.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1153` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1153`; tests `bunx vitest related --run src/app/(app)/pharmacy/reports/page.test.tsx src/app/(app)/pharmacy/reports/page.tsx src/app/(app)/pharmacy/reports/report-print-button.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1152 · DEV-56 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1152 · branch `codex/dev-56-recover-20261102` · head `9504a99faa` · group 2
- Title: DEV-56: Add medicine-name search to prescription capture
- Verdicts: machine ran, see below · QA FAIL (partial) · Security PASS (partial)
- Done so far: checks on 9504a99faa: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 2 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1152`, then post comments/1152.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1152` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1152`; tests `bunx vitest related --run src/components/pharmacy/dispensing/prescriptions-console-search.test.tsx src/components/pharmacy/dispensing/prescriptions-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1151 · DEV-38 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1151 · branch `codex/dev-38-recover-20261102` · head `de8a0921f5` · group 2
- Title: DEV-38: Restore purchasing returns access for procurement roles
- Verdicts: machine ran, see below · QA PASS (partial) · Security PASS (partial)
- Done so far: checks on de8a0921f5: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 226 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1151`, then post comments/1151.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1151` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1151`; tests `bunx vitest related --run src/app/(app)/pharmacy/purchasing/returns/page.test.tsx src/app/(app)/pharmacy/purchasing/returns/page.tsx src/server/routers/pharmacy-purchasing.test.ts src/server/routers/pharmacy-purchasing.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1150 · DEV-45 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1150 · branch `codex/dev-45-recover-20261102` · head `d9ecb6f1aa` · group 2
- Title: DEV-45: Clarify expiry advice failures and exclude production sandbox
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks running
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1150` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1150`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1149 · DEV-54 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1149 · branch `codex/dev-54-recover-20261102` · head `2e235ef933` · group 2
- Title: DEV-54: Match effective flat packs in opening-stock imports
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 1
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1149` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1149`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1148 · DEV-5 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1148 · branch `codex/dev-5-recover-20261102` · head `07b03320a8` · group 2
- Title: DEV-5: Check goods-receipt branch before locking the purchase order
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 2
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1148` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1148`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1158 · DEV-34 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1158 · branch `codex/dev-34-recover-20261102` · head `c642d2bda9` · group 2
- Title: DEV-34: Reserve space for two-line login errors
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 3
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1158` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1158`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

## Group 3 (rest, pharmacy first)

### #1120 · DEV-211 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1120 · branch `codex/DEV-211-inventory-branch-authorization` · head `94d2052150` · group 3
- Title: DEV-211: Require inventory capability and active branch assignment
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 4
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1120` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1120`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1119 · DEV-116 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1119 · branch `codex/DEV-116-cash-flow-evidence` · head `3d56d6912e` · group 3
- Title: DEV-116: Show classification journal evidence in cash flow
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 5
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1119` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1119`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1118 · DEV-117 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1118 · branch `codex/DEV-117-balance-sheet-coverage` · head `51f920b0b6` · group 3
- Title: DEV-117: Qualify balance sheet reconciliation coverage
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 6
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1118` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1118`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1117 · DEV-118 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1117 · branch `codex/DEV-118-profit-loss-coverage` · head `ae10482456` · group 3
- Title: DEV-118: Expose profit and loss classification coverage
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 7
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1117` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1117`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1116 · DEV-135 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1116 · branch `codex/DEV-135-supplier-claim-journal` · head `7cf6f2fb1c` · group 3
- Title: DEV-135: Preserve supplier-return claim journal posting
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 8
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1116` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1116`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1114 · DEV-145 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1114 · branch `codex/DEV-145-review-assertion-limit` · head `8247167eb6` · group 3
- Title: DEV-145: Cover the review assertion limit
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 9
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1114` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1114`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1101 · DEV-198 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1101 · branch `codex/DEV-198-day-close-currency` · head `933fef04a9` · group 3
- Title: DEV-198: Use tenant currency in day-close tender totals
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 10
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1101` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1101`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1087 · DEV-199 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1087 · branch `codex/DEV-199-emergency-supply-lock` · head `c6acae6d8d` · group 3
- Title: DEV-199: Serialize emergency supply eligibility
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 11
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1087` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1087`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1086 · DEV-279 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1086 · branch `codex/DEV-279-cash-drawer-authorization` · head `4218c9a1a8` · group 3
- Title: DEV-279: Authorize cash drawer mutations and branch scope
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 12
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1086` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1086`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1072 · DEV-321 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1072 · branch `codex/DEV-321-counter-patient-entitlements` · head `d9a63c46ac` · group 3
- Title: DEV-321: Lock counter patient entitlement regression
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 13
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1072` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1072`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1068 · DEV-322 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1068 · branch `codex/DEV-322-command-centre-khata` · head `86d85bfeb7` · group 3
- Title: DEV-322: Preserve command-centre Khata branch context
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 14
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1068` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1068`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1061 · DEV-138 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1061 · branch `codex/linear-mention-dev-138-qa]-sev2]-restaurant-reports-wast` · head `c1fbb802eb` · group 3
- Title: Fix type errors in merged test fixtures
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 15
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1061` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1061`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1060 · DEV-170 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1060 · branch `codex/linear-mention-dev-170-qa]-sev2]-shifts-cancelling-an-in` · head `f88abb84b9` · group 3
- Title: test: prevent cancelling shifts with active attendance
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 16
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1060` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1060`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1056 · DEV-141 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1056 · branch `codex/linear-mention-dev-141-qa]-sev3]-restaurant-demo-seed-he` · head `45a00ae883` · group 3
- Title: fix(restaurant): assign demo head chef to kitchen role
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 17
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1056` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1056`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1050 · DEV-40 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1050 · branch `codex/linear-mention-dev-40-sev3]-medicine-reference-non-sale` · head `29b76168f4` · group 3
- Title: fix(pharmacy): derive medicine reference saleability copy
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 18
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1050` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1050`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1008 · DEV-139 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1008 · branch `codex/linear-mention-dev-139-qa]-sev3]-pharmacy-licence-scans-a` · head `cb4468aab7` · group 3
- Title: fix(files): restrict pharmacy licence evidence to admins
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 19
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1008` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1008`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1006 · DEV-53 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1006 · branch `fix/sev3-authz-group` · head `b49bbf354a` · group 3
- Title: fix(authz): capability checks for patient/consent, hotel setStatus, restaurant growth (Sev3)
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 20
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1006` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1006`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1005 · DEV-50 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1005 · branch `fix/vertical-leak-404` · head `6b58b00b6c` · group 3
- Title: fix(pharmacy): vertical gating in Settings and branded 404 for unknown tenant (QA batch 5)
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 21
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1005` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1005`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1004 · DEV-51 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1004 · branch `fix/dark-mode-tokens` · head `087149317e` · group 3
- Title: fix(ui): dark-mode theme tokens for borders, primary button edge, toggles, links and active tab
- Verdicts: machine pending · QA pending · Security PASS (partial)
- Done so far: 
- Next step: wait for machine checks queued at position 22 and QA/Security review running
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1004` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1004`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1003 · DEV-49 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1003 · branch `fix/counter-responsive` · head `bccb1b844f` · group 3
- Title: fix(pharmacy): counter, prescriptions and inventory responsive layout (QA batch 5)
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 23
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1003` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1003`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1002 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1002 · branch `feat/reports-csv-export` · head `6aea99a22d` · group 3
- Title: feat(reports): CSV export for reports, gated by reports:financial
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 24 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1002` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1002`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1001 · DEV-46 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1001 · branch `fix/reports-ops-screens` · head `63d657e346` · group 3
- Title: fix(reports,ops): Reports filters, opening stock, Day close, Settings
- Verdicts: machine pending · QA pending · Security PASS (partial)
- Done so far: 
- Next step: wait for machine checks queued at position 25 and QA/Security review running
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1001` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1001`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1000 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1000 · branch `fix/team-members-zero` · head `017d00745f` · group 3
- Title: fix(team): Team shows 0 members when users exist
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 26 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1000` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1000`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #999 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/999 · branch `fix/owner-copy-sweep` · head `942e5068e8` · group 3
- Title: fix(ui): owner copy sweep, remove internal codes and jargon
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 27 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 999` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/999`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #998 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/998 · branch `fix/counter-cashier-copy` · head `97f0b070f6` · group 3
- Title: fix(counter): plain-language copy for cashiers and hide internal tools
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 28 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 998` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/998`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #997 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/997 · branch `fix/returns-lookup-scope` · head `c9e45219ad` · group 3
- Title: fix(returns): scope receipt lookup to the cashier's branches
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 29 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 997` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/997`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #996 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/996 · branch `fix/manager-only-campaigns-close` · head `d673c26fe6` · group 3
- Title: fix(pharmacy): campaign approval/generation and day close/drawer need manager or owner (Sev2)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 30 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 996` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/996`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #995 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/995 · branch `fix/catalogue-edit-review` · head `86efbf8114` · group 3
- Title: fix(pharmacy): catalogue edits go through review (Sev2)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 31 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 995` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/995`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #994 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/994 · branch `fix/purchasing-server-authz` · head `c42983ab7e` · group 3
- Title: fix(pharmacy): server-side capability checks on every purchasing procedure (Sev1)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 32 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 994` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/994`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #993 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/993 · branch `fix/publish-creates-pack` · head `e7d00d6544` · group 3
- Title: fix(pharmacy): publishing a medicine creates its pack size and barcode so stock can be imported (Sev1)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 33 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 993` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/993`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #986 · GH#980 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/986 · branch `inky/issue-980` · head `233f2fb2b4` · group 3
- Title: feat(#980): Pharmacy leakage: agency/HR features in pharmacy tenant
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 34 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 986` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/986`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #985 · GH#978 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/985 · branch `inky/issue-978` · head `2390c2e7f9` · group 3
- Title: feat(#978): Pharmacy catalogue review: accept/reject/defer disabled for owner despite pharmacy:catalogue-review
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 35 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 985` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/985`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #984 · GH#979 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/984 · branch `inky/issue-979` · head `98e678d8e7` · group 3
- Title: feat(#979): Pharmacy: cashier over-exposure (suppliers, purchasing, nav)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 36 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 984` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/984`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #983 · GH#977 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/983 · branch `inky/issue-977` · head `4789bdb812` · group 3
- Title: feat(#977): Pharmacy regulatory: only Punjab (provisional) offered; Sindh branch can't get an in-force profile
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 37 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 983` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/983`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #982 · GH#976 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/982 · branch `inky/issue-976` · head `7b898f0abf` · group 3
- Title: feat(#976): Pharmacy inventory: Create location fails with generic "could not be completed"
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 38 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 982` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/982`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #966 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/966 · branch `salvage/restaurant-day-close` · head `f368fcc2c7` · group 3
- Title: fix: Restaurant day close net sales with refunds (salvage; likely superseded)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 39 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 966` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/966`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #965 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/965 · branch `salvage/qa-artefacts` · head `3a840db341` · group 3
- Title: docs(qa): archive restaurant/pharmacy QA runs and sev1 retest records (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 40 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 965` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/965`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #960 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/960 · branch `salvage/rx-gate-410` · head `7aff998867` · group 3
- Title: fix: Pharmacy counter Rx gate for prescription-only medicines (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 41 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 960` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/960`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #959 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/959 · branch `salvage/khata-overlimit-399` · head `4fd5b1615b` · group 3
- Title: fix: Khata over-limit override approvable by owner/manager, re-checked in txn (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 42 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 959` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/959`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #956 · GH#727 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/956 · branch `inky/issue-727` · head `795276fdce` · group 3
- Title: feat(#727): [Pharmacy] Date-based pharmacy promotions
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 43 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 956` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/956`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #955 · GH#729 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/955 · branch `inky/issue-729` · head `996265a92f` · group 3
- Title: feat(#729): [Pharmacy] Churn scoring
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 44 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 955` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/955`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #954 · GH#722 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/954 · branch `inky/issue-722` · head `7eb551b88b` · group 3
- Title: feat(#722): [Pharmacy][P1] Split tender on one sale (cash + khata + wallet)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 45 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 954` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/954`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #953 · GH#728 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/953 · branch `inky/issue-728` · head `dbf633d126` · group 3
- Title: feat(#728): [Pharmacy] AI cash-close anomaly check
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 46 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 953` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/953`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #951 · GH#439 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/951 · branch `inky/issue-439` · head `17ef2d2716` · group 3
- Title: feat(#439): [QA][sev3] Pharmacy Urdu receipts use ASCII digits and ignore the locale for numbers
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 47 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 951` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/951`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #950 · GH#661 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/950 · branch `inky/issue-661` · head `5c33b2dffe` · group 3
- Title: feat(#661): [sev3] quarantinePart gated by pharmacy:inventory instead of pharmacy:safety
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 48 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 950` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/950`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #949 · GH#716 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/949 · branch `inky/issue-716` · head `0c9fcd4793` · group 3
- Title: feat(#716): [Pharmacy][P0] Owner full data export ("no lock-in" button)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 49 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 949` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/949`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #947 · GH#720 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/947 · branch `inky/issue-720` · head `0f9ffa373f` · group 3
- Title: feat(#720): [Pharmacy][P1] Licence and registration renewal reminders
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 50 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 947` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/947`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #946 · GH#723 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/946 · branch `inky/issue-723` · head `cc456c38df` · group 3
- Title: feat(#723): [Pharmacy][P2] SMS fallback for utility messages
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 51 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 946` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/946`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #945 · GH#708 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/945 · branch `inky/issue-708` · head `563fe97150` · group 3
- Title: feat(#708): [Pharmacy][P0] Sindh cash-memo receipt mode (Drug rules r.18)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 52 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 945` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/945`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #942 · GH#732 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/942 · branch `inky/issue-732` · head `13677b4db2` · group 3
- Title: feat(#732): [Pharmacy] Live cold-chain sensor push
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 53 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 942` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/942`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #941 · GH#719 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/941 · branch `inky/issue-719` · head `d50b9018ae` · group 3
- Title: feat(#719): [Pharmacy][P1] Shelf and price sticker printing for unbarcoded or loose stock
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 54 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 941` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/941`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #940 · GH#718 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/940 · branch `inky/issue-718` · head `ab37e1eb7a` · group 3
- Title: feat(#718): [Pharmacy][P1] Non-drug retail items with promo eligibility
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 55 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 940` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/940`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #934 · GH#673 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/934 · branch `inky/issue-673` · head `0403b5b68a` · group 3
- Title: feat(#673): [Pharmacy Accounts][S3] Add read-only canonical account-code normal-side reference
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 56 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 934` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/934`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #929 · GH#660 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/929 · branch `cloud/issue-660` · head `982fb2ab3d` · group 3
- Title: fix(#660): [QA][sev2] Pharmacy activation gate: regulatory profile isn't bound to an active branch or to the branch's province/premises
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 57 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 929` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/929`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #915 · GH#526 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/915 · branch `cloud/issue-526` · head `3949ea03e1` · group 3
- Title: fix(#526): [QA][sev2] Prescription calendar validity shifts by device timezone and expires at UTC midnight
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 58 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 915` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/915`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #855 · GH#577 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/855 · branch `cloud/issue-577` · head `6ba261a378` · group 3
- Title: fix(#577): [QA][sev2] Purchasing: Branch-limited staff can read and change other branches' purchase orders
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 59 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 855` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/855`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #814 · GH#385 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/814 · branch `cloud/issue-385` · head `42829d61d8` · group 3
- Title: fix(#385): Khata reminders: language can't be set, no Urdu template, Meta provider unconfigured
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 60 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 814` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/814`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #812 · GH#381 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/812 · branch `cloud/issue-381` · head `3a5ef472fa` · group 3
- Title: fix(#381): Licence invalid 00:00–04:59 PKT on its start day; profile effective today shows as scheduled until 05:00
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 61 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 812` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/812`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #811 · GH#380 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/811 · branch `cloud/issue-380` · head `c2d57bfb2b` · group 3
- Title: fix(#380): Khata cash collections never reach the cash drawer (+250 variance at close)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 62 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 811` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/811`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #805 · GH#395 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/805 · branch `cloud/issue-395` · head `95854e0252` · group 3
- Title: fix(#395): [sev2] Goods-in reversal doesn't correct the controlled register, leaving it overstated
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 63 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 805` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/805`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #776 · GH#759 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/776 · branch `cloud/issue-759` · head `7d6b7ee3e8` · group 3
- Title: fix(#759): [Pharmacy][Growth] WhatsApp campaign cost preview from current rate card
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 64 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 776` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/776`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #769 · GH#740 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/769 · branch `cloud/issue-740` · head `9f2c33b1c7` · group 3
- Title: fix(#740): [Pharmacy][Growth] Khata collection reminders with Raast payment link
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 65 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 769` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/769`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #241 · GH#488 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/241 · branch `codex/fix-488` · head `51a8a6afb8` · group 3
- Title: fix(#488): Prescription calendar validity shifts by device timezone and expires at UTC midnight
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 66 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 241` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/241`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #132 · GH#692 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/132 · branch `codex/fix-692` · head `b8d79ee907` · group 3
- Title: fix(#692): [planned] Narrow nontrade accrual journal voucher and account catalog (CEO-JVCORE-20261025
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 67 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 132` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/132`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #66 · GH#299 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/66 · branch `fix/followup-299` · head `b6820a067c` · group 3
- Title: fix: pharmacy follow-up for #299 (revalidation required)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 68 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 66` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/66`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #63 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/63 · branch `port/consolidation-20261019` · head `1495660b84` · group 3
- Title: port: consolidation-20261019 (from Mac archive)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 69 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 63` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/63`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #37 · GH#362 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/37 · branch `fix/qa-362` · head `1fae9603a7` · group 3
- Title: Inventory write-off witnessId isn't validated as a real active tenant user (#362)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 70 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 37` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/37`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1171 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1171 · branch `dependabot/bun/develop/production-patch-51bcce1992` · head `11e2b4c073` · group 3
- Title: chore(deps): bump the production-patch group across 1 directory with 11 updates
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 71 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1171` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1171`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1170 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1170 · branch `dependabot/bun/develop/production-minor-d4c3b1f27e` · head `860fadd969` · group 3
- Title: chore(deps): bump the production-minor group across 1 directory with 21 updates
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 72 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1170` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1170`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1169 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1169 · branch `dependabot/bun/develop/development-5a0671f224` · head `9f6ab1d5b7` · group 3
- Title: chore(deps-dev): bump shadcn from 4.22.0 to 4.22.1 in the development group
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 73 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1169` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1169`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1067 · DEV-342 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1067 · branch `codex/DEV-342-sanitize-prisma-errors` · head `fa75543302` · group 3
- Title: DEV-342: Sanitize Prisma errors on stale tenant writes
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 74 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1067` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1067`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1066 · DEV-343 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1066 · branch `codex/DEV-343-command-validation` · head `ddd19ed235` · group 3
- Title: DEV-343: Sanitize platform command validation errors
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 75 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1066` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1066`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1065 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1065 · branch `codex/linear-mention-dev-171-qa]-sev3]-catering-accepted-decim` · head `a36eca5af9` · group 3
- Title: fix(catering): report durable decimal scale validation errors
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 76 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1065` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1065`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1064 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1064 · branch `codex/linear-mention-dev-177-qa]-sev2]-devices-device-revocati` · head `b31874551c` · group 3
- Title: fix(devices): enforce dedicated revoke capability
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 77 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1064` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1064`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1063 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1063 · branch `codex/linear-mention-dev-174-qa]-sev2]-menu-import-reviewed-fo` · head `328b3edd4c` · group 3
- Title: fix(menu-import): reject foreign-currency relabelling at commit
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 78 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1063` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1063`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1062 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1062 · branch `codex/linear-mention-dev-169-qa]-sev2]-workforce-shift-swaps-c` · head `b07b3a69de` · group 3
- Title: fix(workforce): prevent shift swaps from transferring attendance
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 79 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1062` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1062`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1059 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1059 · branch `codex/linear-mention-dev-160-qa]-sev2]-restaurant-reports/insig` · head `dc17a4e99f` · group 3
- Title: fix(restaurant): preserve componentized refund net sales
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 80 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1059` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1059`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1058 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1058 · branch `codex/linear-mention-dev-176-qa]-sev2]-offline-pos-modifier-re` · head `3b5bc3e06b` · group 3
- Title: fix(pos): gate offline replay on modifier price changes
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 81 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1058` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1058`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1057 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1057 · branch `codex/linear-mention-dev-156-qa]-sev2]-restaurant-sop-evidence` · head `55e555d4a5` · group 3
- Title: fix(restaurant): prevent SOP evidence attribution spoofing
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 82 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1057` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1057`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1055 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1055 · branch `codex/linear-mention-dev-157-qa]-sev2]-restaurant-refund-aware` · head `026d8d50c0` · group 3
- Title: fix(restaurant): keep close and rollup refund math aligned
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 83 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1055` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1055`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1054 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1054 · branch `codex/linear-mention-dev-179-qa]-sev2]-low-stock-rules-low-sto` · head `07a5a270d1` · group 3
- Title: fix(restaurant): enforce low-stock branch authorization
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 84 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1054` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1054`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1053 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1053 · branch `codex/linear-mention-dev-149-qa]-sev2]-restaurant-menu-publica` · head `e825149863` · group 3
- Title: fix(restaurant): resolve all-channel menus at POS
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 85 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1053` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1053`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1052 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1052 · branch `codex/linear-mention-dev-168-qa]-sev2]-printing-read-only-user` · head `7629f9f99c` · group 3
- Title: fix(printing): prevent read-only users from fabricating print jobs
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 86 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1052` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1052`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1051 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1051 · branch `codex/linear-mention-dev-175-qa]-sev2]-menu-import-approving-a` · head `01e1d3bc7e` · group 3
- Title: fix(menu-import): require review of extracted variant prices
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 87 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1051` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1051`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1007 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1007 · branch `fix/af-tool-choice-auto` · head `ea71f38e08` · group 3
- Title: feat(ask-fathom): remove forced requestLeave tool_choice
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 88 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1007` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1007`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #964 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/964 · branch `salvage/hotel-p1-p2` · head `b1d83d2046` · group 3
- Title: feat(hotel): reservations, front desk, folio ledger, housekeeping, rate plans (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 89 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 964` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/964`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #963 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/963 · branch `salvage/growth-g1-followup` · head `5bb6d451e0` · group 3
- Title: chore: Growth G1 models follow-up (salvage; likely superseded)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 90 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 963` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/963`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #962 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/962 · branch `salvage/agency-projects-idor-456` · head `d151ac7749` · group 3
- Title: fix: Agency REST projects verify clientId/memberIds belong to org (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 91 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 962` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/962`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #961 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/961 · branch `salvage/comp-permission-368` · head `5dda021768` · group 3
- Title: fix: Restaurant comp gated on orders:complimentary, add orders:comp (salvage)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 92 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 961` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/961`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #906 · GH#640 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/906 · branch `cloud/issue-640` · head `0665575cd5` · group 3
- Title: fix(#640): [QA][sev3] API docs advertise PATCH /api/v1/projects/{id} and /clients/{id}, but routes export only GET/DELETE
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 93 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 906` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/906`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #903 · GH#572 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/903 · branch `cloud/issue-572` · head `1209e9b318` · group 3
- Title: fix(#572): [QA][sev3] Tax profiles: Preset effective dates start at UTC midnight instead of branch midnight
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 94 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 903` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/903`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #902 · GH#551 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/902 · branch `cloud/issue-551` · head `9bed1639ed` · group 3
- Title: fix(#551): [QA][sev3] Persisted role grants bypass mandatory resignation-review resource constraints
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 95 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 902` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/902`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #888 · GH#448 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/888 · branch `cloud/issue-448` · head `e597375dd8` · group 3
- Title: fix(#448): [QA][sev3] Agency invoices: create form has no tax input (always sends tax 0) and discounts aren't supported anywhere
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 96 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 888` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/888`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #887 · GH#438 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/887 · branch `cloud/issue-438` · head `06a3a56277` · group 3
- Title: fix(#438): [QA][sev3] Agency invoice status dropdown offers transitions the server rejects
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 97 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 887` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/887`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #886 · GH#429 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/886 · branch `cloud/issue-429` · head `f19aed5a07` · group 3
- Title: fix(#429): [QA][sev3] Resending an invite while an old-token accept is mid-hash lets the old request claim the new row
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 98 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 886` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/886`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #882 · GH#383 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/882 · branch `cloud/issue-383` · head `62f1b9e42b` · group 3
- Title: fix(#383): #282 pg_trgm grant migration grants nothing when the migrator doesn't own the extension
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 99 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 882` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/882`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #875 · GH#371 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/875 · branch `cloud/issue-371` · head `21eefe8f62` · group 3
- Title: fix(#371): No way to reverse a mistaken comp; recut locked after any tender
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 100 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 875` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/875`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #872 · GH#367 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/872 · branch `cloud/issue-367` · head `bf8248f190` · group 3
- Title: fix(#367): Order ticket shows live gross service, not the bill's service
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 101 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 872` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/872`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #864 · GH#314 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/864 · branch `cloud/issue-314` · head `18653d3c14` · group 3
- Title: fix(#314): [QA][P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently truncates at 500 rows
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 102 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 864` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/864`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #863 · GH#310 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/863 · branch `cloud/issue-310` · head `ad17ea5b29` · group 3
- Title: fix(#310): [QA][P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below minimum target size on both login forms
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 103 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 863` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/863`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #862 · GH#308 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/862 · branch `cloud/issue-308` · head `9607c71db6` · group 3
- Title: fix(#308): [QA][P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abyss/brass utilities, and controls that bypass the radius scale
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 104 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 862` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/862`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #854 · GH#570 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/854 · branch `cloud/issue-570` · head `2414d1daeb` · group 3
- Title: fix(#570): [QA][sev2] Daily close: Unbilled active orders can create unpayable bills after close
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 105 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 854` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/854`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #853 · GH#568 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/853 · branch `cloud/issue-568` · head `46a558a16c` · group 3
- Title: fix(#568): [QA][sev2] Daily close: Future dates can be closed before trading begins
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 106 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 853` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/853`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #850 · GH#458 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/850 · branch `cloud/issue-458` · head `eb5b9445b0` · group 3
- Title: fix(#458): [QA][sev2] Agency invoice print/PDF shows DevFathom as the seller instead of the agency
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 107 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 850` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/850`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #841 · GH#440 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/841 · branch `cloud/issue-440` · head `2672d2a1b9` · group 3
- Title: fix(#440): [QA][sev2] Agency invoices: Mark paid sets PAID without recording a payment, so the balance is wrong and payment entry is hidden
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 108 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 841` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/841`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #838 · GH#435 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/838 · branch `cloud/issue-435` · head `956fd61876` · group 3
- Title: fix(#435): [QA][sev2] Agency team: team:setRole is never checked, so an ADMIN denied it can still grant or revoke roles
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 109 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 838` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/838`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #305 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/305 · branch `dependabot/bun/develop/eslint-10.11.0` · head `5b0e61bad9` · group 3
- Title: chore(deps-dev): bump eslint from 9.39.5 to 10.11.0
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 110 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 305` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/305`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #304 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/304 · branch `dependabot/bun/develop/typescript-7.0.2` · head `a1b770fdb9` · group 3
- Title: chore(deps-dev): bump typescript from 5.9.3 to 7.0.2
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 111 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 304` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/304`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #286 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/286 · branch `recover/followup-rgap-jobs` · head `b010a3a720` · group 3
- Title: recover: dead-letter exhausted stale jobs; idempotent dead-job requeue
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 112 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 286` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/286`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #275 · GH#508 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/275 · branch `codex/fix-508` · head `e0138d8ecf` · group 3
- Title: fix(#508): Future-dated approved resignations never execute scheduled offboarding
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 113 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 275` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/275`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #262 · GH#556 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/262 · branch `codex/fix-556` · head `3b4029472d` · group 3
- Title: fix(#556): Menu import: Approving a line imports variant prices the reviewer cannot see
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 114 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 262` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/262`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #261 · GH#554 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/261 · branch `codex/fix-554` · head `4300993728` · group 3
- Title: fix(#554): SOP escalation: Configured escalation policies never receive production jobs
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 115 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 261` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/261`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #259 · GH#539 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/259 · branch `codex/fix-539` · head `542c55e707` · group 3
- Title: fix(#539): Tax quotation: Multi-quantity previews round tax differently from settlement
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 116 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 259` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/259`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #253 · GH#222 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/253 · branch `codex/fix-222` · head `f784f018c0` · group 3
- Title: fix(#222): Dark-theme info status pill nearly invisible on branch settings
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 117 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 253` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/253`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #212 · GH#567 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/212 · branch `codex/fix-567` · head `0b36f53fe0` · group 3
- Title: fix(#567): SOP verification: A verifier can invent the second identity for an SOP waiver
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 118 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 212` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/212`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #149 · GH#169 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/149 · branch `codex/fix-169` · head `3810030f8e` · group 3
- Title: fix(#169): [Platform][sev4] JWT session cookie is reissued on every session read
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 119 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 149` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/149`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #146 · GH#7 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/146 · branch `codex/fix-7` · head `e2673832e4` · group 3
- Title: fix(#7): [P2][Admin] Documented local setup cannot work — seed and prisma.config read .env only, 
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 120 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 146` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/146`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #145 · GH#6 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/145 · branch `codex/fix-6` · head `fac67d55ea` · group 3
- Title: fix(#6): [P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below min
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 121 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 145` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/145`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #144 · GH#4 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/144 · branch `codex/fix-4` · head `ada54fa59e` · group 3
- Title: fix(#4): [P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abys
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 122 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 144` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/144`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #140 · GH#639 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/140 · branch `codex/fix-639` · head `19d4093fba` · group 3
- Title: fix(#639): [sev2] AI routing: no seeded model prices and a provider-wide $3/$15 fallback make the Ant
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 123 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 140` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/140`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #136 · GH#409 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/136 · branch `codex/fix-409` · head `48a3a9699a` · group 3
- Title: fix(#409): [sev3] Agency invoice list always shows $ even for PKR invoices
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 124 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 136` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/136`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #133 · GH#11 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/133 · branch `codex/fix-11` · head `82b6d5cbd8` · group 3
- Title: fix(#11): [P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently tr
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 125 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 133` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/133`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #105 · GH#258 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/105 · branch `codex/fix-258` · head `4ccf84c2c1` · group 3
- Title: fix(#258): Reminder quiet-hour skips counted as skippedNoConsent; weekly dedupe key uses UTC epoch we
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 126 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 105` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/105`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #104 · GH#257 · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/104 · branch `codex/fix-257` · head `0fa65aac13` · group 3
- Title: fix(#257): Show password toggle has tabindex -1
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 127 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 104` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/104`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #59 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/59 · branch `docs/deploy-ops-security` · head `181616a6ac` · group 3
- Title: docs: AWS staging, runbook, environment variables and security overview
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 128 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 59` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/59`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #57 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/57 · branch `docs/restaurant-guide` · head `e73ccce445` · group 3
- Title: docs: restaurant guide and glossary (PR 3)
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 129 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 57` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/57`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #56 · ? · not started
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/56 · branch `docs/dev-onboarding-architecture` · head `a98f887528` · group 3
- Title: docs: developer onboarding, architecture, auth and roles, testing, contributing
- Verdicts: machine pending · QA pending · Security pending
- Done so far: 
- Next step: wait for machine checks queued at position 130 and QA/Security review queued in a review workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 56` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/56`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
