# Generate HANDOFF.md (and handoff/state/*.json) from the live review state.
# usage: gen-handoff.py <repo-root>
import json, os, re, subprocess, sys, glob, datetime

S = os.environ.get("HANDOFF_STATE", "/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad")
WF = "/root/.claude/projects/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/subagents/workflows"
ROOT = sys.argv[1]
REPO_URL = "https://github.com/RealDevFathom/devfathom-commercial"


def jload(p, d=None):
    try:
        return json.load(open(p))
    except (FileNotFoundError, json.JSONDecodeError):
        return d


def git(*a):
    return subprocess.run(["git", "-C", "/home/user/devfathom-commercial", *a], capture_output=True, text=True).stdout.strip()


# ---------- items in scope
inv = {o["number"]: o for o in jload(f"{S}/inventory.json", [])}
g3 = {i["n"]: i for i in jload(f"{S}/g3-items.json", [])}
G1 = [1223, 1224, 1193, 1192, 1189, 1181, 1180, 1177, 1172, 1194, 1191, 1190, 1188, 1187, 1186, 1184, 1183, 1182, 1179, 1178, 1176, 1175, 1174, 1173]
G2 = [1166, 1165, 1164, 1163, 1162, 1161, 1160, 1157, 1156, 1155, 1154, 1153, 1152, 1151, 1150, 1149, 1148, 1158]
G3 = list(g3.keys())
titles = {}
for line in open(f"{S}/titles.tsv") if os.path.exists(f"{S}/titles.tsv") else []:
    k, v = line.rstrip("\n").split("\t", 1)
    titles[int(k)] = v

# ---------- reviews: finished workflow outputs + partial journals
reviews = {}
for f in glob.glob(f"{S}/review-g*.json"):
    if "args" in f:
        continue
    for r in jload(f, []):
        reviews.setdefault(r["n"], {}).update({k: r[k] for k in ("qa", "security") if r.get(k)})
partial = {}
for j in glob.glob(f"{WF}/*/journal.jsonl"):
    labels = {}
    for line in open(j):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") == "started":
            labels[e["key"]] = e.get("label", "")
        elif e.get("type") == "result" and isinstance(e.get("result"), dict):
            lab = labels.get(e["key"], "")
            m = re.match(r"^(qa|sec)#(\d+)$", lab)
            if m:
                partial.setdefault(int(m.group(2)), {})["qa" if m.group(1) == "qa" else "security"] = e["result"]
            m = re.match(r"^verify:(qa|sec)#(\d+):([^:]+):(\d)$", lab)
            if m:
                partial.setdefault(int(m.group(2)), {}).setdefault("votes", {}).setdefault(m.group(3), []).append(e["result"].get("confirmed"))
for n, p in partial.items():
    for k in ("qa", "security"):
        if k in p and k not in reviews.get(n, {}):
            reviews.setdefault(n, {})[k] = dict(p[k], partial=True, voteMap=p.get("votes", {}))

ledger = jload(f"{S}/ledger.json", {})
fixes = jload(f"{S}/fixes.json", {})
overrides = jload(f"{S}/overrides.json", {})
notes = jload(f"{S}/mc-notes.json", {})
queue = [l.split()[0] for l in open(f"{S}/queue.txt").read().split("\n") if l.strip()] if os.path.exists(f"{S}/queue.txt") else []
running = re.findall(r"start (\d+)", open(f"{S}/runner.log").read()) if os.path.exists(f"{S}/runner.log") else []
done_lines = re.findall(r"\] PR (\d+) ([0-9a-f]{40})", open(f"{S}/runner.log").read()) if os.path.exists(f"{S}/runner.log") else []
resume = open(f"{S}/resume.md").read().strip() if os.path.exists(f"{S}/resume.md") else "(no resume note)"


def head_of(n):
    return git("rev-parse", f"pr/{n}")


def summary(n):
    h = head_of(n)
    s = jload(f"{S}/checks/{n}/{h}/summary.json")
    return h, s, jload(f"{S}/checks/{n}/{h}/retry.json")


def dev_id(n):
    for k in ("qa", "security"):
        x = reviews.get(n, {}).get(k)
        if x and x.get("issue", {}).get("id"):
            return x["issue"]["id"]
    t = titles.get(n) or (inv.get(n) or {}).get("title") or ""
    m = re.search(r"DEV-\d+", t, re.I)
    if m:
        return m.group(0).upper()
    m = re.search(r"#(\d+)", t)
    return f"GH#{m.group(1)}" if m else "?"


def branch_of(n):
    return (g3.get(n) or {}).get("branch") or (inv.get(n) or {}).get("branch") or {1223: "saad/nice-thompson-99m17p", 1224: "saad/great-brown-id2w5x"}.get(n, "?")


def mc_text(s, retry):
    if not s:
        return "not run yet"
    tc = s["typecheck"]; t = s["tests"]
    bits = [f"typecheck exit {tc['exit']} ({len(tc['newErrors'])} new vs baseline)",
            f"eslint {s['lint']['errors']} errors",
            f"tests {t['passed']} passed / {t['failed']} failed in {len(t['failedFiles'])} files",
            f"build exit {s['build']['exit']}"]
    return "; ".join(bits)


def failures_text(n, s, retry):
    out = []
    if not s:
        return "unknown (checks not run)"
    for e in s["typecheck"]["newErrors"]:
        out.append(f"NEW typecheck: {e[:200]}")
    for m in s["lint"]["errorMessages"][:6]:
        out.append(f"NEW eslint: {m[:200]}")
    if retry:
        for a in retry["attributable"][:6]:
            out.append(f"NEW test failure: {a[:200]}")
        pre = sorted({x.split(' > ')[0] for x in retry["preexisting"]})
        if pre:
            out.append(f"also fail on develop/merge-base (pre-existing): {', '.join(pre)}")
        env = sorted({x.split(' > ')[0] for x in retry["envOnly"]})
        if env:
            out.append(f"env-only (gate runtime role lacks CREATE ROLE; pass as superuser): {', '.join(env)}")
    elif s["tests"]["failedFiles"]:
        out.append("test failures not yet compared with develop: " + ", ".join(f["file"] for f in s["tests"]["failedFiles"]))
    if s["build"]["exit"]:
        out.append("NEW build failure: " + "; ".join((s["build"].get("errorLines") or [])[:2]))
    if s["typecheck"]["exit"] and not s["typecheck"]["newErrors"]:
        out.append("typecheck baseline: the 4 errors already on develop (counter-console.test.tsx, duplicate-salt-acknowledgement.db.test.ts, pharmacy-inventory.test.ts, restaurant-catering.test.ts)")
    out += [f"note: {x}" for x in notes.get(str(n), [])]
    return out or ["none"]


def item(n, group):
    h, s, retry = summary(n)
    led = ledger.get(str(n))
    rv = reviews.get(n, {})
    fx = fixes.get(str(n))
    changed = (s or {}).get("changed") or []
    code = [c for c in changed if re.search(r"\.(ts|tsx|mts|js|mjs)$", c)]
    qv = rv.get("qa", {}); sv = rv.get("security", {})
    ov = overrides.get(str(n), {})
    qa = (ov.get("qa") or {}).get("verdict") or qv.get("verdict")
    sec = (ov.get("security") or {}).get("verdict") or sv.get("verdict")
    if led and led.get("posted"):
        status, nxt = "done", f"none: verdict comment posted ({led.get('url')})"
    elif led and not led.get("posted"):
        status, nxt = "blocked", f"verdict not posted: {led.get('reason')}"
    elif fx and fx["sha"] == h and not s:
        status, nxt = "in progress", f"re-check queued for fix {fx['sha'][:10]}; then `python3 handoff/scripts/compose.py {n}` and post comments/{n}.md"
    elif s and qa and sec:
        conf = [f for k in ("qa", "security") for f in (rv.get(k, {}).get("verifiedBlocking") or []) if f.get("confirmed")]
        mfail = bool(s["typecheck"]["newErrors"] or s["lint"]["errors"] or s["build"]["exit"] or (retry and retry["attributable"]))
        if (conf or mfail) and not fx and str(n) not in overrides:
            status = "in progress"
            nxt = "push one fix commit on " + branch_of(n) + " for: " + "; ".join(
                [f"{f['id']} {f['file']}:{f.get('line')} {f['suggestedFix'][:160]}" for f in conf] + (["machine-check failure listed below"] if mfail else []))
        else:
            status, nxt = "in progress", f"`python3 handoff/scripts/compose.py {n}`, then post comments/{n}.md via the poster workflow"
    else:
        status = "in progress" if (s or rv) else "not started"
        waits = []
        if not s:
            pos = queue.index(str(n)) + 1 if str(n) in queue else None
            waits.append(f"machine checks {'queued at position ' + str(pos) if pos else ('running' if str(n) in running[-2:] else 'not queued')}")
        if not qa or not sec:
            waits.append("QA/Security review " + ("running" if rv else "queued in a review workflow"))
        nxt = "wait for " + " and ".join(waits)
    url = f"{REPO_URL}/pull/{n}"
    lines = [f"### #{n} · {dev_id(n)} · {status}",
             f"- PR: {url} · branch `{branch_of(n)}` · head `{h[:10]}` · group {group}",
             f"- Title: {titles.get(n) or (inv.get(n) or {}).get('title')}",
             f"- Verdicts: machine {('PASS' if (led and led.get('machine') == 'PASS') else (led or {}).get('machine') or ('ran, see below' if s else 'pending'))} · QA {qa or 'pending'}{' (partial)' if qv.get('partial') else ''} · Security {sec or 'pending'}{' (partial)' if sv.get('partial') else ''}",
             f"- Done so far: " + "; ".join(x for x in [
                 f"checks on {s['sha'][:10]}: {mc_text(s, retry)}" if s else "",
                 f"fix commit {fx['sha'][:10]} ({fx['what']}; first run on {fx['initialSha'][:10]} failed on {fx['initialFailure']})" if fx else "",
                 "QA+Security reviews complete" if qa and sec else "",
                 f"verdict comment {led['url']}" if led and led.get("url") else ""] if x) or "nothing yet",
             f"- Next step: {nxt}",
             f"- Rerun checks: `bash handoff/scripts/check-pr.sh <lane-worktree> devfathom_gate_lane_a_test {n}` (typecheck `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit`; lint `bunx eslint src/` + `python3 handoff/scripts/format-check.py pr/{n}`; tests `bunx vitest related --run {' '.join(code[:8]) if code else '<no code files>'}{' …' if len(code) > 8 else ''}` with gate env; build `NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 bun run build`)",
             "- Known failures: " + " | ".join(failures_text(n, s, retry))]
    dec = []
    if str(n) in overrides:
        for k, v in overrides[str(n)].items():
            dec.append(f"{k} verdict set to {v['verdict']} by hand: {v['details'][:300]}")
    for k in ("qa", "security"):
        for f in (rv.get(k, {}).get("verifiedBlocking") or []):
            dec.append(f"{f['id']} ({k}) {'confirmed' if f.get('confirmed') else 'refuted'} by skeptics: {f['problem'][:220]}")
    if dec:
        lines.append("- Decisions: " + " | ".join(dec))
    return status, "\n".join(lines), dict(pr=n, dev=dev_id(n), branch=branch_of(n), head=h, status=status, qa=qa, security=sec,
                                           machine=(led or {}).get("machine"), comment=(led or {}).get("url"), fix=(fx or {}).get("sha"), next=nxt)


sections, states = [], []
for gname, nums in (("1 (#1172-#1194)", G1), ("2 (#1148-#1166)", G2), ("3 (rest, pharmacy first)", G3)):
    block = []
    for n in nums:
        st, txt, js = item(n, gname[0])
        block.append(txt); states.append(js)
    sections.append((gname, block))
cnt = {k: sum(1 for x in states if x["status"] == k) for k in ("done", "in progress", "blocked", "not started")}
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
verdicts = [x for x in states if x["status"] == "done"]
md = [f"# PR review handoff log", "",
      f"_Generated {now} from the live run state by `handoff/scripts/gen-handoff.py`. Do not hand-edit item sections; edit the resume note instead._", "",
      "## Resume here", "", resume, "",
      "## Progress", "",
      f"- Scope: every open PR into develop without a QA+Security verdict comment: group 1 #1172-#1194 (22, plus #1223 and #1224 opened during the run; #1225 is this tracking PR and is not reviewed), group 2 #1148-#1166 (18), group 3 the other 127 (pharmacy first). 118 older PRs already had verdict comments and are out of scope.",
      f"- Status: done {cnt['done']} · in progress {cnt['in progress']} · blocked {cnt['blocked']} · not started {cnt['not started']} (of {len(states)})",
      f"- Machine-check queue ({len(queue)} left, two lanes, runs serially per lane): {' '.join(queue[:40])}{' …' if len(queue) > 40 else ''}",
      f"- Last finished checks: " + ", ".join(f"#{a}@{b[:8]}" for a, b in done_lines[-6:]),
      "", "### Posted verdicts", "", "| PR | DEV | Machine | QA | Security | Fix commit | Comment |", "|---|---|---|---|---|---|---|"]
md += [f"| #{x['pr']} | {x['dev']} | {x['machine']} | {x['qa']} | {x['security']} | {(x['fix'] or '')[:10]} | {x['comment']} |" for x in verdicts]
md += ["", "## Rules in force", "",
       "- PRs into develop only. Never merge. Never touch staging or main. No force-push. Do not trigger GitHub Actions: every pushed commit carries `[skip ci]`.",
       "- Commits: no Co-Authored-By lines and no model names. One fix commit per PR, scoped to that PR's own issue.",
       "- Verdict comment format: `Machine checks: PASS/FAIL (details). QA: PASS/FAIL (details). Security: PASS/FAIL (details).` plus the Claude Code footer.",
       "- Machine checks count only failures the PR introduces. The 4 typecheck errors already on develop, test failures that also fail on develop or the merge-base, and suites that only fail because the gate runtime DB role lacks CREATE ROLE are reported but are not counted against the PR. Prettier counts only for files the PR newly leaves unformatted (develop already has 141 unformatted files in the gate's set).",
       "", "## How to resume (environment)", "",
       "1. `git fetch --unshallow origin || true; git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'` (PR heads are read as `pr/<n>`).",
       "2. Local gate-equivalent Postgres 16 on 127.0.0.1:55432 (password `gate-postgres-ci-only`): `bash handoff/scripts/setup-db.sh` creates the cluster, roles, `devfathom_gate_test`, migrates, seeds, and makes `devfathom_gate_template`.",
       "3. Worktrees: `git worktree add --detach $HANDOFF_STATE/laneA origin/develop` (likewise laneB, laneC for retries, fixD for fixes), then `bun install --frozen-lockfile` in each. Export `HANDOFF_STATE` to the directory holding those worktrees, `gate.env`, `baseline/typecheck.errors`, `checks/`, `queue.txt`.",
       "4. Run lanes: `setsid nohup bash handoff/scripts/run-lane.sh $HANDOFF_STATE/laneA devfathom_gate_lane_a_test $HANDOFF_STATE/queue.txt &` (and laneB/`_b_`). Typecheck and build share `heavy.lock` (15 GB RAM cannot fit two tsc runs).",
       "5. Reviews: one QA and one Security reviewer per PR (read-only, via `git show pr/<n>:path`), plus 2 skeptics per blocking finding (3rd on a split); see `handoff/scripts/review-g3.js`.",
       "6. Compose and post: `python3 handoff/scripts/compose.py <n>` writes comments/<n>.md; post it verbatim only after checking the head sha and that no verdict comment exists.",
       "7. Machine-readable state: `handoff/state/items.json` (one row per PR).", ""]
for gname, block in sections:
    md += [f"## Group {gname}", ""] + [b + "\n" for b in block]
os.makedirs(f"{ROOT}/handoff/state", exist_ok=True)
open(f"{ROOT}/HANDOFF.md", "w").write("\n".join(md))
json.dump(states, open(f"{ROOT}/handoff/state/items.json", "w"), indent=1)
for f in ("ledger.json", "fixes.json", "overrides.json", "mc-notes.json", "g3-items.json"):
    if os.path.exists(f"{S}/{f}"):
        open(f"{ROOT}/handoff/state/{f}", "w").write(open(f"{S}/{f}").read())
print(f"HANDOFF.md written: {cnt}")
