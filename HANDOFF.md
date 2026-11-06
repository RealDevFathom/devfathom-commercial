# PR review handoff log

_Generated 2026-11-06 18:36 UTC from the live run state by `handoff/scripts/gen-handoff.py`. Do not hand-edit item sections; edit the resume note instead._

## Resume here

- **Resumed 2026-11-06 after a container restart.** Postgres was restarted on :55432 (`pg_ctl -D /var/lib/postgresql/gate ... start`), both check lanes and the 15-minute sync loop were restarted, and the `develop` typecheck baseline was recomputed at its new tip (11660b315). The old one is kept as `baseline/typecheck.47518cbf….errors`.
- **Next action:** collect the four resumed fix workflows (runs wf_765ba5fc-dfd, wf_cf736169-bea, wf_4fd07e08-c5b, wf_19f25756-22c). Cached fixes replay and their re-reviews run; unstarted fixes run live, and six of them reuse their interrupted attempts from `partial/<n>.patch`. Record each fix and re-review in `fixes.json` and `overrides.json`, queue the PR's re-check, and post when ready (`ready-to-post.py` → `compose.py` → poster).
- **Also in flight:** the #1068 fix was finished by hand and pushed (53af03e404); its re-review runs in wf_1e4540f8-93f. The #259 verification is resuming in wf_91b9c8e3-d35. Dependabot #1171 and #1170 were rebased, so they are being re-reviewed in wf_8008ac3a-a8e and re-checked.
- **Other owners (not touched; see `other-owner.json`):** #1223 (another session still pushing); #1120 and #1086 (taken over by another Claude session on Nov 4, which merged develop and did DEV-660/DEV-659 work on top of our fixes); #999, #995 and #994 (their owners pushed new commits after review).
- **Closed or merged since the run:** #1224 (merged), #1154, #1087, #1061 and #965 (closed). They need no further work.
- **Not merging:** the original task said never merge. #1225 is this session's tracking-only PR and conflicts with the root HANDOFF.md that #1224 put on develop.
- **Half-written / uncommitted:** nothing outside the partial patches above.

## Progress

- Scope: every open PR into develop without a QA+Security verdict comment: group 1 #1172-#1194 (22, plus #1223 and #1224 opened during the run; #1225 is this tracking PR and is not reviewed), group 2 #1148-#1166 (18), group 3 the other 127 (pharmacy first). 118 older PRs already had verdict comments and are out of scope.
- Status: done 50 · in progress 119 · blocked 0 · not started 0 (of 169)
- Machine-check queue (96 left, two lanes, runs serially per lane): 1101 1005 1003 1002 1171 1170 982 966 960 959 956 955 954 953 951 950 949 947 946 945 942 941 940 934 929 915 855 814 812 811 805 776 769 241 132 66 63 37 1169 1067 …
- Last finished checks: #1224@d34637b9, #985@2390c2e7, #986@88ebf1fd, #1119@26c273f3, #1120@cf3dd149, #1118@ba2c5d21

### Posted verdicts

| PR | DEV | Machine | QA | Security | Fix commit | Comment |
|---|---|---|---|---|---|---|
| #1224 | none (no DEV-<n> or #<n> in title; Linear search for 'SehatCart QA' finds only product-finding issues such as DEV-31 and DEV-32, no tracking issue for this pass) | PASS | PASS | PASS | d34637b9f2 | https://github.com/RealDevFathom/devfathom-commercial/pull/1224#issuecomment-6590933250 |
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
| #1166 | DEV-52 | PASS | PASS | PASS | 4d41f84234 | https://github.com/RealDevFathom/devfathom-commercial/pull/1166#issuecomment-6586971839 |
| #1165 | DEV-96 | PASS | PASS | PASS | 7601bd98b2 | https://github.com/RealDevFathom/devfathom-commercial/pull/1165#issuecomment-6587466202 |
| #1164 | DEV-108 | PASS | PASS | PASS | 019e88945f | https://github.com/RealDevFathom/devfathom-commercial/pull/1164#issuecomment-6586437849 |
| #1163 | DEV-97 | PASS | PASS | PASS | 7b48d2dbb7 | https://github.com/RealDevFathom/devfathom-commercial/pull/1163#issuecomment-6587210488 |
| #1162 | DEV-41 | PASS | PASS | PASS | 6dbe145dc0 | https://github.com/RealDevFathom/devfathom-commercial/pull/1162#issuecomment-6587563143 |
| #1161 | DEV-94 | PASS | PASS | PASS | 7013e12df3 | https://github.com/RealDevFathom/devfathom-commercial/pull/1161#issuecomment-6586424269 |
| #1160 | DEV-98 | PASS | PASS | PASS | 37efd2c137 | https://github.com/RealDevFathom/devfathom-commercial/pull/1160#issuecomment-6587355151 |
| #1157 | DEV-62 | PASS | PASS | PASS | 87d91d58f8 | https://github.com/RealDevFathom/devfathom-commercial/pull/1157#issuecomment-6587454766 |
| #1156 | DEV-59 | PASS | PASS | PASS | eca3272cdc | https://github.com/RealDevFathom/devfathom-commercial/pull/1156#issuecomment-6587633672 |
| #1155 | DEV-44 | PASS | PASS | PASS | 098316e48b | https://github.com/RealDevFathom/devfathom-commercial/pull/1155#issuecomment-6587577972 |
| #1154 | DEV-315 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1154#issuecomment-6585868111 |
| #1153 | DEV-61 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1153#issuecomment-6585868983 |
| #1152 | DEV-56 | PASS | PASS | PASS | 63c8b16f8d | https://github.com/RealDevFathom/devfathom-commercial/pull/1152#issuecomment-6587648248 |
| #1151 | DEV-38 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1151#issuecomment-6585877060 |
| #1150 | DEV-45 | PASS | PASS | PASS | bc698680e4 | https://github.com/RealDevFathom/devfathom-commercial/pull/1150#issuecomment-6586598514 |
| #1149 | DEV-54 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1149#issuecomment-6585878790 |
| #1148 | DEV-5 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1148#issuecomment-6585886688 |
| #1158 | DEV-34 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1158#issuecomment-6586426422 |
| #1116 | DEV-135 | FAIL | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1116#issuecomment-6590465140 |
| #1114 | DEV-145 | PASS | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1114#issuecomment-6590462689 |
| #1087 | DEV-199 | PASS | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1087#issuecomment-6590471058 |
| #1072 | DEV-321 | FAIL | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1072#issuecomment-6590472636 |
| #1061 | DEV-138 | PASS | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1061#issuecomment-6590478994 |
| #1056 | DEV-141 | FAIL | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1056#issuecomment-6590481307 |
| #1050 | DEV-40 | PASS | PASS | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1050#issuecomment-6589314697 |
| #1008 | DEV-139 | PASS | FAIL | PASS |  | https://github.com/RealDevFathom/devfathom-commercial/pull/1008#issuecomment-6590486359 |
| #1006 | DEV-53 | PASS | PASS | PASS | 63af85e15b | https://github.com/RealDevFathom/devfathom-commercial/pull/1006#issuecomment-6590488301 |

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
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1223 · branch `saad/nice-thompson-99m17p` · head `1acec91c49` · group 1
- Title: None
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1223` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1223`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1224 · none (no DEV-<n> or #<n> in title; Linear search for 'SehatCart QA' finds only product-finding issues such as DEV-31 and DEV-32, no tracking issue for this pass) · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1224 · branch `saad/great-brown-id2w5x` · head `ba39aa5f24` · group 1
- Title: None
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: fix commit d34637b9f2 (Prettier on the 95 new md/json/mjs files; first run on 1f73675728 failed on Prettier: 95 of the PR's 98 new md/json/mjs files unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1224#issuecomment-6590933250
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1224#issuecomment-6590933250)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1224` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1224`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: qa verdict set to PASS by hand: First review FAIL (95 of the 98 new .md/.json/.mjs files failed the prettier --check the QA gate runs on changed files), fixed in d34637b9f2. Docs/evidence/harness only: nothing in src/ changes, no credentials or session tokens are committed, and all 74 file:line citations in qa-report.md resolve on | F1 (qa) confirmed by skeptics: The receipt HTML evidence is written to a hardcoded absolute path. This ignores QA_REPO and QA_EVIDENCE, the env overrides the README and lib.mjs offer so that another agent or machine can take over. | F2 (qa) confirmed by skeptics: The W6 next step in HANDOFF.md is `sweep.mjs desk-dark 1440 900 dark`. That run would produce light-mode screenshots labelled as dark, which gives a false dark-theme pass for the QA report. | F3 (qa) confirmed by skeptics: The handoff log misses two fields the user request requires per item: the PR number and URL, and the work done with commit SHAs. | F4 (qa) confirmed by skeptics: The PR is incomplete by its own scope. The two final deliverables the PR description promises, and makes a merge precondition, are missing, and most workstreams are still open.

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

### #1166 · DEV-52 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1166 · branch `codex/dev-52-recover-20261102` · head `4d41f84234` · group 2
- Title: DEV-52: Scope command search to licensed categories
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 4d41f84234: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 156 passed / 0 failed in 0 files; build exit 0; fix commit 4d41f84234 (gates palette team search on team:view, restores the forced-colors focus outline, fixes the new test and its lint errors, applies Prettier; first run on 93eac69168 failed on 1 new failing test and 4 ESLint react/display-name errors in the new topbar.search-licensing.test.tsx, plus Prettier on 4 changed files); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1166#issuecomment-6586971839
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1166#issuecomment-6586971839)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1166` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1166`; tests `bunx vitest related --run src/components/layout/topbar.search-licensing.test.tsx src/components/layout/topbar.tsx src/components/ui/command.tsx src/lib/search-access.ts src/server/routers/search.test.ts src/server/routers/search.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: PR-introduced failures in its new test file src/components/layout/topbar.search-licensing.test.tsx: 4 ESLint react/display-name errors (lines 15,18,26,32) and 1 failing test ('keeps all five groups and selection available for a fully licensed agency': no button named 'Matching task Matching project'). File does not exist on develop.
- Decisions: qa verdict set to PASS by hand: At 4d41f8423 the fully licensed agency test clicks the task button inside the Tasks group. It still checks push('/projects/p1') and that the dialog closes, and both PR test files pass locally (34 tests). Tailwind 4.3.3 compiles not-forced-colors:focus-visible:outline-none! to an @media not (forced-c | security verdict set to PASS by hand: At 4d41f8423, search.global runs the team query only when the hr licence and can(team:view) both allow it, the same ABAC check team.getAll/getRoster use. A denied member gets no directory rows and no email-match probe. The new tests run the real engine: a team:view override DENY and a custom-role te | B1 (qa) confirmed by skeptics: The new acceptance test 'keeps all five groups and selection available for a fully licensed agency' always fails. It queries a button by an accessible name that the rendered markup never produces. | B2 (qa) confirmed by skeptics: The forced-colors outline fallback the PR describes does not exist. `forced-colors:focus-visible:outline-auto!` is not a Tailwind 4 utility, so it generates no CSS. Meanwhile `focus-visible:outline-none!` removes the glo | SEC-1166-1 (security) confirmed by skeptics: The palette's team search is gated only on the 'hr' licence and ignores the ABAC 'team:view' permission. Custom roles and user_permission_overrides can DENY that capability, and every other directory read honours the den

### #1165 · DEV-96 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1165 · branch `codex/dev-96-recover-20261102` · head `7601bd98b2` · group 2
- Title: DEV-96: enforce pharmacy record retention periods
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 7601bd98b2: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 735 passed / 4 failed in 4 files; build exit 0; fix commit 7601bd98b2 (restores hold/resume and quotation reopening, keeps updates off the retention mutex, fixes the void-returning lock query, and schedules the AUDIT purge job with DB tests; first run on 6855b75dca failed on Prettier: src/lib/pharmacy/retention.ts and the new tests/pharmacy-retention.test.mjs unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1165#issuecomment-6587466202
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1165#issuecomment-6587466202)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1165` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1165`; tests `bunx vitest related --run src/lib/pharmacy/retention-owners.db.test.ts src/lib/pharmacy/retention-owners.ts src/lib/pharmacy/retention.test.ts src/lib/pharmacy/retention.ts src/lib/platform/jobs.composition.test.ts src/lib/platform/jobs.ts tests/pharmacy-retention.test.mjs` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related tests: 4 DB test files fail (pharmacy-offline.db #710 manual totals, pharmacy-sales.drawer-close.db branch refusals x2, counter-evidence.db CAM-2 replay, duplicate-salt-acknowledgement.db prisma create). The identical tests fail on develop (pre-existing). The PR's own retention tests pass.
- Decisions: qa verdict set to PASS by hand: Verified 7601bd98b on a disposable PostgreSQL 16. The SQL fixture passes and fails on the old migration. Held and quoted carts reopen; COMPLETED/VOID carts cannot. Counter updates skip the mutex, and a line delete waits for the sale's completion and is then refused. retention-owners.db.test passes u | security verdict set to PASS by hand: Re-checked 7601bd98b. The audit purge runs per tenant in withTenantDb (RLS-scoped) with parameterized tagged SQL only. It deletes exactly one row by organization and id, or throws. Each candidate is rechecked under the mutex and the DB guards. The cron is secret-gated and queues pharmacy tenants onl | F1 (qa) confirmed by skeptics: The new pharmacy_sales UPDATE row guard rejects every transition from a non-OPEN status to OPEN, not only transitions from completed fiscal records. That breaks the existing hold/resume and quotation-conversion features  | F2 (qa) confirmed by skeptics: A single platform-wide mutex row is locked by BEFORE UPDATE statement triggers on pharmacy_sales, every fiscal child table and audit_logs, and the lock is held until commit. Every pharmacy counter write (add line, hold,  | F3 (qa) confirmed by skeptics: The issue's requirement "purge job outside it" is not met. develop plus this PR has no scheduled or invocable purge. runPharmacyRetentionPurge has no callers and no record-owner adapters exist, so records past their wind | F4 (qa) confirmed by skeptics: The purge coordinator takes its lock with $queryRaw on a void-returning function. The Prisma 7 pg adapter cannot deserialize a void column, so every runPharmacyRetentionPurge call throws at the lock step and rolls back. 

### #1164 · DEV-108 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1164 · branch `codex/dev-108-recover-20261102` · head `019e88945f` · group 2
- Title: DEV-108: Clarify pharmacy access-denial guidance
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 019e88945f: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 27 passed / 0 failed in 0 files; build exit 0; fix commit 019e88945f (Prettier on the reports page and its test; first run on a4f02fc8a4 failed on Prettier: src/app/(app)/pharmacy/reports/page.tsx and page.test.tsx unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1164#issuecomment-6586437849
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1164#issuecomment-6586437849)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1164` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1164`; tests `bunx vitest related --run src/app/(app)/pharmacy/reports/page.test.tsx src/app/(app)/pharmacy/reports/page.tsx src/components/pharmacy/counter/day-close-console.test.tsx src/components/pharmacy/counter/day-close-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: Reports now names the missing operational reports permission or the Pharmacy Reports module and says the workspace administrator can fix it; tests cover the permission, module, sign-in and unrelated-failure cases. The reviewer flagged that Day close still blocks a non-admin pharmacy:close holder on  | F1 (qa) refuted by skeptics: Day close is still wrong for the persona in the issue. The client gate still requires the tenant ADMIN role, and the new text sends a pharmacist to have a 'day-close permission' reviewed. But the server already lets that

### #1163 · DEV-97 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1163 · branch `codex/dev-97-recover-20261102` · head `7b48d2dbb7` · group 2
- Title: DEV-97: Gate counter settlement controls by capability
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 7b48d2dbb7: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 522 passed / 2 failed in 2 files; build exit 0; fix commit 7b48d2dbb7 (requires pharmacy:counter for openDrawer on the server and adds the pharmacist FORBIDDEN tests; first run on 82827d16fd failed on nothing (machine checks passed; the fix is for QA/Security findings)); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1163#issuecomment-6587210488
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1163#issuecomment-6587210488)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1163` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1163`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/server/routers/pharmacy-sales.branch-scope.test.ts src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts src/server/routers/pharmacy-sales.drawer-close.db.test.ts src/server/routers/pharmacy-sales.open-drawer.test.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: Related tests: 2 DB test files fail (pharmacy-sales.drawer-close.db branch refusals x2, duplicate-salt-acknowledgement.db prisma create); identical failures on develop (pre-existing). 516 other related tests pass.
- Decisions: qa verdict set to PASS by hand: At 7b48d2dbb, openDrawer requires pharmacy:counter. The four server and test files match a1ed98277 exactly, and the only other change is the CASH/CARD dispense-only tender FORBIDDEN test. Locally, open-drawer, branch-scope and counter-receipt-auth passed 97/97 and counter-console 117/117; with the g | security verdict set to PASS by hand: 7b48d2dbb closes the openDrawer gap. The same can('pharmacy:counter') decision that tender and the UI use now runs as middleware before scopeFor, so a dispense-only pharmacist gets FORBIDDEN before any branch read or drawer write. capabilityProcedure keeps the active-session, password and demo guard | F1 (qa) confirmed by skeptics: Unmet issue requirement: DEV-97 asks to 'enforce server-side (drawer/tender capability), with FORBIDDEN tests for the pharmacist role'. In develop plus this PR, openDrawer is still a plain protectedProcedure whose only c | SEC-1163-1 (security) confirmed by skeptics: The issue asks for the drawer and tender capability to be enforced on the server, with FORBIDDEN tests for the pharmacist role. This PR only hides the controls in the UI. The drawer mutations are still plain protectedPro

### #1162 · DEV-41 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1162 · branch `codex/dev-41-recover-20261102` · head `6dbe145dc0` · group 2
- Title: DEV-41: Restore direct Counter sign-out and remove payment sandbox
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 6dbe145dc0: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 137 passed / 0 failed in 0 files; build exit 0; fix commit 6dbe145dc0 (06512703f lets a stale bill read sign out in one click; 6dbe145dc shows the sign-out reason only for payment and recovery blocks; first run on 87130c9b05 failed on nothing (machine checks passed; the fixes are for the QA finding)); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1162#issuecomment-6587563143
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1162#issuecomment-6587563143)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1162` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1162`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: First review FAIL (Sign out was disabled whenever the 30-second cart read went stale, so ending a sale took extra clicks), fixed in 06512703f: only in-progress work blocks Sign out, a cached non-OPEN bill signs out in one click, and missing, loading, stale-open or wrong-sale reads ask first. Its re- | security verdict set to PASS by hand: Neither fix commit adds data, network, storage or auth paths. Sign out stays blocked during any in-flight payment work (signOutBlocked = busy) and signOutFromCounter still rechecks its in-flight refs, so a payment-recovery block cannot be skipped. The visible reason only appears while Sign out is di | F1 (qa) confirmed by skeptics: Sign out depends on whether the cart read is fresh, not only on payment state. counterCart uses staleTime 30_000 (line 495) and nothing refetches it on a timer (refetchOnWindowFocus is false in trpc-provider). So 30 s af

### #1161 · DEV-94 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1161 · branch `codex/dev-94-recover-20261102` · head `7013e12df3` · group 2
- Title: DEV-94: Add pharmacy PostgreSQL backup and restore drill tooling
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 7013e12df3: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 26 passed / 0 failed in 0 files; build exit 0; fix commit 7013e12df3 (types the test env with NODE_ENV and applies Prettier to the new test; first run on c42d7aca78 failed on 1 new typecheck error (TS2741 in tests/postgres-backup.test.ts) and Prettier on that new file); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1161#issuecomment-6586424269
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1161#issuecomment-6586424269)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1161` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1161`; tests `bunx vitest related --run tests/postgres-backup.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: NEW typecheck error in the PR's new tests/postgres-backup.test.ts: TS2741 Property 'NODE_ENV' is missing in the env object passed as ProcessEnv.
- Decisions: qa verdict set to PASS by hand: The PR adds encrypted pg_dump-to-S3 and guarded restore scripts, a nightly systemd timer runbook and fake-command tests; the encryption, checksum, archive-check, source/target guard and migration-probe paths are handled and tested (26 tests pass). The one QA failure, a new TS2741 because the test en | F1 (qa) confirmed by skeptics: The new test file adds a typecheck error. `env` is typed as NodeJS.ProcessEnv, but it is assigned an object literal that has no NODE_ENV. Next.js adds NODE_ENV to ProcessEnv as a required property, so `tsc --noEmit` (the

### #1160 · DEV-98 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1160 · branch `codex/dev-98-recover-20261102` · head `37efd2c137` · group 2
- Title: DEV-98: Configure emergency-supply caps by jurisdiction
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 37efd2c137: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 1373 passed / 22 failed in 8 files; build exit 0; fix commit 37efd2c137 (keeps the in-force branch profile when its rule set has closed and adds the cap test; first run on d832236d94 failed on nothing (machine checks passed; the fix is for QA/Security findings)); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1160#issuecomment-6587355151
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1160#issuecomment-6587355151)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1160` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1160`; tests `bunx vitest related --run src/lib/pharmacy/controlled-register.test.ts src/lib/pharmacy/controlled-register.ts src/lib/platform/commands.ts src/server/routers/pharmacy-sales.controlled-actor.test.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/lib/pharmacy/stock-ledger.db.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts, tests/vertical-foundation.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: QA-1 is resolved in 37efd2c. The emergency-supply lookup no longer filters on the rule set's effective window, so it uses the same in-force org/branch profile as assertStoredBranchMayOperate. A closed rule set version no longer drops the province cap or nulls the audit. The new router test checks th | security verdict set to PASS by hand: 37efd2c only removes a relation filter. The profile lookup is still scoped by organizationId and branchId inside the tenant transaction, and it reads the bound rule set the same way the PLAT-02 gate does. The pharmacy:dispense check, the PIN witness with lockout, the advisory-lock eligibility check  | QA-1 (qa) confirmed by skeptics: The emergency-supply policy lookup adds a nested `jurisdictionRuleSet` effective-window filter to the in-force branch profile query. When a branch's in-force profile still points to a rule set version that has since been

### #1157 · DEV-62 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1157 · branch `codex/dev-62-recover-20261102` · head `87d91d58f8` · group 2
- Title: DEV-62: Add report date controls and accurate import reference labels
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 87d91d58f8: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 21 passed / 0 failed in 0 files; build exit 0; fix commit 87d91d58f8 (renames the Inventory link to 'Imported stock references' with a test, and applies Prettier; first run on 4c7b6768b8 failed on Prettier: 3 changed files unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1157#issuecomment-6587454766
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1157#issuecomment-6587454766)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1157` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1157`; tests `bunx vitest related --run src/app/(app)/pharmacy/inventory/imports/page.test.tsx src/app/(app)/pharmacy/inventory/imports/page.tsx src/app/(app)/pharmacy/inventory/page.test.tsx src/app/(app)/pharmacy/inventory/page.tsx src/app/(app)/pharmacy/reports/branch-comparison/date-controls.test.tsx src/app/(app)/pharmacy/reports/branch-comparison/page.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: Fix commit 87d91d58f changes the Inventory header link to 'Imported stock references' (one line in inventory/page.tsx). It also adds a test that checks the link name, its href /pharmacy/inventory/imports and that no 'awaiting verification' text renders. With the old label restored the test fails. Th | security verdict set to PASS by hand: Fix commit 87d91d58f changes only a static link label and adds test assertions, plus formatting. The link href and every other attribute are unchanged. It adds no data access, inputs, SQL, secrets or permission changes. The PR as a whole matches the earlier security review: the GET date form still f | QA-1 (qa) confirmed by skeptics: The 'Awaiting verification' item is only partly fixed. The Inventory page header button that leads to /pharmacy/inventory/imports still reads 'Imported stock / Awaiting verification'. With develop plus this PR, users sti

### #1156 · DEV-59 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1156 · branch `codex/dev-59-recover-20261102` · head `eca3272cdc` · group 2
- Title: DEV-59: Restore bounded owner expiry advice
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on eca3272cdc: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 219 passed / 0 failed in 0 files; build exit 0; fix commit eca3272cdc (stops narrowing expiry advice to the report period and applies Prettier; first run on 4b437e5aa8 failed on Prettier: src/server/routers/pharmacy-reports.test.ts unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1156#issuecomment-6587633672
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1156#issuecomment-6587633672)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1156` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1156`; tests `bunx vitest related --run src/lib/pharmacy/expiry-advisor-operations.ts src/server/routers/pharmacy-reports.test.ts src/server/routers/pharmacy-reports.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: At eca3272, expiryAdvice validates the dates and then calls readExpiryAdvice(ctx.db, branchIds) with no report-period filter. The reader again lists every unexpired lot, as on develop. The fix touches only the 3 PR files. Router, work-pack and page tests pass (84), eslint, prettier and tsc are clean | security verdict set to PASS by hand: eca3272 removes one bound Prisma.sql date filter and adds no new SQL. Access checks still run first and are unchanged: reports:financial, the module licence, the ADMIN owner role and active-branch tenant scope. Dates are still validated server-side before any read, and the FORBIDDEN and BAD_REQUEST  | QA-1156-1 (qa) confirmed by skeptics: The PR makes the forward-looking expiry advisor return only lots that expire inside the backward-looking report period. On the Reports page's default request, this removes almost every lot, including the RETURNABLE and A

### #1155 · DEV-44 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1155 · branch `codex/dev-44-recover-20261102` · head `098316e48b` · group 2
- Title: DEV-44: Restore grouped owner navigation and dismissible onboarding
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 098316e48b: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 286 passed / 0 failed in 0 files; build exit 0; fix commit 098316e48b (groups the pharmacy owner's desktop navigation, separates the 'Current' label, updates the e2e spec; first run on 7365a9b98d failed on 1 regression: sidebar.test.tsx 'marks the active group and destination...' fails (no menuitem 'Inventory Current')); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1155#issuecomment-6587577972
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1155#issuecomment-6587577972)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1155` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1155`; tests `bunx vitest related --run src/app/(app)/settings/settings-content.tsx src/components/layout/sidebar.test.tsx src/components/layout/sidebar.tsx src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/components/restaurant/administrator-staff-profile-callout.test.tsx src/components/restaurant/administrator-staff-profile-callout.tsx tests/e2e/fixtures/pharmacy-first-sale.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: REGRESSION: src/components/layout/sidebar.test.tsx 'Restaurant desktop navigation groups marks the active group and destination, opens by keyboard and restores focus on Escape' fails on the PR (no menuitem 'Inventory Current') and passes on develop.
- Decisions: qa verdict set to PASS by hand: At 098316e48 the pharmacy owner's desktop nav uses the shared Sell/Stock/Buy/Reports/Settings menus with scroll={false} links. Agency, hospitality and unlicensed pharmacy keep the flat strip. The menu item name now reads 'Inventory Current'. sidebar.test.tsx passes 60/60, while the keyboard test fai | security verdict set to PASS by hand: 098316e48 changes only client-side presentation. Pharmacy menus are built from the same permission-filtered visibleNavigation output, and leftover entries go to Settings, so nothing is dropped or added. The new ADMIN/MEMBER test checks that the hrefs equal visibleNavigation. Role, module and vertica | F1 (qa) confirmed by skeptics: The grouped Sell/Stock/Buy/Reports/Settings navigation, and the scroll-preserving links that come with it, only run for the RESTAURANT vertical. The issue was reported on the SehatCart pharmacy tenant by qa.owner, and th | F2 (qa) confirmed by skeptics: The new test 'marks the active group and destination, opens by keyboard and restores focus on Escape' cannot pass. The current menu item's accessible name is 'InventoryCurrent', with no space, because the label and the i | F3 (qa) confirmed by skeptics: The restaurant e2e accessibility matrix still expects flat restaurant links to be visible inside 'Primary navigation' at 1440px and 1024px. After this PR those links only exist inside closed dropdown menus that render in

### #1154 · DEV-315 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1154 · branch `codex/dev-315-recover-20261102` · head `07cc0aaf13` · group 2
- Title: DEV-315: Guard WhatsApp STOP acknowledgement replay
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 07cc0aaf13: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 31 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1154#issuecomment-6585868111
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1154#issuecomment-6585868111)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1154` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1154`; tests `bunx vitest related --run src/lib/pharmacy/whatsapp/inbound.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1153 · DEV-61 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1153 · branch `codex/dev-61-recover-20261102` · head `617c185c1a` · group 2
- Title: DEV-61: Add pharmacy report print and PDF action
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 617c185c1a: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 6 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1153#issuecomment-6585868983
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1153#issuecomment-6585868983)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1153` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1153`; tests `bunx vitest related --run src/app/(app)/pharmacy/reports/page.test.tsx src/app/(app)/pharmacy/reports/page.tsx src/app/(app)/pharmacy/reports/report-print-button.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1152 · DEV-56 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1152 · branch `codex/dev-56-recover-20261102` · head `63c8b16f8d` · group 2
- Title: DEV-56: Add medicine-name search to prescription capture
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 63c8b16f8d: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 3 passed / 0 failed in 0 files; build exit 0; fix commit 63c8b16f8d (only shows the no-match message for a typed search and applies Prettier; first run on 9504a99faa failed on Prettier: the new prescriptions-console-search.test.tsx unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1152#issuecomment-6587648248
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1152#issuecomment-6587648248)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1152` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1152`; tests `bunx vitest related --run src/components/pharmacy/dispensing/prescriptions-console-search.test.tsx src/components/pharmacy/dispensing/prescriptions-console.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: Checked at 63c8b16. The no-match message and the search box's aria-describedby now show only when a trimmed search is non-empty and matches nothing. With an empty catalog and an empty search, neither appears. The new empty-catalog test fails on 9504a99 and passes on 63c8b16. The search and scrolling | security verdict set to PASS by hand: Fix 63c8b16 adds only a client-side boolean guard and a component test. Medicine search still filters the tenant-scoped workspace list already in the browser. The search text never reaches the server, and React escapes the names it shows. No server, router, schema, SQL, auth or capability code chang | empty-catalog-false-no-match (qa) confirmed by skeptics: The no-match message depends only on matchingMedicines.length === 0. When the workspace has no saleable medicines and the search box is empty, the form shows 'No medicines match this search. Clear or change the name.' an

### #1151 · DEV-38 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1151 · branch `codex/dev-38-recover-20261102` · head `de8a0921f5` · group 2
- Title: DEV-38: Restore purchasing returns access for procurement roles
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on de8a0921f5: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 226 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1151#issuecomment-6585877060
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1151#issuecomment-6585877060)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1151` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1151`; tests `bunx vitest related --run src/app/(app)/pharmacy/purchasing/returns/page.test.tsx src/app/(app)/pharmacy/purchasing/returns/page.tsx src/server/routers/pharmacy-purchasing.test.ts src/server/routers/pharmacy-purchasing.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1150 · DEV-45 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1150 · branch `codex/dev-45-recover-20261102` · head `bc698680e4` · group 2
- Title: DEV-45: Clarify expiry advice failures and exclude production sandbox
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on bc698680e4: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 679 passed / 4 failed in 4 files; build exit 0; fix commit bc698680e4 (Prettier on the reports page test; first run on d9ecb6f1aa failed on Prettier: src/app/(app)/pharmacy/reports/page.test.tsx unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1150#issuecomment-6586598514
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1150#issuecomment-6586598514)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1150` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1150`; tests `bunx vitest related --run src/app/(app)/pharmacy/reports/page.test.tsx src/app/(app)/pharmacy/reports/page.tsx src/lib/pharmacy/payment-sandbox-admission.ts src/lib/pharmacy/payment-sandbox.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: qa verdict set to PASS by hand: The production sandbox guard works and is tested (paymentSandboxAdmitted returns false when NODE_ENV=production), and the main expiry advisor card now shows a proper load-error state instead of the owner-only permission copy, with tests for FORBIDDEN, UNAUTHORIZED and INTERNAL errors. The Daily work | F1 (qa) refuted by skeptics: The issue's actual symptom ('Expiry advice card shows UNAVAILABLE') is not fixed. The PR changes a different surface: the main advisor card, which on develop never rendered 'UNAVAILABLE'. Its failure branch showed the 'A

### #1149 · DEV-54 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1149 · branch `codex/dev-54-recover-20261102` · head `2e235ef933` · group 2
- Title: DEV-54: Match effective flat packs in opening-stock imports
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 2e235ef933: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 62 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1149#issuecomment-6585878790
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1149#issuecomment-6585878790)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1149` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1149`; tests `bunx vitest related --run src/lib/pharmacy/migration/owner-import.test.ts src/lib/pharmacy/migration/owner-import.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1148 · DEV-5 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1148 · branch `codex/dev-5-recover-20261102` · head `07b03320a8` · group 2
- Title: DEV-5: Check goods-receipt branch before locking the purchase order
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 07b03320a8: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 260 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1148#issuecomment-6585886688
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1148#issuecomment-6585886688)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1148` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1148`; tests `bunx vitest related --run src/lib/pharmacy/goods-receipt.ts src/server/routers/pharmacy-purchasing.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1158 · DEV-34 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1158 · branch `codex/dev-34-recover-20261102` · head `c642d2bda9` · group 2
- Title: DEV-34: Reserve space for two-line login errors
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on c642d2bda9: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 30 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1158#issuecomment-6586426422
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1158#issuecomment-6586426422)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1158` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1158`; tests `bunx vitest related --run src/app/login/login-form.tsx src/app/login/shared-login-form.tsx tests/login-error-accessibility.test.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

## Group 3 (rest, pharmacy first)

### #1120 · DEV-211 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1120 · branch `codex/DEV-211-inventory-branch-authorization` · head `cf3dd14966` · group 3
- Title: DEV-211: Require inventory capability and active branch assignment
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on cf3dd14966: typecheck exit 0 (0 new vs baseline); eslint 0 errors; tests 1553 passed / 22 failed in 7 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on codex/DEV-211-inventory-branch-authorization for: F1 src/server/routers/pharmacy-inventory.ts:155 Keep scopeFor's previous behaviour (active tenant branch only). Add a dedicated helper, for example assignedScopeFor(ctx, branch), that runs scopeFor and then t; F2 docs/already-fixed-470.md:1 Remove docs/already-fixed-470.md and the `/error.log` .gitignore line from the branch.
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1120` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1120`; tests `bunx vitest related --run src/app/(app)/pharmacy/inventory/expiry/page.test.tsx src/app/(app)/pharmacy/inventory/expiry/page.tsx src/app/(app)/pharmacy/inventory/page.test.tsx src/app/(app)/pharmacy/inventory/page.tsx src/app/(app)/pharmacy/inventory/transfers/page.test.tsx src/app/(app)/pharmacy/inventory/transfers/page.tsx src/components/pharmacy/inventory/branch-assignment-required.tsx src/lib/pharmacy/stock-ledger.db.test.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/stock-ledger.db.test.ts, src/lib/pharmacy/supplier-returns.db.test.ts, src/lib/pharmacy/upsell-suggestions.db.test.ts, src/server/routers/pharmacy-inventory.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/upsell-suggestions.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts
- Decisions: F1 (qa) confirmed by skeptics: The assignment check is added to the shared scopeFor() helper. In the PR tree, 36 procedures call scopeFor, including reads such as nearExpiryBoard, temperatureZoneStatuses, onHand, transferBoard and stockSignalDashboard | F2 (qa) confirmed by skeptics: The PR adds two files outside the issue's scope. The first is a docs note claiming the issue was 'already fixed' and that 'no production code or tests were changed', which the PR's own code changes contradict; it also ci

### #1119 · DEV-116 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1119 · branch `codex/DEV-116-cash-flow-evidence` · head `26c273f336` · group 3
- Title: DEV-116: Show classification journal evidence in cash flow
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on 26c273f336: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 13 passed / 0 failed in 0 files; build exit 0; fix commit 26c273f336 (test cash-flow classification journal lines; first run on 3d56d6912e failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1119`, then post comments/1119.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1119` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1119`; tests `bunx vitest related --run src/app/(app)/pharmacy/accounts/cash-flow/page.test.tsx src/app/(app)/pharmacy/accounts/cash-flow/page.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: Nothing tests the PR's only behaviour change, the 'Classification journal lines' list (page.tsx lines 236-242). The PR checklist says '[x] Cash and non-cash counterpart lines both rendered', but no test checks it, and th

### #1118 · DEV-117 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1118 · branch `codex/DEV-117-balance-sheet-coverage` · head `ba2c5d217e` · group 3
- Title: DEV-117: Qualify balance sheet reconciliation coverage
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on ba2c5d217e: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 5 passed / 0 failed in 0 files; build exit 0; fix commit ba2c5d217e (update balance sheet pill UI tests and format changed files; first run on 51f920b0b6 failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 1118`, then post comments/1118.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1118` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1118`; tests `bunx vitest related --run src/app/(app)/pharmacy/accounts/balance-sheet/balance-sheet-report.test.tsx src/app/(app)/pharmacy/accounts/balance-sheet/balance-sheet-report.tsx src/lib/pharmacy/accounts/balance-sheet.coverage.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: NEW test failure attributable to the PR (fails on PR, passes on develop): see retry.json attributable list.
- Decisions: F1 (qa) confirmed by skeptics: The PR changes the report pill text from 'Equation reconciled' / 'Reconciliation gap' to 'Posted equation balanced' / 'Posted equation gap' but does not update the existing UI test, which still expects the old text. That | F2 (qa) confirmed by skeptics: The PR's purpose is a UI change: a zero posted gap with nonzero unmapped accounts must render as balanced but classification-incomplete, not as a reconciliation gap or a reconciled claim. No UI test covers that rendering

### #1117 · DEV-118 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1117 · branch `codex/DEV-118-profit-loss-coverage` · head `404c9f9a58` · group 3
- Title: DEV-118: Expose profit and loss classification coverage
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit 404c9f9a58 (use BigInt() in P&L coverage test and apply prettier; first run on ae10482456 failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: re-check queued for fix 404c9f9a58; then `python3 handoff/scripts/compose.py 1117` and post comments/1117.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1117` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1117`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The new test file uses BigInt literals. tsconfig targets ES2017, so tsc reports TS2737 and the PR adds new typecheck errors. Next build also type-checks the repo's .ts files unless NEXT_BUILD_SKIP_TYPECHECK=1, so the bui | F2 (qa) confirmed by skeptics: Develop already satisfies the issue on its own. The PR adds only a derived field that no caller reads, plus tests that repeat assertions develop already has, so it adds nothing the issue still needs.

### #1116 · DEV-135 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1116 · branch `codex/DEV-135-supplier-claim-journal` · head `7cf6f2fb1c` · group 3
- Title: DEV-135: Preserve supplier-return claim journal posting
- Verdicts: machine FAIL · QA FAIL · Security PASS
- Done so far: checks on 7cf6f2fb1c: typecheck exit 0 (0 new vs baseline); eslint 2 errors; tests 464 passed / 10 failed in 1 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1116#issuecomment-6590465140
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1116#issuecomment-6590465140)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1116` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1116`; tests `bunx vitest related --run src/lib/pharmacy/supplier-returns-operations.ts src/lib/pharmacy/supplier-returns.db.test.ts src/server/routers/pharmacy-purchasing.test.ts src/server/routers/pharmacy-purchasing.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW eslint: src/app/api/restaurant/webhooks/[source]/route.replay.test.ts:22 @typescript-eslint/no-require-imports A `require()` style import is forbidden. | NEW eslint: src/components/pharmacy/counter/counter-console.tsx:993 react-hooks/set-state-in-effect Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to sy | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — a claimed quantity leaves saleable stock refuses to claim the same units twice | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — a claimed quantity leaves saleable stock submitting the return reserves the quantity and a sale can no longer reach it | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — dispatch posts an append-only RETURN_TO_SUPPLIER pair moves the units out of AVAILABLE and into RETURN_TO_SUPPLIER without leaving the ledger | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — dispatch posts an append-only RETURN_TO_SUPPLIER pair refuses to update or delete a RETURN_TO_SUPPLIER movement (§8A invariant 8) | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — expected vs received credit keeps the actor who submitted the return off its own settlement | NEW test failure: src/lib/pharmacy/supplier-returns.db.test.ts > PUR-06 — expected vs received credit keeps the shortfall visible when the supplier credits less than was claimed | note: REGRESSION vs its merge-base 6e4253809b (PR is 312 behind develop and conflicts with it in supplier-returns.db.test.ts): 10 tests in src/lib/pharmacy/supplier-returns.db.test.ts fail on the PR and pass at the merge-base; first error 'prisma.financeJournalEntry.create() Foreign key constraint violated: finance_journal_entries_visibility_fkey' (the PR's journal posting writes an entry whose visibility row does not exist). ESLint errors on the PR all already exist at the merge-base.
- Decisions: security verdict set to PASS by hand: Checked the submit path for tenant scoping, input validation, raw SQL and server-side permission checks. postSupplierClaimEntry is scoped by organization and branch, input stays strict zod, there is no raw SQL, and the new procurement check runs server-side before the transaction. The PR introduces  | F1-superseded-by-develop (qa) confirmed by skeptics: Develop already fully satisfies the issue. The production fix in this PR is already on origin/develop, so the PR adds nothing the issue still needs. | F2-unrelated-authorization-gate (qa) confirmed by skeptics: Commit 7cf6f2fb1 makes an unrelated behaviour change. It adds a new `can(..., 'pharmacy:procurement')` FORBIDDEN gate to submitPurchaseReturn, plus a router test for it at src/server/routers/pharmacy-purchasing.test.ts:1 | SEC-1 (security) confirmed by skeptics: Develop already does everything DEV-135 asks for. Commit 4a72fda1c ("Fixes #618", PR #88) is an ancestor of origin/develop 47518cbf9. It adds the same postSupplierClaimEntry call after the claim is created, and an equiva

### #1114 · DEV-145 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1114 · branch `codex/DEV-145-review-assertion-limit` · head `8247167eb6` · group 3
- Title: DEV-145: Cover the review assertion limit
- Verdicts: machine PASS · QA FAIL · Security PASS
- Done so far: checks on 8247167eb6: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 1 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1114#issuecomment-6590462689
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1114#issuecomment-6590462689)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1114` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1114`; tests `bunx vitest related --run src/server/routers/pharmacy-medicine.review-limit.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: security verdict set to PASS by hand: Checked the one new test file and the recordReviewDecision and publishAssertions paths on develop: capabilities are enforced server-side through adminProcedure (admin:access), tenant scope comes from the scoped db and RLS, there is no raw SQL, and the test holds no secrets. No vulnerability was foun | superseded-by-develop (qa) confirmed by skeptics: Develop already fully satisfies DEV-145. The PR's only change is one new test file that pins a review-schema cap of 20, which existed before the issue and which the issue cites as the correct reference behaviour. It adds | SEC-1 (security) confirmed by skeptics: Superseded. Develop already fixes the issue on its own, and the PR adds nothing the issue still needs. At the issue's source commit 6e425380, the unbounded assertionIds path was publishAssertions (`z.array(z.string().min

### #1101 · DEV-198 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1101 · branch `codex/DEV-198-day-close-currency` · head `776d22334a` · group 3
- Title: DEV-198: Use tenant currency in day-close tender totals
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit 776d22334a (render-test USD tender totals, drop source-grep test; first run on 933fef04a9 failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: re-check queued for fix 776d22334a; then `python3 handoff/scripts/compose.py 1101` and post comments/1101.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1101` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1101`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The issue asks for coverage of a non-PKR organization, and the main path here (tender totals for a USD tenant) has no rendered test. The PR's only new test reads day-close-console.tsx as text and checks for the literal '

### #1087 · DEV-199 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1087 · branch `codex/DEV-199-emergency-supply-lock` · head `c6acae6d8d` · group 3
- Title: DEV-199: Serialize emergency supply eligibility
- Verdicts: machine PASS · QA FAIL · Security PASS
- Done so far: checks on c6acae6d8d: typecheck exit 0 (0 new vs baseline); eslint 2 errors; tests 234 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1087#issuecomment-6590471058
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1087#issuecomment-6590471058)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1087` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1087`; tests `bunx vitest related --run src/server/routers/pharmacy-sales.emergency-concurrency.test.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW eslint: src/app/api/restaurant/webhooks/[source]/route.replay.test.ts:22 @typescript-eslint/no-require-imports A `require()` style import is forbidden. | NEW eslint: src/components/pharmacy/counter/counter-console.tsx:993 react-hooks/set-state-in-effect Error: Calling setState synchronously within an effect can trigger cascading renders

Effects are intended to sy | also fail on develop/merge-base (pre-existing): src/server/routers/pharmacy-sales.controlled-actor.test.ts
- Decisions: security verdict set to PASS by hand: Checked the emergency controlled-supply path: pharmacy:dispense and pharmacist PIN checks run server-side before the lock, the patient lookup is org-scoped, the lock key is a bound $queryRaw parameter that includes the org id, and the default READ COMMITTED tenant transaction means the post-lock cou | F1-superseded (qa) confirmed by skeptics: Develop already contains everything this PR changes, so the PR adds nothing that is still needed. | SEC-1087-1 (security) confirmed by skeptics: The PR is superseded: develop already contains every change it makes, so merging it adds nothing and keeps a dirty .gitignore conflict open. No security exploit; the issue's race is already closed on develop.

### #1086 · DEV-279 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1086 · branch `codex/DEV-279-cash-drawer-authorization` · head `836996e16d` · group 3
- Title: DEV-279: Authorize cash drawer mutations and branch scope
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1086` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1086`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR routes the three drawer mutations through requireCounterReceiptAccess, but it does not update the tests that exercise them, so its own unit tests fail. branchScopeOrForbidden turns scopeFor's BAD_REQUEST into FORB | F2 (qa) confirmed by skeptics: The change goes beyond the issue and removes existing access. RECEIPT_READ_CAPABILITIES drops 'pharmacy.dispense', 'pharmacy:receipt', 'pharmacy.receipt' and 'pharmacy.counter', and the default authorization moves from t

### #1072 · DEV-321 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1072 · branch `codex/DEV-321-counter-patient-entitlements` · head `d9a63c46ac` · group 3
- Title: DEV-321: Lock counter patient entitlement regression
- Verdicts: machine FAIL · QA FAIL · Security PASS
- Done so far: checks on d9a63c46ac: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 5 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1072#issuecomment-6590472636
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1072#issuecomment-6590472636)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1072` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1072`; tests `bunx vitest related --run src/server/routers/pharmacy-prescriptions.counter-entitlement.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: security verdict set to PASS by hand: Checked the counterPatients/counterPatientPanel path. The module gate lets either pharmacy-counter or pharmacy-dispensing through, the server-side pharmacy:counter/pharmacy:dispense check runs before any read, and queries stay scoped by organizationId. No raw SQL, secrets or UI. I found no vulnerabi | F1 (qa) confirmed by skeptics: Develop already contains the fix and its regression tests, and this PR adds only a test file that repeats them. It adds no coverage develop lacks, so the PR is superseded. | superseded-by-develop (security) confirmed by skeptics: Develop already does everything DEV-321 asks, and this PR adds nothing develop lacks. The PR is a single new test file; it changes no production code. Develop already routes both counter patient procedures to pharmacy-co

### #1068 · DEV-322 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1068 · branch `codex/DEV-322-command-centre-khata` · head `53af03e404` · group 3
- Title: DEV-322: Preserve command-centre Khata branch context
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit 53af03e404 (gives the finance-insights test fixture db the $transaction the scoped tenant db provides; first run on 86d85bfeb7 failed on 5 regressed tests in tests/finance-insights-ai-independence.test.ts (ctx.db.$transaction is not a function)); QA+Security reviews complete
- Next step: re-check queued for fix 53af03e404; then `python3 handoff/scripts/compose.py 1068` and post comments/1068.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1068` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1068`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR makes commandCentre call ctx.db.$transaction. The fixture db built in this suite (lines 112-180) has no $transaction method. ctx.db.$transaction is therefore undefined, the TypeError is caught by the router's try/

### #1061 · DEV-138 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1061 · branch `codex/linear-mention-dev-138-qa]-sev2]-restaurant-reports-wast` · head `c1fbb802eb` · group 3
- Title: Fix type errors in merged test fixtures
- Verdicts: machine PASS · QA FAIL · Security PASS
- Done so far: checks on c1fbb802eb: typecheck exit 0 (0 new vs baseline); eslint 0 errors; tests 228 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1061#issuecomment-6590478994
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1061#issuecomment-6590478994)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1061` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1061`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts src/server/routers/pharmacy-inventory.test.ts src/server/routers/restaurant-catering.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/server/routers/pharmacy-inventory.test.ts
- Decisions: QA-1061-01 (qa) confirmed by skeptics: The PR is linked to DEV-138 but changes nothing toward it. DEV-138 is already fully met on develop, and the whole diff (4 test-fixture type fixes in pharmacy counter, pharmacy inventory, pharmacy duplicate-salt and resta

### #1060 · DEV-170 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1060 · branch `codex/linear-mention-dev-170-qa]-sev2]-shifts-cancelling-an-in` · head `f88abb84b9` · group 3
- Title: test: prevent cancelling shifts with active attendance
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on f88abb84b9: typecheck exit 0 (0 new vs baseline); eslint 0 errors; tests 228 passed / 1 failed in 1 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on codex/linear-mention-dev-170-qa]-sev2]-shifts-cancelling-an-in for: F1 src/lib/restaurant/shifts.ts:358 In cancelShift, read the CLOCK_IN/CLOCK_OUT adjustments where breakId is null and compute effective attendance. Lock the shift row first, as workforce commands ; F2 src/components/pharmacy/counter/counter-console.test.tsx:92 Land the four fixture repairs once, under a dedicated develop-typecheck repair issue/PR. Either #1060 or #1061 can carry it under that issue. Once develop typec
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1060` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1060`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts src/server/routers/pharmacy-inventory.test.ts src/server/routers/restaurant-catering.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/server/routers/pharmacy-inventory.test.ts
- Decisions: F1 (qa) confirmed by skeptics: Part of DEV-170 is still unmet, and the PR adds no shift code. Develop's guard from #210 reads only the raw clockedInAt/clockedOutAt columns. Attendance is actually derived from those columns plus restaurantTimeAdjustmen | F2 (qa) confirmed by skeptics: The whole diff is outside DEV-170. The four test-fixture type repairs touch pharmacy counter, pharmacy inventory, pharmacy duplicate-salt and restaurant catering tests. They fix tsc errors that already exist on develop. 

### #1056 · DEV-141 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1056 · branch `codex/linear-mention-dev-141-qa]-sev3]-restaurant-demo-seed-he` · head `45a00ae883` · group 3
- Title: fix(restaurant): assign demo head chef to kitchen role
- Verdicts: machine FAIL · QA FAIL · Security PASS
- Done so far: checks on 45a00ae883: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 70 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1056#issuecomment-6590481307
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1056#issuecomment-6590481307)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1056` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1056`; tests `bunx vitest related --run scripts/seed-restaurant-demo.ts src/server/routers/pharmacy-sales.refund-cap.test.ts tests/restaurant-e2e-seed.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: security verdict set to PASS by hand: Checked the seedPeople role selection, the org-scoped kitchen role lookup, the kitchen role's capabilities (least-privilege), the KDS unlock kitchen:operate check, and the refund-cap test edit. No vulnerability, auth change or raw SQL change was found. The FAIL is only because develop already contai | superseded-by-develop (qa) confirmed by skeptics: Develop already fully satisfies DEV-141. Nothing in this PR is still needed: the seed change is a refactor that produces the same role for every staff member. | SEC-1056-1 (security) confirmed by skeptics: This PR is superseded. Develop already does what DEV-141 asks: commit 2756d5427 ('fix(#612): Restaurant demo seed: Head Chef is put on the operator role without kitchen:operate', merged via #193, an ancestor of origin/de

### #1050 · DEV-40 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1050 · branch `codex/linear-mention-dev-40-sev3]-medicine-reference-non-sale` · head `29b76168f4` · group 3
- Title: fix(pharmacy): derive medicine reference saleability copy
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 29b76168f4: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 11 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1050#issuecomment-6589314697
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1050#issuecomment-6589314697)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1050` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1050`; tests `bunx vitest related --run src/components/pharmacy/medicine-reference-workbench.test.tsx src/components/pharmacy/medicine-reference-workbench.tsx` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1008 · DEV-139 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1008 · branch `codex/linear-mention-dev-139-qa]-sev3]-pharmacy-licence-scans-a` · head `cb4468aab7` · group 3
- Title: fix(files): restrict pharmacy licence evidence to admins
- Verdicts: machine PASS · QA FAIL · Security PASS
- Done so far: checks on cb4468aab7: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 70 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1008#issuecomment-6590486359
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1008#issuecomment-6590486359)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1008` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1008`; tests `bunx vitest related --run src/app/api/files/[name]/route.test.ts src/app/api/files/[name]/route.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: security verdict set to PASS by hand: Checked the /api/files/[name] licence-evidence gate. The lookup runs in withTenantDb, and pharmacy_branch_regulatory_profiles has FORCE RLS. Non-ADMIN users get a non-enumerating 404 before storage is read, admin:access maps to isAdmin, and there are no raw SQL or input changes. The PR adds no vulne | F1 (qa) confirmed by skeptics: Superseded: develop already fully implements DEV-139, and this PR adds no behaviour that is still needed. | SEC-1008-1 (security) confirmed by skeptics: Develop already fully fixes this PR's issue, and the PR adds no security value. Commit 94e67bb14 on develop, 'fix(#641): [QA][sev3] Pharmacy licence scans are readable by any signed-in tenant member via /api/files/<name>

### #1006 · DEV-53 · done
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1006 · branch `fix/sev3-authz-group` · head `63af85e15b` · group 3
- Title: fix(authz): capability checks for patient/consent, hotel setStatus, restaurant growth (Sev3)
- Verdicts: machine PASS · QA PASS · Security PASS
- Done so far: checks on 63af85e15b: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 123 passed / 0 failed in 0 files; build exit 0; fix commit 63af85e15b (Prettier on restaurant-growth.test.ts; first run on b49bbf354a failed on Prettier: src/server/routers/restaurant-growth.test.ts unformatted); QA+Security reviews complete; verdict comment https://github.com/RealDevFathom/devfathom-commercial/pull/1006#issuecomment-6590488301
- Next step: none: verdict comment posted (https://github.com/RealDevFathom/devfathom-commercial/pull/1006#issuecomment-6590488301)
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1006` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1006`; tests `bunx vitest related --run src/server/routers/hotel-inventory.test.ts src/server/routers/pharmacy-prescriptions.test.ts src/server/routers/pharmacy-prescriptions.ts src/server/routers/restaurant-growth.test.ts src/server/routers/restaurant-growth.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #1005 · DEV-50 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1005 · branch `fix/vertical-leak-404` · head `9d3baf26f6` · group 3
- Title: fix(pharmacy): vertical gating in Settings and branded 404 for unknown tenant (QA batch 5)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit 9d3baf26f6 (unknown-tenant 404 links to sign-in, drop no-op pharmacy notification toggles; first run on 6b58b00b6c failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: re-check queued for fix 9d3baf26f6; then `python3 handoff/scripts/compose.py 1005` and post comments/1005.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1005` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1005`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The branded unknown-tenant 404 has no way back. DEV-50 explicitly expects a 'branded 404 with a way back', and the design contract (section 7, error states) requires 'the next available action'. | F2 (qa) confirmed by skeptics: The pharmacy Settings replaces the agency notification matrix with Stock, Expiry, Approvals and Refunds toggles, but nothing in the codebase sends notifications in those categories. These are new controls that do nothing | F3 (qa) refuted by skeptics: The command palette rewrite also changes non-pharmacy workspaces. Its shortcuts now come only from the sidebar's filteredNav. The old list came from routeLabels and included Email, API Access and Import, which have no si

### #1004 · DEV-51 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1004 · branch `fix/dark-mode-tokens` · head `087149317e` · group 3
- Title: fix(ui): dark-mode theme tokens for borders, primary button edge, toggles, links and active tab
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on 087149317e: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 82 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/dark-mode-tokens for: F1 src/lib/tenant-brand.ts:66 In hoverColor, compute contrast(hover, contrastColor(hex)). If it is below 4.5, mix 16% away from the foreground instead (toward #000000 when the foreground is ; F2 src/app/globals.css:1726 Re-point the hover token for text-role uses in dark as well. Either add `.hover\:text-primary-hover` to the :is() list and declare `--primary-hover: var(--text-
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1004` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1004`; tests `bunx vitest related --run src/app/dark-theme-contrast.test.ts src/components/ui/switch.test.tsx src/components/ui/switch.tsx src/lib/tenant-brand.test.ts src/lib/tenant-brand.ts tests/e2e/pharmacy-dark-mode-visual-qa.spec.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: hoverColor() always moves the tenant primary 16% toward its own foreground, which lowers the label/fill contrast. For mid-tone brands, hovered primary buttons drop below the contract's 4.5:1 (section 9). On develop, hove | F2 (qa) confirmed by skeptics: The dark text-role remap re-points --primary but not --primary-hover. A dark-mode text-primary link with hover:text-primary-hover is now readable at rest but fades to near-invisible on hover under the default ink brand.  | F3 (qa) refuted by skeptics: DEV-51's first half (hard-coded colours on screens -> design tokens throughout) has no code change in this PR. The Settings screen, which this PR's own dark e2e visits, still hard-codes the primary-button label and hover

### #1003 · DEV-49 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1003 · branch `fix/counter-responsive` · head `6538931043` · group 3
- Title: fix(pharmacy): counter, prescriptions and inventory responsive layout (QA batch 5)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit 6538931043 (fix Field label test, drop out-of-scope nav wrap and Physical count hiding; first run on bccb1b844f failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: re-check queued for fix 6538931043; then `python3 handoff/scripts/compose.py 1003` and post comments/1003.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1003` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1003`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: A test this PR adds always fails. The machine check reports it as the one NEW unit failure: field.test.tsx. | F2 (qa) confirmed by skeptics: Unrelated change. Commit b68b1b046 changes the global desktop primary navigation from a sideways scroll to a multi-row wrap with group dividers, and adds a matching rule to the design contract. DEV-49 covers Counter, Pre | F3 (qa) confirmed by skeptics: Out-of-scope behaviour change and feature loss. The INV-06 Physical count card, with its explained empty state, is now hidden whenever no stock can be counted and no past count exists. DEV-49 asks for horizontal table sc

### #1002 · DEV-61 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1002 · branch `feat/reports-csv-export` · head `c4cfcbebde` · group 3
- Title: feat(reports): CSV export for reports, gated by reports:financial
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: fix commit c4cfcbebde (return a generic 500 for unexpected report export failures; first run on 6aea99a22d failed on the failures listed in the first review (see QA/Security)); QA+Security reviews complete
- Next step: re-check queued for fix c4cfcbebde; then `python3 handoff/scripts/compose.py 1002` and post comments/1002.md
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1002` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1002`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Unexpected server failures are returned as HTTP 400 with the raw internal error message, not the generic 500 the PR promises. tRPC's createCaller wraps every non-TRPC error thrown inside the procedure as TRPCError({code:

### #1001 · DEV-46 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1001 · branch `fix/reports-ops-screens` · head `63d657e346` · group 3
- Title: fix(reports,ops): Reports filters, opening stock, Day close, Settings
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on 63d657e346: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 326 passed / 2 failed in 2 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/reports-ops-screens for: F1 src/lib/pharmacy/onboarding-checklist.ts:121 Point OPENING_STOCK_READINESS at OPENING_IMPORT_ROUTE ('/pharmacy/inventory/import') with linkLabel 'Import opening stock' and matching todo copy. Optionally me; F2 src/components/pharmacy/inventory/opening-import.ts:136 Make the links and copy match what the destinations can actually do. For example, label the first 'Open medicine catalogue and packs' (/pharmacy/medicines) and ; machine-check failure listed below
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1001` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1001`; tests `bunx vitest related --run src/app/(app)/pharmacy/counter/close/loading.test.tsx src/app/(app)/pharmacy/counter/close/loading.tsx src/app/(app)/pharmacy/inventory/counts/page.test.tsx src/app/(app)/pharmacy/inventory/counts/page.tsx src/app/(app)/pharmacy/inventory/expiry/loading.tsx src/app/(app)/pharmacy/inventory/expiry/page.test.tsx src/app/(app)/pharmacy/inventory/expiry/page.tsx src/app/(app)/pharmacy/inventory/import/loading.tsx …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW test failure: src/app/(app)/pharmacy/reports/supplier-credit-follow-up/packet.test.tsx > supplier draft packet evidence shows people-readable times while the CSV keeps exact instants | NEW test failure: src/app/(app)/pharmacy/reports/supplier-credit-follow-up/page.test.tsx > supplier-credit Reports preparation renders observations and independent next pages while preserving branch and period | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: REGRESSION: 2 existing tests fail on the PR and pass on develop: supplier-credit-follow-up/packet.test.tsx ('shows people-readable times while the CSV keeps exact instants': no text /Prepared 4 Sep 2026, 12:00 UTC/) and supplier-credit-follow-up/page.test.tsx ('renders observations and independent next pages...': no text /Observed: 12 Sep 2026, 07:00 UTC/). The PR changed the reports date/time presentation those tests assert.
- Decisions: F1 (qa) confirmed by skeptics: DEV-46 requirement unmet: onboarding still sends opening stock to a different flow. The issue names onboarding as one of the three entry points and expects a single import entry point. On develop plus this PR, the onboar | F2 (qa) confirmed by skeptics: The next steps offered for an unmatched or unpublished medicine row lead to a dead end. Both buttons ('Pick the matching medicine' and 'Request a new medicine for review') open the same component, StagedMedicineCatalogue

### #1000 · DEV-43 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1000 · branch `fix/team-members-zero` · head `017d00745f` · group 3
- Title: fix(team): Team shows 0 members when users exist
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on 017d00745f: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 26 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/team-members-zero for: F1 src/app/(app)/team/team-content.tsx:279 In StaffProfilesOffNotice, show each user's role next to the title. Use `inviteCopyForVertical(useEntitlements().vertical).baseRoleLabels[user.role]` (pharmacy:; F2 src/app/(app)/team/team-content.tsx:422 In AddMemberModal onSuccess, also call `utils.organizationAdmin.overview.invalidate()`. Optionally call `router.refresh()` so the server-rendered activeSeats he
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1000` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1000`; tests `bunx vitest related --run src/app/(app)/team/team-content.test.tsx src/app/(app)/team/team-content.tsx tests/e2e/fixtures/pharmacy-first-sale.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: The issue's main expected behaviour is 'list org users with roles'. The new member list shown without HR renders only name, free-text job title and status. It never shows the user's role, even though organizationAdmin.ov | F2 (qa) confirmed by skeptics: Without HR, the list on the page comes from organizationAdmin.overview, but a successful invite only invalidates team.getAll. The global query defaults are staleTime 60s and refetchOnWindowFocus false, and StaffProfilesO

### #999 · DEV-39 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/999 · branch `fix/owner-copy-sweep` · head `c35d2a8ea6` · group 3
- Title: fix(ui): owner copy sweep, remove internal codes and jargon
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 999` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/999`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: A test that this PR changed now fails against the page. The last commit removed the singular/plural branch from the report catalog count, but the new assertion still expects the singular. | F2 (qa) confirmed by skeptics: Internal requirement codes are still shown on owner screens, and the guard's code pattern cannot catch them. | F3 (qa) confirmed by skeptics: Every approved or rejected purchase order shows the raw PUR-02 policy key in its approval history. The issue explicitly lists PUR- codes. | F4 (qa) confirmed by skeptics: The Reports 'As-of cutoff' field, which the issue names explicitly, still shows a raw ISO timestamp. Only its label changed. | F5 (qa) confirmed by skeptics: Raw ISO timestamps are still rendered on owner marketing screens, in the same paragraphs this PR edited. Other owner accounts pages also still show them. | F6 (qa) confirmed by skeptics: Jargon that the issue lists ('base units', and 'Presentation' from the UX batch 8 comment on DEV-39) is still shown. The PR defers 'Presentation' as a follow-up, but the Linear issue includes it. | F7 (qa) confirmed by skeptics: The owner dashboard's freshness time used to show the viewer's local time and now shows UTC. The issue asks for localised dates. | F8 (qa) confirmed by skeptics: This is a navigation-motion change outside the issue's scope, and it breaks the Studio design contract and tenant/platform parity.

### #998 · DEV-41 / DEV-42 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/998 · branch `fix/counter-cashier-copy` · head `97f0b070f6` · group 3
- Title: fix(counter): plain-language copy for cashiers and hide internal tools
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on 97f0b070f6: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 535 passed / 2 failed in 2 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/counter-cashier-copy for: F1 src/components/pharmacy/counter/counter-console.tsx:1001 When an add is sent from the scan field (barcode Enter in addBarcode, or Enter to addToCart), clear the field right away with `setQuery('')` and keep the submit; F2 src/components/pharmacy/counter/counter-console.tsx:925 Once a scan's add or pack authentication has been sent, do not let edits to the scan field cancel it; cancel only on a branch switch or unmount. If it does get ; F3 src/server/routers/pharmacy-sales.ts:1725 Return a separate display flag for the batch map that stays true for dispensing staff, e.g. `counterManager || can(subject, 'pharmacy:dispense', …)`, and pass t
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 998` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/998`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-cart.test.tsx src/components/pharmacy/counter/counter-cart.tsx src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/components/pharmacy/counter/counter-keymap-legend.test.tsx src/components/pharmacy/counter/counter-keymap-legend.tsx src/server/routers/pharmacy-sales.ts tests/e2e/fixtures/pharmacy-first-sale.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: Scanning a second item while an add is still running leaves the two barcodes joined in one string. The PR claims 'the second code stays in the field', but with a real scanner it does not. | F2 (qa) confirmed by skeptics: Because the scan field is now enabled, scanning or typing while a new bill is being created silently cancels the first scanned item. The same happens during GS1 pack authentication. On develop, the disabled field made th | F3 (qa) confirmed by skeptics: Every user without pharmacy:manage gets the cashier view, not only cashiers. Pharmacists, for example, lose the cart's batch, expiry, units and location rows. That goes beyond DEV-41, which is about the cashier role and 

### #997 · DEV-37 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/997 · branch `fix/returns-lookup-scope` · head `c9e45219ad` · group 3
- Title: fix(returns): scope receipt lookup to the cashier's branches
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on c9e45219ad: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 596 passed / 2 failed in 2 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/returns-lookup-scope for: F1 src/app/(app)/pharmacy/purchasing/returns/page.tsx:152 Run git revert c89b74bd8 on fix/returns-lookup-scope, removing the page.tsx and page.test.tsx changes. Then drop the 'QA batch 4: Purchasing returns permission 
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 997` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/997`; tests `bunx vitest related --run src/app/(app)/pharmacy/purchasing/returns/page.test.tsx src/app/(app)/pharmacy/purchasing/returns/page.tsx src/components/pharmacy/counter/counter-return-panel.test.tsx src/components/pharmacy/counter/counter-return-panel.tsx src/server/routers/pharmacy-sales.counter-receipt-auth.db.test.ts src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts src/server/routers/pharmacy-sales.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: Unrelated change: commit c89b74bd8 ('show a permission state on purchasing returns denials') implements DEV-38 (Purchasing returns 'This surface could not load' for cashiers/managers), not DEV-37. It touches the supplier

### #996 · DEV-31 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/996 · branch `fix/manager-only-campaigns-close` · head `d673c26fe6` · group 3
- Title: fix(pharmacy): campaign approval/generation and day close/drawer need manager or owner (Sev2)
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on d673c26fe6: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 5760 passed / 47 failed in 26 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/manager-only-campaigns-close for: F1 src/lib/vertical-catalog.ts:807 Keep the Pharmacist template at ['pharmacy:dispense', 'pharmacy:catalogue-review'], with pharmacy:close still removed. Delete the INSERT ... 'pharmacy:counter' ; machine-check failure listed below
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 996` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/996`; tests `bunx vitest related --run src/components/pharmacy/counter/counter-console.test.tsx src/components/pharmacy/counter/counter-console.tsx src/components/pharmacy/counter/day-close-console.test.tsx src/components/pharmacy/counter/day-close-console.tsx src/lib/abac/capabilities.test.ts src/lib/pharmacy/manager-access.ts src/lib/vertical-catalog.test.ts src/lib/vertical-catalog.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: NEW test failure: tests/pharmacy-pharmacist-backfill.db.test.ts | also fail on develop/merge-base (pre-existing): src/lib/abac/index.test.ts, src/lib/hotel/foundation.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, src/lib/restaurant/catering-endpoints.db.test.ts, src/lib/restaurant/catering-money.db.test.ts, src/lib/restaurant/catering-runtime.db.test.ts, src/lib/restaurant/daily-close-clock.test.ts, src/lib/restaurant/refunds.test.ts, src/lib/restaurant/tenders-posting.test.ts, src/lib/restaurant/terminal-checkout.db.test.ts, src/server/routers/pharmacy-baskets.test.ts, src/server/routers/pharmacy-inventory.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts, src/server/routers/restaurant-tax.db.test.ts, src/server/routers/restaurant-tax.test.ts, tests/pharmacy-capabilities.db.test.ts, tests/pharmacy-owner-operator-backfill.db.test.ts, tests/restaurant-m5-acceptance.test.ts, tests/restaurant-m5-reconciliation.test.ts, tests/restaurant-m6-acceptance.test.ts, tests/restaurant-menu-import-acceptance.db.test.ts, tests/vertical-foundation.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/restaurant/refunds.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts) | note: PR-introduced failure in its new tests/pharmacy-pharmacist-backfill.db.test.ts: the suite's beforeAll fails with 'duplicate key value violates unique constraint organization_roles_organizationId_key_key' on a gate-equivalent migrated+seeded DB, so all 4 tests are skipped/failed (same with a superuser role). The fixture inserts a role that already exists for its organization; make the fixture use unique org/role keys or upsert.
- Decisions: F1 (qa) confirmed by skeptics: Unrelated privilege expansion. The Pharmacist system template now grants pharmacy:counter, and the migration backfills a pharmacy:counter ALLOW to every existing system Pharmacist role in PHARMACY orgs. DEV-31 only asks 

### #995 · DEV-19 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/995 · branch `fix/catalogue-edit-review` · head `e5f82a722c` · group 3
- Title: fix(pharmacy): catalogue edits go through review (Sev2)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 995` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/995`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Regression in a key acceptance path. The new review panel is shown only to tenant ADMINs, but the reviewer the PR requires is often not an ADMIN. When another member holds pharmacy:catalogue-review, an ADMIN's own catalo

### #994 · DEV-17 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/994 · branch `fix/purchasing-server-authz` · head `be336ff5c2` · group 3
- Title: fix(pharmacy): server-side capability checks on every purchasing procedure (Sev1)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 994` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/994`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: B1 (qa) confirmed by skeptics: Two reads now throw FORBIDDEN 'Branch is outside your scope.' and their pages do not catch it. compareQuotes and receivedAgainstOrder now run assertOrderBranches. The pages keep listing tenant-wide requisitions and order

### #993 · DEV-18 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/993 · branch `fix/publish-creates-pack` · head `e7d00d6544` · group 3
- Title: fix(pharmacy): publishing a medicine creates its pack size and barcode so stock can be imported (Sev1)
- Verdicts: machine ran, see below · QA FAIL · Security PASS
- Done so far: checks on e7d00d6544: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 2044 passed / 23 failed in 9 files; build exit 0; QA+Security reviews complete
- Next step: push one fix commit on fix/publish-creates-pack for: F1 src/server/routers/pharmacy-medicine.ts:778 Remove the nesting feature from this PR: the addInnerPackLevel procedure, the Outer pack select and its split preview, the intro sentence, splitPackTotal, PACK_; F2 src/lib/pharmacy/onboarding.ts:323 In onboarding.owner-operator.test.ts, add a case with medicinePublicationEntry.count=1 and packLevel.count=0 and expect blocking to contain MEDICINE_CATALOG_REA
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 993` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/993`; tests `bunx vitest related --run src/components/pharmacy/medicine-pack-setup.test.tsx src/components/pharmacy/medicine-pack-setup.tsx src/components/pharmacy/medicine-reference-workbench.tsx src/lib/pharmacy/medicine.test.ts src/lib/pharmacy/medicine.ts src/lib/pharmacy/onboarding-checklist.ts src/lib/pharmacy/onboarding.owner-operator.test.ts src/lib/pharmacy/onboarding.ts …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: also fail on develop/merge-base (pre-existing): src/lib/pharmacy/counter-evidence.db.test.ts, src/lib/pharmacy/duplicate-salt-acknowledgement.db.test.ts, src/lib/pharmacy/stock-ledger.db.test.ts, src/lib/platform/commands.opportunity-convert.test.ts, src/lib/platform/commands.organization-create.test.ts, src/server/routers/pharmacy-inventory.test.ts, src/server/routers/pharmacy-offline.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts, tests/vertical-foundation.test.ts | env-only (gate runtime role lacks CREATE ROLE; pass as superuser): src/lib/pharmacy/counter-evidence.db.test.ts, src/server/routers/pharmacy-sales.drawer-close.db.test.ts | typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)
- Decisions: F1 (qa) confirmed by skeptics: The PR adds a nested-pack setup feature that neither DEV-18 nor DEV-7 asks for: the addInnerPackLevel mutation, the 'Outer pack' picker and preview in medicine-pack-setup.tsx:247, splitPackTotal and PACK_LEVEL_RANK, and  | F2 (qa) confirmed by skeptics: The issue requires readiness to be done only once a saleable pack with a barcode exists, and nothing tests that rule. Every updated mock moves the publication count and the barcoded-pack count together, so no test proves

### #986 · DEV-8 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/986 · branch `inky/issue-980` · head `88ebf1fd19` · group 3
- Title: feat(#980): Pharmacy leakage: agency/HR features in pharmacy tenant
- Verdicts: machine ran, see below · QA PASS · Security PASS
- Done so far: checks on 88ebf1fd19: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 124 passed / 0 failed in 0 files; build exit 0; fix commit 88ebf1fd19 (Prettier on api-docs-content.tsx and organization-admin-content.people.test.tsx; first run on 233f2fb2b4 failed on Prettier: 2 changed files unformatted); QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 986`, then post comments/986.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 986` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/986`; tests `bunx vitest related --run src/app/(app)/api-docs/api-docs-content.test.tsx src/app/(app)/api-docs/api-docs-content.tsx src/app/(app)/api-docs/page.tsx src/app/(app)/organization/organization-admin-content.people.test.tsx src/app/(app)/organization/organization-admin-content.tsx src/app/(app)/settings/settings-content.tsx src/app/(app)/settings/settings-notifications-vertical.test.tsx src/app/(app)/team/team-content.test.tsx …` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #985 · DEV-10 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/985 · branch `inky/issue-978` · head `2390c2e7f9` · group 3
- Title: feat(#978): Pharmacy catalogue review: accept/reject/defer disabled for owner despite pharmacy:catalogue-review
- Verdicts: machine ran, see below · QA PASS · Security PASS
- Done so far: checks on 2390c2e7f9: typecheck exit 2 (0 new vs baseline); eslint 0 errors; tests 18 passed / 0 failed in 0 files; build exit 0; QA+Security reviews complete
- Next step: `python3 handoff/scripts/compose.py 985`, then post comments/985.md via the poster workflow
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 985` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/985`; tests `bunx vitest related --run src/components/pharmacy/medicine-reference-workbench.test.tsx src/components/pharmacy/medicine-reference-workbench.tsx src/server/routers/pharmacy-medicine.owner-operator.test.ts` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)

### #984 · DEV-9 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/984 · branch `inky/issue-979` · head `98e678d8e7` · group 3
- Title: feat(#979): Pharmacy: cashier over-exposure (suppliers, purchasing, nav)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 984` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/984`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The issue names 'Create location' as a cashier exposure. The new gate (inventoryControlAllowed -> canControlInventory, lines 95-147 and 628) has no test, either for hiding the form or for showing it. The existing page te | F2 (qa) confirmed by skeptics: The issue cites 'try when connection restored' as a misleading error. That copy lives in PrescriptionsConsole, which now branches to AccessDeniedState on FORBIDDEN. That path is untested. The new access-denied.test.tsx c

### #983 · DEV-11 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/983 · branch `inky/issue-977` · head `4789bdb812` · group 3
- Title: feat(#977): Pharmacy regulatory: only Punjab (provisional) offered; Sindh branch can't get an in-force profile
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 983` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/983`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #982 · DEV-12 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/982 · branch `inky/issue-976` · head `7b898f0abf` · group 3
- Title: feat(#976): Pharmacy inventory: Create location fails with generic "could not be completed"
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 7
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 982` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/982`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The FORBIDDEN-to-'You don’t have inventory access — ask an owner.' mapping runs for every action in the shared `perform` server action, including create-recall, ack-recall and close-recall. Those procedures are gated by 

### #966 · WTS #405 (no RDF/Linear issue; nearest Linear follow-ups DEV-160, DEV-157) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/966 · branch `salvage/restaurant-day-close` · head `f368fcc2c7` · group 3
- Title: fix: Restaurant day close net sales with refunds (salvage; likely superseded)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 8
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 966` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/966`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: No vulnerability found. The PR's net diff is empty: f368fcc2c fully reverts 6fc3a9ce1, so the head tree matches merge-base 8b203969dc7d. No auth, org or branch scoping, validation, raw SQL or secrets change. Develop's daily-close.ts already takes refunded tax, service charge and delivery fee out of  | superseded-empty-diff (qa) confirmed by skeptics: The PR's net change is empty, and develop already satisfies the issue on its own. The salvaged commit 6fc3a9ce1 (fix(#405-r) attempt 2, conflicts resolved with -X theirs) rolled back newer develop logic. The head commit  | superseded-empty-diff (security) confirmed by skeptics: The PR adds nothing. Its second commit f368fcc2c ('restore develop day-close money path') exactly reverts the salvaged commit 6fc3a9ce1, so `git diff 8b203969dc7d pr/966` is empty and both trees are 73fb343189ef. Develop

### #965 · DEV-217 / DEV-218 / DEV-219 (not cited by the PR) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/965 · branch `salvage/qa-artefacts` · head `df0a92a783` · group 3
- Title: docs(qa): archive restaurant/pharmacy QA runs and sev1 retest records (salvage)
- Verdicts: machine pending · QA FAIL · Security FAIL
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks not queued
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 965` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/965`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: An archived evidence screenshot contains the platform super-admin's ten MFA recovery codes in plaintext. Once this merges, they stay in develop's history permanently. | SEC-1 (security) confirmed by skeptics: The PR commits ten single-use MFA recovery codes, readable in a screenshot, for the platform SUPER_ADMIN operator qa-platform-admin@devfathom.test (named in qa/pharmacy/issues/002 and in sa-02-pharmacy-form.png). The pla

### #960 · DEV-281 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/960 · branch `salvage/rx-gate-410` · head `7aff998867` · group 3
- Title: fix: Pharmacy counter Rx gate for prescription-only medicines (salvage)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 9
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 960` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/960`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked the void-time fill reversal. reverseSaleFills is parameterized and scoped to org, branch and sale. The new trigger allows only a one-time reversedAt/By change, on a VOID sale, by the actor who voided it. Controlled voids still need dispense plus a witness PIN, and no gate file is reverted. T | superseded-by-develop-518-gate (qa) confirmed by skeptics: Develop already does what the issue asks: Rx-only and restricted non-controlled lines can no longer be sold without the pharmacist dispensing grant. The PR adds nothing to that gate. Its last commit (7aff99886, 'restore  | out-of-scope-fill-reversal-lifecycle (qa) confirmed by skeptics: Everything left in the net diff belongs to a different problem than DEV-281. It binds prescription fills to sale lines, reverses fills when a sale is voided, and replaces the append-only trigger on pharmacy_prescription_ | SEC-960-1 (security) confirmed by skeptics: Superseded: the PR does not implement the gate DEV-281 asks for, and develop already has it. The bypass the issue cites (a non-controlled Rx line taking `return addSaleLine(...)` with no check) was closed on develop by #

### #959 · DEV-290 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/959 · branch `salvage/khata-overlimit-399` · head `4fd5b1615b` · group 3
- Title: fix: Khata over-limit override approvable by owner/manager, re-checked in txn (salvage)
- Verdicts: machine pending · QA FAIL · Security FAIL
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 10
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 959` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/959`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR renamed the Khata override controls and made a reason mandatory, but the CI Playwright pharmacy-counter spec still targets the old labels and never fills a reason. The over-limit Khata e2e path will fail. | F2 (qa) confirmed by skeptics: The approver check is now purely role-based and skips the ABAC engine, so explicit DENY permission overrides are no longer honoured. On develop, an ADMIN whose overrides DENY '*' or 'admin:access' was refused. With this  | SEC-1 (security) confirmed by skeptics: Approver authority is a hard-coded role-key check. It skips the ABAC engine, so an explicit per-user DENY override cannot revoke it. isKhataOverrideApprover returns true for any ACTIVE user with tenant role ADMIN, or wit

### #956 · DEV-85 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/956 · branch `inky/issue-727` · head `795276fdce` · group 3
- Title: feat(#727): [Pharmacy] Date-based pharmacy promotions
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 11
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 956` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/956`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Automatic promotion lines are counted as staff DISCOUNT_OVERRIDE anomalies. Every promoted line has discountMinor>0 and approvedByUserId set to the promotion creator, and the anomaly query selects exactly those lines gro

### #955 · DEV-83 (GitHub #729) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/955 · branch `inky/issue-729` · head `996265a92f` · group 3
- Title: feat(#729): [Pharmacy] Churn scoring
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 12
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 955` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/955`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Branches that keep failing can starve every branch after them. Due branches are picked in the same order on every tick (organizationId, id) and capped at `take`. The run stops starting branches once the 180s CHURN_TICK_B

### #954 · DEV-88 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/954 · branch `inky/issue-722` · head `7eb551b88b` · group 3
- Title: feat(#722): [Pharmacy][P1] Split tender on one sale (cash + khata + wallet)
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 13
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 954` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/954`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #953 · DEV-84 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/953 · branch `inky/issue-728` · head `dbf633d126` · group 3
- Title: feat(#728): [Pharmacy] AI cash-close anomaly check
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 14
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 953` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/953`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The cash-close reader leaves `grossMinor` out of the sale-line select, for both completed sales (line 55) and voided sales (line 169). `saleTotalMinor` therefore falls back to `quantity * unitPriceMinor`. Since #636 (7fb

### #951 · DEV-260 (GitHub #439) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/951 · branch `inky/issue-439` · head `17ef2d2716` · group 3
- Title: feat(#439): [QA][sev3] Pharmacy Urdu receipts use ASCII digits and ignore the locale for numbers
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 15
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 951` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/951`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR is 36 commits behind develop and conflicts with it in counter-receipt-view.tsx and counter-receipt-presentation.ts. Develop has since added money-formatting paths the PR does not cover, so after any merge Urdu rec

### #950 · DEV-120 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/950 · branch `inky/issue-661` · head `5c33b2dffe` · group 3
- Title: feat(#661): [sev3] quarantinePart gated by pharmacy:inventory instead of pharmacy:safety
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 16
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 950` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/950`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: The gate is correct. quarantinePart moves to capabilityProcedure('pharmacy:safety'), whose can() check runs server-side before any input handling or database access. Branch and org scope through scopeFor/assertInOrganization is unchanged, there are no raw SQL changes, and the denial test asserts tha | superseded-by-develop (qa) confirmed by skeptics: The PR is superseded. Develop already contains the issue fix and the requested tests, and the PR adds nothing that is still needed. | SEC-950-1 (security) confirmed by skeptics: Superseded, not a vulnerability. origin/develop already makes the same fix: commit b81916c8e ("recover: gate quarantinePart on pharmacy:safety instead of pharmacy:inventory (#281)"), which is not in this PR's history. On

### #949 · DEV-93 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/949 · branch `inky/issue-716` · head `0c9fcd4793` · group 3
- Title: feat(#716): [Pharmacy][P0] Owner full data export ("no lock-in" button)
- Verdicts: machine pending · QA FAIL · Security FAIL
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 17
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 949` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/949`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Sales and sale-line exports compute gross as quantity * unitPriceMinor and ignore the line's stored grossMinor. On develop (#636 / 7fba6c27b), a mixed-lot line stores grossMinor = floor(weighted/units) and unitPriceMinor | F2 (qa) confirmed by skeptics: Over /api/trpc, a wrong-PIN strike on `request` (and on the tRPC `download`) is never stored. verifyOwnerExportPin calls ctx.db.$transaction, which reuses the request's open transaction. The router then throws a TRPCErro | SEC-1 (security) confirmed by skeptics: The PIN lockout does not hold on the main transport, so the PIN can be brute-forced. /api/trpc runs the whole request inside one withTenantDb transaction (src/app/api/trpc/[trpc]/route.ts:322 throws TransactionAborted on

### #947 · DEV-89 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/947 · branch `inky/issue-720` · head `0f9ffa373f` · group 3
- Title: feat(#720): [Pharmacy][P1] Licence and registration renewal reminders
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 18
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 947` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/947`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: A supplier licence reminder only stops when the renewal explicitly supersedes the old filing (supersedesId). The supplier form defaults to 'No — this is a new licence' and its hint says supersession is for corrections. S

### #946 · DEV-87 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/946 · branch `inky/issue-723` · head `cc456c38df` · group 3
- Title: feat(#723): [Pharmacy][P2] SMS fallback for utility messages
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 19
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 946` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/946`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: New unit test fails at the PR head. The machine check (head cc456c38) reports this file as the only new unit failure, and the assertion at line 248 is the one that fails. | F2 (qa) confirmed by skeptics: Khata SMS bypasses the existing at-most-once-per-week khata reminder cap when the channel changes. Suppose a payer gets the weekly WhatsApp reminder (or an UNKNOWN/PENDING outcome) and then loses WhatsApp consent, for ex

### #945 · DEV-100 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/945 · branch `inky/issue-708` · head `563fe97150` · group 3
- Title: feat(#708): [Pharmacy][P0] Sindh cash-memo receipt mode (Drug rules r.18)
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 20
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 945` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/945`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #942 · DEV-82 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/942 · branch `inky/issue-732` · head `13677b4db2` · group 3
- Title: feat(#732): [Pharmacy] Live cold-chain sensor push
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 21
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 942` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/942`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR accepts readings stamped up to MAX_SENSOR_CLOCK_SKEW_MS (2 min) in the future, but evaluates the zone before and after ingest, and runs refreshStockSignals, at server `now`. loadTemperatureZoneStatuses/deriveTempe

### #941 · DEV-90 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/941 · branch `inky/issue-719` · head `d50b9018ae` · group 3
- Title: feat(#719): [Pharmacy][P1] Shelf and price sticker printing for unbarcoded or loose stock
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 22
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 941` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/941`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #940 · DEV-91 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/940 · branch `inky/issue-718` · head `ab37e1eb7a` · group 3
- Title: feat(#718): [Pharmacy][P1] Non-drug retail items with promo eligibility
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 23
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 940` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/940`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #934 · DEV-109 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/934 · branch `inky/issue-673` · head `0403b5b68a` · group 3
- Title: feat(#673): [Pharmacy Accounts][S3] Add read-only canonical account-code normal-side reference
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 24
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 934` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/934`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked tenant actor and org match, module gate, ADMIN-or-reports:financial check, and reports:operational plus session usability (enforced by calling the real Reports branches procedure). Also checked tenant-scoped active-branch reads, deny-on-invalid-branch, React-escaped output, no raw SQL or sec | superseded-by-develop (qa) confirmed by skeptics: Develop already has a merged implementation of this issue at the same four paths, so the PR adds nothing the issue still needs. | SEC-1 (security) confirmed by skeptics: Superseded. Develop already satisfies DEV-109/#673 on its own. Commit adec4fd2c 'fix(#680): [S3] Add read-only canonical account-code normal-side reference (#128)' added the same four allocated files. Its page gates on r

### #929 · DEV-121 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/929 · branch `cloud/issue-660` · head `982fb2ab3d` · group 3
- Title: fix(#660): [QA][sev2] Pharmacy activation gate: regulatory profile isn't bound to an active branch or to the branch's province/premises
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 25
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 929` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/929`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: e2e-lifecycle-fixture-unbound-premises (qa) confirmed by skeptics: The PR makes assertStoredBranchMayOperate run regulatoryProfileBindingDenial before the rule-set and licence checks. Any non-placeholder profile whose premises lack an addressLine/city matching the branch is now refused 

### #915 · DEV-197 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/915 · branch `cloud/issue-526` · head `3949ea03e1` · group 3
- Title: fix(#526): [QA][sev2] Prescription calendar validity shifts by device timezone and expires at UTC midnight
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 26
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 915` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/915`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The server sale gates moved to org-timezone calendar validity but have no test of that boundary. These are resolvePrescriptionReference (line 99), recordCompletedPrescriptionReference (line 218) and the controlled-medici

### #855 · DEV-180 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/855 · branch `cloud/issue-577` · head `6ba261a378` · group 3
- Title: fix(#577): [QA][sev2] Purchasing: Branch-limited staff can read and change other branches' purchase orders
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 27
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 855` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/855`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked that every PO and receipt read and mutation resolves the owning branch through resolveRestaurantActor before the domain call, that org scope and RLS are kept, that the lists are filtered before pagination, and that the tests assert the denial paths. I found no vulnerability and no raw SQL. T | F1-superseded (qa) confirmed by skeptics: Develop already meets the issue on its own, so this PR is superseded. Commit 2ac18cbb2 on origin/develop (fix(#546), PR #203; #546 is the original of #577) adds the branch checks the issue asks for to every read and chan | SEC-1 (security) confirmed by skeptics: Superseded. origin/develop already fixes the same issue in commit 2ac18cbb2, 'fix(#546): Purchasing: Branch-limited staff can read and change other branches' purchase orders (#203)'; #577 and DEV-180 are copies of #546. 

### #814 · DEV-296 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/814 · branch `cloud/issue-385` · head `42829d61d8` · group 3
- Title: fix(#385): Khata reminders: language can't be set, no Urdu template, Meta provider unconfigured
- Verdicts: machine pending · QA FAIL · Security FAIL
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 28
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 814` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/814`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1-superseded (qa) confirmed by skeptics: Develop already meets every DEV-296 requirement on its own, and this PR adds nothing the issue still needs. | F2-duplicate-migration (qa) confirmed by skeptics: The PR adds a second migration that creates the same column and CHECK constraint develop already creates. Git does not flag it as a conflict, but it would break `prisma migrate deploy` after a merge. | F3-owner-approval-gate-removed (qa) confirmed by skeptics: The PR deletes the owner-approval guard in createWhatsAppProvider, so Meta credentials in the environment alone now turn on live sends for every caller, not just Khata reminders. A safety test was also rewritten to asser | SEC-1 (security) confirmed by skeptics: The PR removes the owner-approval guard from createWhatsAppProvider. Before, a Meta provider built from environment config threw NOT_CONFIGURED 'Live sending is disabled pending owner approval.' for sendText and sendTemp | SUP-1 (security) confirmed by skeptics: Develop already fixes the issue on its own. #385 is a copy of #294, and develop merged fc4cfcca6 'fix(#294): Khata reminders: language can't be set, no Urdu template, Meta provider unconfigured (#239)'. That commit adds 

### #812 · DEV-298 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/812 · branch `cloud/issue-381` · head `3a5ef472fa` · group 3
- Title: fix(#381): Licence invalid 00:00–04:59 PKT on its start day; profile effective today shows as scheduled until 05:00
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 29
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 812` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/812`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Regression: when an operator profile supersedes an active placeholder in a workspace west of UTC, no profile is in force from the stored UTC midnight until local midnight. Before this PR the handover had no gap. The PR's | F2 (qa) confirmed by skeptics: Issue item 2 (a profile effective today shows as scheduled until 05:00 PKT) is fixed through the new in-memory twin isRegulatoryProfileEffective plus evaluateBranchRegulatoryStatus(..., timeZone), but neither has a test.

### #811 · DEV-299 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/811 · branch `cloud/issue-380` · head `c2d57bfb2b` · group 3
- Title: fix(#380): Khata cash collections never reach the cash drawer (+250 variance at close)
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 30
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 811` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/811`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #805 · DEV-293 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/805 · branch `cloud/issue-395` · head `95854e0252` · group 3
- Title: fix(#395): [sev2] Goods-in reversal doesn't correct the controlled register, leaving it overstated
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 31
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 805` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/805`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: listGoodsReceipts spreads `...scope` into two Prisma `where` clauses (lines 500 and 507). The router sends a ReceivingScope that includes `actorId`. Stock movements are therefore filtered to the viewer's own postings. Ph | F2 (qa) confirmed by skeptics: The PR changes the DB-suite connection precedence to `TEST_DATABASE_URL ?? CONTROLLED_TEST_DATABASE_URL ?? OWNER_DATABASE_URL`. In the QA gate, TEST_DATABASE_URL is the gate_runtime role, which has no CREATE privilege on

### #776 · DEV-23 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/776 · branch `cloud/issue-759` · head `7d6b7ee3e8` · group 3
- Title: fix(#759): [Pharmacy][Growth] WhatsApp campaign cost preview from current rate card
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 32
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 776` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/776`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: This is an unrelated change outside the cost-preview scope, and nothing tests it. The PR adds new terms to the shared marketing-copy block list (\bsalt\b, antibiotic, analgesic, painkiller, antacid, antihistamine, antivi

### #769 · DEV-76 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/769 · branch `cloud/issue-740` · head `9f2c33b1c7` · group 3
- Title: fix(#740): [Pharmacy][Growth] Khata collection reminders with Raast payment link
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 33
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 769` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/769`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The trial merge with develop conflicts in khata-reminders.ts and its test, and the conflict is not mechanical. The PR hard-codes a three-value list [formatMinor(balance), plan.dueDate, config.khataPaymentLink!] and keeps | F2 (qa) confirmed by skeptics: The spec's 'owner-configurable schedule' is not met. The reminder interval, balance floor and Raast/wallet link are read only from deployment env vars (PHARMACY_WHATSAPP_KHATA_REMINDER_INTERVAL_DAYS, _KHATA_MIN_BALANCE_M

### #241 · DEV-197 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/241 · branch `codex/fix-488` · head `51a8a6afb8` · group 3
- Title: fix(#488): Prescription calendar validity shifts by device timezone and expires at UTC midnight
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 34
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 241` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/241`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #132 · DEV-101 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/132 · branch `codex/fix-692` · head `b8d79ee907` · group 3
- Title: fix(#692): [planned] Narrow nontrade accrual journal voucher and account catalog (CEO-JVCORE-20261025
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 35
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 132` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/132`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR adds the FinanceAccountCode value MANUAL_NONTRADE_ACCRUAL (schema.prisma, migration 20261025212200) but does not add it to the profit-and-loss map, which `satisfies Record<FinanceAccountCode, Classification>`. Tha | F2 (qa) confirmed by skeptics: The new page shows error and success states with Tailwind classes `text-status-danger` and `text-status-success`. Neither is defined in src/app/globals.css; they exist only in the historical docs/superpowers/prototype-re | F3 (qa) confirmed by skeptics: The PR changes the canonical journal writer that every finance posting uses. It adds a voucher-only replay identity check that throws MISSING_SOURCE when a key is reused with a different source, and a cumulative safe-int

### #66 · DEV-295 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/66 · branch `fix/followup-299` · head `b6820a067c` · group 3
- Title: fix: pharmacy follow-up for #299 (revalidation required)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 36
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 66` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/66`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked the six-file delta: no production, schema or RLS change, no raw SQL from user input, no secrets. Tests use the real ABAC can(). The only blocker is that the PR is superseded: develop already lets canonical Cashiers through the counter gate (2ee391bd3). Develop also moved Khata/CREDIT tender  | F1-superseded (qa) confirmed by skeptics: Develop already satisfies DEV-295 without this PR, and the PR adds nothing the issue still needs. The PR has no runtime change, and its own notes call the issue already fixed. | F2-stale-khata-contract (qa) confirmed by skeptics: The new CREDIT/KHATA tests assume Khata tender is gated on pharmacy:dispense, as it was before #391. Develop changed that on purpose (427106e35, fix(#391)): Khata now requires pharmacy:counter and refuses dispense-only c | F3-unrelated-ci-script (qa) confirmed by skeptics: The PR adds a 150-line CI runner that is out of scope for DEV-295 and never runs. It accepts only old-repo PR 641, and no workflow or package script calls it. | SEC-1 (security) confirmed by skeptics: Superseded. Develop already satisfies DEV-295 on its own, and the PR adds nothing develop still needs. The PR changes no runtime code: its own body says src/server/routers/pharmacy-sales.ts is byte-identical to the base.

### #63 · none (PR #63 port; no DEV-<n> in title, no Linear issue found for integration/consolidation-20261019) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/63 · branch `port/consolidation-20261019` · head `1495660b84` · group 3
- Title: port: consolidation-20261019 (from Mac archive)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 37
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 63` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/63`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The supersession fix ported from qa-306 (DEV-466) misses the central purchase-order path. createCentralPurchaseOrder accepts a supplier when it has any verified, unexpired licence, including one that a later filing super | F2 (qa) confirmed by skeptics: No caller-level test uses a superseded licence. The new derivation `licences.some(c => c.supersedesId === licence.id)` in the order, send, quote-compare and goods-receipt paths is never exercised. Only the pure assertSup

### #37 · DEV-265 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/37 · branch `fix/qa-362` · head `1fae9603a7` · group 3
- Title: Inventory write-off witnessId isn't validated as a real active tenant user (#362)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 38
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 37` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/37`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked witness validation, org/branch scoping, the in-transaction can() re-check and every new raw SQL (all Prisma.sql-parameterized, org-filtered, run under withTenantDb RLS). Denial tests assert no-effect. The PR introduces no vulnerability, but develop already fixes the issue (1c615d3b4 #657, 7f | F1 (qa) confirmed by skeptics: Superseded. Develop (merge-base 47518cbf9) already fully implements DEV-265. The PR adds nothing the issue still requires. | F2 (qa) confirmed by skeptics: Regression: the new writeOffScopeFor breaks three router tests that came from develop, and the PR does not update them. The merge commit says "Tests updated for both behaviours", but these tests were left as they were. | F3 (qa) confirmed by skeptics: Behaviour change outside the issue. Write-off now requires the actor's own active branch assignment and refuses org ADMINs who have no assignment. On develop, any pharmacy:inventory holder can write off in any active bra | F4 (qa) confirmed by skeptics: The diff includes changes unrelated to the witness issue. | SEC-1 (security) confirmed by skeptics: Superseded: develop already fully satisfies DEV-265. Commit 1c615d3b4 (fix #657 / DEV-124) and commit 7f8649221 (fix #430, the GitHub issue that DEV-265 links, same title as this PR) are both in the merge-base. writeOff 

### #1171 · none (Dependabot production-patch group) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1171 · branch `dependabot/bun/develop/production-patch-51bcce1992` · head `0bab2ace7e` · group 3
- Title: chore(deps): bump the production-patch group across 1 directory with 11 updates
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 5
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1171` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1171`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1170 · none (Dependabot PR, no DEV-/# reference) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1170 · branch `dependabot/bun/develop/production-minor-d4c3b1f27e` · head `69469ed2d4` · group 3
- Title: chore(deps): bump the production-minor group across 1 directory with 21 updates
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 6
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1170` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1170`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1169 · none (Dependabot PR #1169; title cites no DEV-<n> Linear issue and no GitHub #<n> issue) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1169 · branch `dependabot/bun/develop/development-5a0671f224` · head `9f6ab1d5b7` · group 3
- Title: chore(deps-dev): bump shadcn from 4.22.0 to 4.22.1 in the development group
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 39
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1169` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1169`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1067 · DEV-342 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1067 · branch `codex/DEV-342-sanitize-prisma-errors` · head `fa75543302` · group 3
- Title: DEV-342: Sanitize Prisma errors on stale tenant writes
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 40
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1067` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1067`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1066 · DEV-343 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1066 · branch `codex/DEV-343-command-validation` · head `ddd19ed235` · group 3
- Title: DEV-343: Sanitize platform command validation errors
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 41
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1066` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1066`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The injected reason field's label changed from 'Reason (required)' to 'Operator reason', but the tests that find the field by that label were not updated. This causes the 2 NEW unit failures in the machine-check report a | F2 (qa) confirmed by skeptics: The client pattern check builds a RegExp at runtime from component props. The repository's Semgrep gate flags this as a blocking ReDoS finding (semgrep FAIL for this head). No form sets `pattern` today, and no test cover | F3 (qa) confirmed by skeptics: The main acceptance path has no test: the client-side message that names the field and the constraint, plus the new maxLength mirroring (500 on the operator reason). The existing sensitive-forms test checks focus and ari

### #1065 · DEV-171 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1065 · branch `codex/linear-mention-dev-171-qa]-sev3]-catering-accepted-decim` · head `a36eca5af9` · group 3
- Title: fix(catering): report durable decimal scale validation errors
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 42
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1065` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1065`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1064 · DEV-177 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1064 · branch `codex/linear-mention-dev-177-qa]-sev2]-devices-device-revocati` · head `b31874551c` · group 3
- Title: fix(devices): enforce dedicated revoke capability
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 43
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1064` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1064`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: `capabilityProcedure(action: Action)` (src/server/trpc.ts:355) only accepts members of `ALL_ACTIONS` from src/lib/abac/policies.ts. `'devices:revoke'` is not in that list (git grep finds it only in vertical-catalog.ts an | F2 (qa) confirmed by skeptics: The new regression test cannot exercise the branch-level deny path it claims to cover. `beforeEach` sets `mocks.can.mockResolvedValue(true)`, and `can` is the mocked `@/lib/abac` export, which `resolveCapabilityBranchAut

### #1063 · DEV-174 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1063 · branch `codex/linear-mention-dev-174-qa]-sev2]-menu-import-reviewed-fo` · head `328b3edd4c` · group 3
- Title: fix(menu-import): reject foreign-currency relabelling at commit
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 44
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1063` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1063`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1062 · DEV-169 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1062 · branch `codex/linear-mention-dev-169-qa]-sev2]-workforce-shift-swaps-c` · head `b07b3a69de` · group 3
- Title: fix(workforce): prevent shift swaps from transferring attendance
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 45
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1062` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1062`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The new regression test adds an object literal to state.adjustments with properties the fixture type does not declare. This introduces a TypeScript error (TS2353) that develop does not have. tsconfig includes **/*.ts, so

### #1059 · DEV-160 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1059 · branch `codex/linear-mention-dev-160-qa]-sev2]-restaurant-reports/insig` · head `dc17a4e99f` · group 3
- Title: fix(restaurant): preserve componentized refund net sales
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 46
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1059` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1059`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1058 · DEV-176 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1058 · branch `codex/linear-mention-dev-176-qa]-sev2]-offline-pos-modifier-re` · head `3b5bc3e06b` · group 3
- Title: fix(pos): gate offline replay on modifier price changes
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 47
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1058` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1058`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1057 · DEV-156 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1057 · branch `codex/linear-mention-dev-156-qa]-sev2]-restaurant-sop-evidence` · head `55e555d4a5` · group 3
- Title: fix(restaurant): prevent SOP evidence attribution spoofing
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 48
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1057` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1057`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1055 · DEV-157 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1055 · branch `codex/linear-mention-dev-157-qa]-sev2]-restaurant-refund-aware` · head `026d8d50c0` · group 3
- Title: fix(restaurant): keep close and rollup refund math aligned
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 49
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1055` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1055`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Security: the change is a pure in-memory refactor that pulls the refund math into a shared helper. It changes no queries, tenant/branch scoping, RLS transactions, input schemas, permission checks, raw SQL or logging, so I found no vulnerability. Not a security failure: no vulnerability was found, an | superseded-by-develop (qa) confirmed by skeptics: Develop already meets the issue in full, and this PR adds nothing the issue still needs. Commit e2c0d638b, 'fix(#589): Restaurant: refund-aware day-close totals always fail insight-rollup reconciliation (#222)', is an an | superseded-by-develop (security) confirmed by skeptics: develop already fixed this issue, and the PR changes no behaviour. Commit e2c0d638b, "fix(#589): Restaurant: refund-aware day-close totals always fail insight-rollup reconciliation" (#222), is an ancestor of merge-base 4

### #1054 · DEV-179 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1054 · branch `codex/linear-mention-dev-179-qa]-sev2]-low-stock-rules-low-sto` · head `07a5a270d1` · group 3
- Title: fix(restaurant): enforce low-stock branch authorization
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 50
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1054` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1054`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1053 · DEV-149 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1053 · branch `codex/linear-mention-dev-149-qa]-sev2]-restaurant-menu-publica` · head `e825149863` · group 3
- Title: fix(restaurant): resolve all-channel menus at POS
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 51
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1053` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1053`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1052 · DEV-168 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1052 · branch `codex/linear-mention-dev-168-qa]-sev2]-printing-read-only-user` · head `7629f9f99c` · group 3
- Title: fix(printing): prevent read-only users from fabricating print jobs
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 52
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1052` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1052`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #1051 · DEV-175 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1051 · branch `codex/linear-mention-dev-175-qa]-sev2]-menu-import-approving-a` · head `01e1d3bc7e` · group 3
- Title: fix(menu-import): require review of extracted variant prices
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 53
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1051` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1051`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The new test adds a type error. Its overridden page object omits required ImportPage fields, which breaks `tsc --noEmit`. It probably breaks `next build` too, because the build typechecks the whole tsconfig include unles

### #1007 · none-linked (PR #1007 body scope) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/1007 · branch `fix/af-tool-choice-auto` · head `ea71f38e08` · group 3
- Title: feat(ask-fathom): remove forced requestLeave tool_choice
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 54
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 1007` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/1007`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #964 · none · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/964 · branch `salvage/hotel-p1-p2` · head `b1d83d2046` · group 3
- Title: feat(hotel): reservations, front desk, folio ledger, housekeeping, rate plans (salvage)
- Verdicts: machine pending · QA FAIL · Security FAIL
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 55
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 964` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/964`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: An existing governance test will now fail. It pins every `hotel_` table as a closed list. The PR's migrations add 11 new hotel_ tables, and the list was not updated. | F2 (qa) confirmed by skeptics: Reservation create never checks the party against the room type's capacity or its active flag. One stay unit always consumes one unit of supply, whatever the party size. A 20-adult party can be booked into a 2-adult room | SEC-1 (security) confirmed by skeptics: The MAX_STAY_NIGHTS bound only takes effect after the work it is meant to prevent. reservationCreateInput (reservations.ts:89), availabilityInput (hotel-reservations.ts:45) and ratePlanQuoteInput (hotel-rate-plans.ts:34)

### #963 · none (no DEV-<n> or #<n> in title; commits cite fix(#963), which is this PR itself; body says it relates to WTS PR #115 / closed RDF PR #6, with no RDF issue matched) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/963 · branch `salvage/growth-g1-followup` · head `5bb6d451e0` · group 3
- Title: chore: Growth G1 models follow-up (salvage; likely superseded)
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 56
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 963` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/963`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #962 · DEV-245 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/962 · branch `salvage/agency-projects-idor-456` · head `d151ac7749` · group 3
- Title: fix: Agency REST projects verify clientId/memberIds belong to org (salvage)
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 57
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 962` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/962`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #961 · DEV-304 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/961 · branch `salvage/comp-permission-368` · head `5dda021768` · group 3
- Title: fix: Restaurant comp gated on orders:complimentary, add orders:comp (salvage)
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 58
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 961` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/961`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #906 · DEV-140 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/906 · branch `cloud/issue-640` · head `0665575cd5` · group 3
- Title: fix(#640): [QA][sev3] API docs advertise PATCH /api/v1/projects/{id} and /clients/{id}, but routes export only GET/DELETE
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 59
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 906` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/906`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Security review: the PR changes only docs/admin-platform/api.md and adds a Vitest file that reads files. No runtime code, auth, tenant scoping, SQL, secrets or permission paths changed, and I found no vulnerability.test.ts pinning both rows to the routes. Close as superseded. Not a security failure: | superseded-by-develop (qa) confirmed by skeptics: Develop already satisfies the whole issue, and the PR adds nothing develop still lacks. Commit a7c26f27f, 'fix(#613): [sev3] API docs advertise PATCH ... (#174)', landed after merge-base 902831af3. It rewrote api.md:80-8 | SEC-906-1 (security) confirmed by skeptics: The PR is superseded, not vulnerable. Develop commit a7c26f27f (#174), made after the merge-base 902831af3d51, already removed the PATCH claims. On origin/develop, api.md lists `GET /api/v1/projects/{id}`, `DELETE /api/v

### #903 · DEV-182 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/903 · branch `cloud/issue-572` · head `1209e9b318` · group 3
- Title: fix(#572): [QA][sev3] Tax profiles: Preset effective dates start at UTC midnight instead of branch midnight
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 60
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 903` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/903`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #902 · DEV-189 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/902 · branch `cloud/issue-551` · head `9bed1639ed` · group 3
- Title: fix(#551): [QA][sev3] Persisted role grants bypass mandatory resignation-review resource constraints
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 61
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 902` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/902`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #888 · DEV-252 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/888 · branch `cloud/issue-448` · head `e597375dd8` · group 3
- Title: fix(#448): [QA][sev3] Agency invoices: create form has no tax input (always sends tax 0) and discounts aren't supported anywhere
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 62
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 888` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/888`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #887 · DEV-261 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/887 · branch `cloud/issue-438` · head `06a3a56277` · group 3
- Title: fix(#438): [QA][sev3] Agency invoice status dropdown offers transitions the server rejects
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 63
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 887` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/887`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: superseded-by-develop (qa) confirmed by skeptics: Develop already fully satisfies the issue on its own (commit 648268017, 'fix(#396): [sev3] Agency invoice status dropdown offers transitions the server rejects (#134)', landed after this PR's merge-base 902831af3d51). Th | SEC-887-1 (security) confirmed by skeptics: Superseded: develop already fully satisfies the issue independently. Commit 648268017 'fix(#396): [sev3] Agency invoice status dropdown offers transitions the server rejects (#134)' (#396 is the original that #438/DEV-26

### #886 · DEV-266 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/886 · branch `cloud/issue-429` · head `f19aed5a07` · group 3
- Title: fix(#429): [QA][sev3] Resending an invite while an old-token accept is mid-hash lets the old request claim the new row
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 64
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 886` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/886`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #882 · DEV-297 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/882 · branch `cloud/issue-383` · head `62f1b9e42b` · group 3
- Title: fix(#383): #282 pg_trgm grant migration grants nothing when the migrator doesn't own the extension
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 65
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 882` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/882`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #875 · DEV-303 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/875 · branch `cloud/issue-371` · head `21eefe8f62` · group 3
- Title: fix(#371): No way to reverse a mistaken comp; recut locked after any tender
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 66
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 875` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/875`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #872 · DEV-305 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/872 · branch `cloud/issue-367` · head `bf8248f190` · group 3
- Title: fix(#367): Order ticket shows live gross service, not the bill's service
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 67
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 872` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/872`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked getOrderForBranch and its route: withTerminalAuth with withTenantDb org scope, branchId from the device context, orderId checked by zod, bills limited to the order's non-VOID rows, no raw SQL, no new fields exposed. No vulnerability found. Not a security failure: no vulnerability was found,  | F1-superseded (qa) confirmed by skeptics: Develop already fully satisfies the issue, and the PR changes no behaviour. The fix (51763bc89 'fix(#274)', the same defect copied to #367/DEV-305) was already in this PR's merge-base 902831af. All the PR adds is a cosme | superseded-by-develop (security) confirmed by skeptics: Not a vulnerability. The PR's only production change (lines 569-572 at the PR head) moves the existing expression `order.bills.length > 0 ? money(billedServiceCharge) : quoted.serviceCharge` into a `ticketServiceCharge` 

### #864 · DEV-345 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/864 · branch `cloud/issue-314` · head `18653d3c14` · group 3
- Title: fix(#314): [QA][P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently truncates at 500 rows
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 68
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 864` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/864`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #863 · DEV-349 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/863 · branch `cloud/issue-310` · head `ad17ea5b29` · group 3
- Title: fix(#310): [QA][P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below minimum target size on both login forms
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 69
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 863` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/863`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #862 · DEV-351 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/862 · branch `cloud/issue-308` · head `9607c71db6` · group 3
- Title: fix(#308): [QA][P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abyss/brass utilities, and controls that bypass the radius scale
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 70
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 862` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/862`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #854 · DEV-184 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/854 · branch `cloud/issue-570` · head `2414d1daeb` · group 3
- Title: fix(#570): [QA][sev2] Daily close: Unbilled active orders can create unpayable bills after close
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 71
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 854` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/854`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: security verdict set to PASS by hand: Checked the cutBills/openOrder closed-day guards, the cutClose/correctClose guard under the branch-day advisory lock (parameterized $executeRaw), org/branch scoping, error mapping and the close-packet permission split. The PR introduces no vulnerability. Not a security failure: no vulnerability was  | F1 (qa) confirmed by skeptics: Superseded. Develop already satisfies DEV-184 independently, and the PR adds nothing the issue still needs. Its conflicts with develop are not mechanical: both sides implement the same feature with different field names  | superseded-by-develop-793bf360a (security) confirmed by skeptics: Superseded, not a vulnerability. Issue #570 / DEV-184 is a copy of fork issue #538, and develop already merged the fix for it as 793bf360a (PR #202), after this PR's merge-base 9daab3f7. At the develop tip: (1) loadClose

### #853 · DEV-185 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/853 · branch `cloud/issue-568` · head `46a558a16c` · group 3
- Title: fix(#568): [QA][sev2] Daily close: Future dates can be closed before trading begins
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 72
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 853` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/853`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #850 · DEV-243 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/850 · branch `cloud/issue-458` · head `eb5b9445b0` · group 3
- Title: fix(#458): [QA][sev2] Agency invoice print/PDF shows DevFathom as the seller instead of the agency
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 73
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 850` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/850`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #841 · DEV-259 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/841 · branch `cloud/issue-440` · head `2672d2a1b9` · group 3
- Title: fix(#440): [QA][sev2] Agency invoices: Mark paid sets PAID without recording a payment, so the balance is wrong and payment entry is hidden
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 74
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 841` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/841`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #838 · DEV-264 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/838 · branch `cloud/issue-435` · head `956fd61876` · group 3
- Title: fix(#435): [QA][sev2] Agency team: team:setRole is never checked, so an ADMIN denied it can still grant or revoke roles
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 75
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 838` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/838`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The three new 'member profile saves' tests (lines 88-114) fail at the PR head. Clicking Edit renders EditMemberForm, which calls useEntitlements() and trpc.organizationAdmin.departments.useQuery. The test mocks neither,  | F2 (qa) confirmed by skeptics: The test 'invites when team:setRole is allowed' fails. With findFirst mocked to null, the assistant inviteMember tool goes on to the seat check (added on develop by #884), which the test does not mock. That check then re

### #305 · PR-305 (no Linear/GitHub issue cited) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/305 · branch `dependabot/bun/develop/eslint-10.11.0` · head `5b0e61bad9` · group 3
- Title: chore(deps-dev): bump eslint from 9.39.5 to 10.11.0
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 76
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 305` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/305`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #304 · PR-304 (Dependabot; no Linear issue) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/304 · branch `dependabot/bun/develop/typescript-7.0.2` · head `a1b770fdb9` · group 3
- Title: chore(deps-dev): bump typescript from 5.9.3 to 7.0.2
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 77
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 304` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/304`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR's only stated requirement, bumping typescript to 7.0.2, is not delivered. The head commit reverses it and pins 5.9.3, which develop already installs. Merging would put a commit titled 'bump typescript from 5.9.3 t

### #286 · none · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/286 · branch `recover/followup-rgap-jobs` · head `b010a3a720` · group 3
- Title: recover: dead-letter exhausted stale jobs; idempotent dead-job requeue
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 78
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 286` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/286`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #275 · DEV-415 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/275 · branch `codex/fix-508` · head `e0138d8ecf` · group 3
- Title: fix(#508): Future-dated approved resignations never execute scheduled offboarding
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 79
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 275` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/275`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The legacy backfill treats `reviewedAt >= lastWorkingDay` as proof the account was already offboarded. That is only true for the tRPC router. At the merge base the assistant tool reviewResignation never deactivated anyon

### #262 · DEV-175 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/262 · branch `codex/fix-556` · head `3b4029472d` · group 3
- Title: fix(#556): Menu import: Approving a line imports variant prices the reviewer cannot see
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 80
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 262` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/262`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #261 · DEV-390 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/261 · branch `codex/fix-554` · head `4300993728` · group 3
- Title: fix(#554): SOP escalation: Configured escalation policies never receive production jobs
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 81
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 261` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/261`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1-merged-typecheck-claimToken (qa) confirmed by skeptics: Semantic conflict with develop: the textual merge is clean, but the merged tree fails `tsc --noEmit`. Develop's #569 change (a28dead46) made `claimToken: string` a required field of `ClaimedJob`. This PR's new test 're-e

### #259 · DEV-183 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/259 · branch `codex/fix-539` · head `542c55e707` · group 3
- Title: fix(#539): Tax quotation: Multi-quantity previews round tax differently from settlement
- Verdicts: machine pending · QA FAIL (partial) · Security FAIL (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 82
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 259` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/259`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #253 · DEV-328 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/253 · branch `codex/fix-222` · head `f784f018c0` · group 3
- Title: fix(#222): Dark-theme info status pill nearly invisible on branch settings
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 83
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 253` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/253`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #212 · DEV-384 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/212 · branch `codex/fix-567` · head `0b36f53fe0` · group 3
- Title: fix(#567): SOP verification: A verifier can invent the second identity for an SOP waiver
- Verdicts: machine pending · QA PASS (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 84
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 212` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/212`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #149 · DEV-332 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/149 · branch `codex/fix-169` · head `3810030f8e` · group 3
- Title: fix(#169): [Platform][sev4] JWT session cookie is reissued on every session read
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 85
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 149` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/149`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #146 · DEV-348 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/146 · branch `codex/fix-7` · head `e2673832e4` · group 3
- Title: fix(#7): [P2][Admin] Documented local setup cannot work — seed and prisma.config read .env only, 
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 86
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 146` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/146`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #145 · DEV-349 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/145 · branch `codex/fix-6` · head `fac67d55ea` · group 3
- Title: fix(#6): [P3][Auth] Show/hide password toggle is keyboard-unreachable (tabindex="-1") and below min
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 87
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 145` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/145`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR adds aria-pressed to a toggle whose accessible name already changes. When the password is revealed the button reads "Hide password" with aria-pressed=true, so assistive tech hears "Hide password, toggle button, pr

### #144 · DEV-351 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/144 · branch `codex/fix-4` · head `ada54fa59e` · group 3
- Title: fix(#4): [P3][UI] Studio token migration is incomplete — duplicate :root scales, live legacy abys
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 88
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 144` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/144`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #140 · DEV-119 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/140 · branch `codex/fix-639` · head `19d4093fba` · group 3
- Title: fix(#639): [sev2] AI routing: no seeded model prices and a provider-wide $3/$15 fallback make the Ant
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 89
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 140` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/140`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The issue asks for a test of effective-date precedence (and a fail-closed one). Those tests exercise effectiveModelPrice and pricedAIUsage, which only the tests call. Production prices usage through three copies of an in | F2 (qa) confirmed by skeptics: Schema drift. AiModelPrice declares `@@index([provider, model, effectiveFrom])` next to an `@@unique` on the same columns. The migration creates only the unique index, so the schema expects an index `ai_model_prices_prov | F3 (qa) confirmed by skeptics: This changes behaviour outside the issue. `maxOutputTokens: AI_GENERATION_LIMITS.maxOutputTokensPerStep` (4096) is now passed to every streamText call, including the existing non-budget path (Azure/Groq/Google/Vertex thr

### #136 · DEV-251 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/136 · branch `codex/fix-409` · head `48a3a9699a` · group 3
- Title: fix(#409): [sev3] Agency invoice list always shows $ even for PKR invoices
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 90
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 136` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/136`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #133 · DEV-345 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/133 · branch `codex/fix-11` · head `82b6d5cbd8` · group 3
- Title: fix(#11): [P2][Admin] Audit ledger shows raw actor IDs, cannot be searched by actor, and silently tr
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 91
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 133` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/133`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: Migration 20261026120000 adds the FK platform_audit_logs_actorPlatformUserId_fkey (NOT VALID, which still checks every new insert). This existing DB test runs executePlatformCommand with an actor that is never inserted i

### #105 · DEV-316 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/105 · branch `codex/fix-258` · head `4ccf84c2c1` · group 3
- Title: fix(#258): Reminder quiet-hour skips counted as skippedNoConsent; weekly dedupe key uses UTC epoch we
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 92
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 105` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/105`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #104 · DEV-317 · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/104 · branch `codex/fix-257` · head `0fa65aac13` · group 3
- Title: fix(#257): Show password toggle has tabindex -1
- Verdicts: machine pending · QA PASS · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 93
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 104` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/104`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #59 · none found (PR cites no DEV-<n> or #<n>; body says 'Docs PR 5 of the DevFathom documentation plan', migrated from WhatTheStack1/devfathom-commercial#530) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/59 · branch `docs/deploy-ops-security` · head `181616a6ac` · group 3
- Title: docs: AWS staging, runbook, environment variables and security overview
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 94
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 59` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/59`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )

### #57 · none · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/57 · branch `docs/restaurant-guide` · head `e73ccce445` · group 3
- Title: docs: restaurant guide and glossary (PR 3)
- Verdicts: machine pending · QA FAIL · Security PASS
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 95
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 57` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/57`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
- Decisions: F1 (qa) confirmed by skeptics: The PR's README edits were made against the pre-#55 index. Develop rewrote docs/README.md in 8b1a063cc (#55), so `git merge-tree origin/develop pr/57` conflicts in docs/README.md. The new restaurant links are not wired i | F2 (qa) confirmed by skeptics: The guide and glossary say co-authorization always needs a different manager. On develop, a sole owner can approve their own terminal co-authorizations by re-entering their PIN. The doc would therefore tell a one-person  | F3 (qa) confirmed by skeptics: The guide and glossary list comping (giving items away) as an available co-authorized action. On develop, comps are unavailable in this version: the public endpoint always refuses and the POS hides the control. | F4 (qa) confirmed by skeptics: The guide says every job role can read the menu and complete SOPs. The standard Accountant job role has neither capability.

### #56 · none (no DEV-<n> or GitHub issue cited; Linear searches for onboarding/docs/architecture/contributing/auth-and-roles/separation-of-duties found no matching issue) · in progress
- PR: https://github.com/RealDevFathom/devfathom-commercial/pull/56 · branch `docs/dev-onboarding-architecture` · head `a98f887528` · group 3
- Title: docs: developer onboarding, architecture, auth and roles, testing, contributing
- Verdicts: machine pending · QA FAIL (partial) · Security PASS (partial)
- Done so far: QA+Security reviews complete
- Next step: wait for machine checks queued at position 96
- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test 56` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/56`; tests `bunx vitest related --run <no code files>` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)
- Known failures: u | n | k | n | o | w | n |   | ( | c | h | e | c | k | s |   | n | o | t |   | r | u | n | )
