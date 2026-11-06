# Compose the verdict comment for one PR from recorded data.
# usage: compose.py <pr> -> writes comments/<pr>.md and comments/<pr>.json (verdicts)
import json, os, re, subprocess, sys

S = __import__('os').environ.get('HANDOFF_STATE', '/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad')
REPO = __import__("os").environ.get("REPO", "/home/user/devfathom-commercial")
n = sys.argv[1]
os.makedirs(f"{S}/comments", exist_ok=True)


def jload(p, default=None):
    try:
        return json.load(open(p))
    except FileNotFoundError:
        return default


reviews = {}
for f in sorted(os.listdir(S), key=lambda x: os.path.getmtime(os.path.join(S, x))):  # newest review wins
    if f.startswith("review-") and f.endswith(".json") and not f.startswith("review-args"):
        for r in jload(f"{S}/{f}", []):
            reviews[str(r["n"])] = r
fixes = jload(f"{S}/fixes.json", {})          # pr -> {sha, initialSha, what}
overrides = jload(f"{S}/overrides.json", {})  # pr -> {qa:{verdict,details}, security:{...}}

head = subprocess.check_output(["git", "-C", REPO, "rev-parse", f"pr/{n}"], text=True).strip()
cdir = f"{S}/checks/{n}/{head}"
s = jload(f"{cdir}/summary.json")
if not s:
    sys.exit(f"no machine-check summary for {n} at head {head}")
retry = jload(f"{cdir}/retry.json")
fmt = json.loads(subprocess.check_output(["python3", "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "format-check.py"), f"pr/{n}"], text=True))

parts, fail = [], []
# deps / db
inst = s["install"]
parts.append("deps: `bun install --frozen-lockfile`" + (" OK" if inst["exit"] == 0 else f" exit {inst['exit']}")
             + ("" if "unchanged" not in inst["note"] else " (lockfile unchanged by this PR)"))
if inst["exit"] != 0:
    fail.append("install")
if s["migrate"]["exit"] != 0:
    parts.append("`prisma migrate deploy` FAILED on a fresh gate database")
    fail.append("migrate")
elif any(c.startswith("prisma/migrations/") for c in s["changed"]):
    parts.append("its migration applied cleanly with `prisma migrate deploy` on a fresh gate database")
# typecheck
tc = s["typecheck"]
if tc["newErrors"]:
    fail.append("typecheck")
    parts.append(f"typecheck FAIL: {len(tc['newErrors'])} new error(s): " + "; ".join(e[:180] for e in tc["newErrors"][:3]))
elif tc["exit"] == 0:
    # TS2307 "Cannot find module" lines in the develop baseline came from a stale install in the baseline checkout, not from develop's code
    _fixed = [e for e in tc["fixedBaselineErrors"] if "TS2307" not in e]
    parts.append("typecheck: 0 errors" + (f" (also clears the {len(_fixed)} errors already on develop)" if _fixed else ""))
elif tc["exit"] >= 128:
    fail.append("typecheck")
    parts.append(f"typecheck did not complete (signal {tc['exit'] - 128})")
else:
    where = "at its merge-base " + open(f"{cdir}/typecheck.baseline-ref").read().strip()[:10] if os.path.exists(f"{cdir}/typecheck.baseline-ref") else "on develop"
    parts.append(f"typecheck: no new errors (`tsc --noEmit` exits {tc['exit']} only on the {tc['errors']} errors already present {where})")
# lint + format
lint = s["lint"]
if lint.get("parseError") or (lint["exit"] != 0 and not lint["errors"]):
    fail.append("lint")
    parts.append(f"ESLint did not complete (exit {lint['exit']}, no report)")
elif "newErrors" in lint and lint["errors"] and not lint["newErrors"]:
    parts.append(f"ESLint (`eslint src/`): no new errors ({lint['errors']} already present at its {'merge-base' if lint.get('baseline') == 'merge-base' else 'base'})")
elif lint["errors"]:
    fail.append("lint")
    new = lint.get("newErrors") or lint["errorMessages"]
    parts.append(f"ESLint FAIL: {len(new)} new error(s): " + "; ".join(m[:140] for m in new[:4]))
else:
    parts.append("ESLint (`eslint src/`): 0 errors")
intro = [u["file"] for u in fmt["unformatted"] if not u["alreadyUnformattedOnDevelop"]]
pre = [u["file"] for u in fmt["unformatted"] if u["alreadyUnformattedOnDevelop"]]
if intro:
    fail.append("format")
    parts.append("Prettier FAIL on changed file(s): " + ", ".join(intro))
elif fmt["checked"]:
    parts.append(f"Prettier: {fmt['checked']} changed file(s) checked, none newly unformatted"
                 + (f" ({len(pre)} already unformatted on develop)" if pre else ""))
# tests
t = s["tests"]
vlog = open(f"{cdir}/vitest.log").read() if os.path.exists(f"{cdir}/vitest.log") else ""
no_tests = "No test files found" in vlog
if t["codeFilesChanged"] and (t.get("parseError") and not no_tests or (t["exit"] != 0 and not t["failedFiles"] and not no_tests)):
    fail.append("tests")
    parts.append(f"related tests did not complete (`vitest related` exit {t['exit']}, no usable report)")
elif t["codeFilesChanged"] == 0:
    parts.append("tests: no code files changed, so no related tests")
elif t["files"] == 0:
    parts.append("tests: `vitest related` found no tests for the changed files")
else:
    msg = f"related tests (`vitest related`, DB suites on a local gate-equivalent Postgres 16): {t['files']} files, {t['passed']} passed"
    if t["skipped"]:
        msg += f", {t['skipped']} skipped"
    if t["failedFiles"]:
        if retry is None:
            msg += f", {t['failed']} failed in {len(t['failedFiles'])} file(s) (not yet compared with develop)"
            fail.append("tests")
        else:
            att = retry["attributable"]
            env = [x for x in retry["envOnly"] if x not in att]
            prex = [x for x in retry["preexisting"] if x not in env]
            if att:
                fail.append("tests")
                msg += f"; FAIL: {len(att)} failure(s) caused by this PR: " + "; ".join(a[:160] for a in att[:3])
            if prex:
                files = sorted({p.split(' > ')[0] for p in prex})
                msg += f"; {len(prex)} failure(s) in {', '.join(files)} also fail identically on develop (pre-existing)"
            if env and not att:
                files = sorted({p.split(' > ')[0] for p in env})
                msg += (f"; {', '.join(files)} only {'fails' if len(files) == 1 else 'fail'} under the gate's runtime DB role "
                        f"(needs CREATE ROLE) and {'passes' if len(files) == 1 else 'pass'} on this PR with a superuser role")
    parts.append(msg)
# dependency-only PRs: full suite on the head, failing files re-run at the merge-base
fs = jload(f"{cdir}/fullsuite.json")
if fs is not None:
    parts = [x for x in parts if not x.startswith(("tests:", "related tests"))]
    fail = [x for x in fail if x != "tests"]
    if not fs.get("complete"):
        fail.append("tests"); parts.append("full test suite did not complete")
    else:
        msg = (f"tests: only package.json and bun.lock changed, so the full suite ran (`vitest run`, DB suites on a local gate-equivalent Postgres 16): "
               f"{fs['files']} files, {fs['passed']} passed" + (f", {fs['skipped']} skipped" if fs['skipped'] else ""))
        if fs["attributable"]:
            fail.append("tests"); msg += f"; FAIL: {len(fs['attributable'])} failure(s) not seen at the merge-base: " + "; ".join(a[:160] for a in fs["attributable"][:3])
        if fs.get("flakyPassedOnRerun"):
            files = sorted({x.split(' > ')[0] for x in fs["flakyPassedOnRerun"]})
            msg += (f"; {len(fs['flakyPassedOnRerun'])} test(s) in {', '.join(files)} failed once in the parallel full run but "
                    f"{fs.get('rerunNote', 'passed when re-run')} (timing flake, not caused by this PR)")
        if fs["preexisting"]:
            files = sorted({x.split(' > ')[0] for x in fs["preexisting"]})
            msg += f"; {len(fs['preexisting'])} failure(s) in {len(files)} file(s) also fail at its merge-base {fs['mergeBase'][:10]} (pre-existing)"
        parts.append(msg)
# build
b = s["build"]
if b["exit"] == 0:
    parts.append("build: `next build` passed")
else:
    fail.append("build")
    parts.append("build FAIL: " + "; ".join((b.get("errorLines") or ["see log"])[:3]))

fx = fixes.get(n)
lead = f"head {head[:10]}"
if fx and fx["sha"] == head:
    if fx.get("lead"):
        lead = fx["lead"]
    elif fx.get("noInitialRun"):
        lead = f"head {head[:10]}, which includes fix commit {fx['sha'][:10]} ({fx['what']})"
    elif fx["initialFailure"].startswith("nothing"):
        lead = (f"the first run on {fx['initialSha'][:10]} passed; fix commit {fx['sha'][:10]} ({fx['what']}) addresses the review "
                f"findings, and the re-run on that head gives")
    else:
        lead = (f"the first run on {fx['initialSha'][:10]} failed on {fx['initialFailure']}; fixed in {fx['sha'][:10]} "
                f"({fx['what']}), and the re-run on that head gives")
mverdict = "FAIL" if fail else "PASS"
_r = reviews.get(n) or {}
_sup = any("supersed" in (f.get("id", "") + f.get("problem", "")).lower() and not f.get("fixable", True)
           for f in (_r.get("qa") or {}).get("verifiedBlocking", []) if f.get("confirmed"))
if fail and _sup and not fixes.get(n):
    parts.append("no fix commit pushed for this because QA recommends closing the PR as superseded")
machine = f"Machine checks: {mverdict} ({lead}: " + "; ".join(parts) + ")."


def clean(txt):
    txt = re.sub(r"\s*(Security|QA)\s*:?\s*PASS\.?\s*$", "", txt.strip())
    txt = re.sub(r"^(Security|QA)\s*:?\s*(PASS|FAIL)\.?\s*", "", txt)
    txt = re.sub(r"^Read the code only\.\s*", "", txt)
    txt = re.sub(r"\s*Tests were not run\.", "", txt)
    txt = re.sub(r"\s*Machine checks were not run[^.]*\.", "", txt)
    return txt.strip().rstrip(".")


r = reviews.get(n)
out = {}
for key, label in (("qa", "QA"), ("security", "Security")):
    ov = overrides.get(n, {}).get(key)
    if ov:
        v, d = ov["verdict"], ov["details"]
        orig = (r or {}).get(key) or {}
        conf = [f for f in orig.get("verifiedBlocking", []) if f.get("confirmed")]
        fxn = fixes.get(n)
        if conf and fxn and fxn["sha"] == head and orig.get("verdict") == "FAIL" and "first review" not in d.lower():
            def clip(t, k=150):
                t = re.split(r"(?<=[.!?])\s", t.strip(), maxsplit=1)[0].rstrip(".")
                return t if len(t) <= k else t[:k].rsplit(" ", 1)[0].rstrip(",;:") + "…"
            short = "; ".join(clip(f["problem"]) for f in conf[:3])
            d = f"First review FAIL ({short}), fixed in {fxn['sha'][:10]}. Re-review: {d}"
    else:
        if not r or not r.get(key):
            sys.exit(f"no {key} review for {n}")
        v, d = r[key]["verdict"], r[key]["details"]
        confirmed = [f for f in r[key].get("verifiedBlocking", []) if f.get("confirmed")]
        if v == "FAIL" and not confirmed:
            sys.exit(f"{n} {key} FAIL with no confirmed finding: needs an override")
    out[key] = (v, clean(d))

body = (f"{machine}\n\nQA: {out['qa'][0]} ({out['qa'][1]}).\n\nSecurity: {out['security'][0]} ({out['security'][1]}).\n\n"
        "---\n_Generated by [Claude Code](https://claude.ai/code)_\n")
open(f"{S}/comments/{n}.md", "w").write(body)
json.dump({"pr": int(n), "head": head, "machine": mverdict, "qa": out["qa"][0], "security": out["security"][0], "machineFail": fail},
          open(f"{S}/comments/{n}.json", "w"))
print(f"{n} machine={mverdict}{fail if fail else ''} qa={out['qa'][0]} sec={out['security'][0]} len={len(body)}")
