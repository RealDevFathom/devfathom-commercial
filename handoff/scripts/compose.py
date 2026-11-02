# Compose the verdict comment for one PR from recorded data.
# usage: compose.py <pr> -> writes comments/<pr>.md and comments/<pr>.json (verdicts)
import json, os, re, subprocess, sys

S = __import__('os').environ.get('HANDOFF_STATE', '/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad')
REPO = "/home/user/devfathom-commercial"
n = sys.argv[1]
os.makedirs(f"{S}/comments", exist_ok=True)


def jload(p, default=None):
    try:
        return json.load(open(p))
    except FileNotFoundError:
        return default


reviews = {}
for f in os.listdir(S):
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
fmt = json.loads(subprocess.check_output(["python3", "-I", f"{S}/format-check.py", f"pr/{n}"], text=True))

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
    parts.append("typecheck: 0 errors" + (f" (also clears the {len(tc['fixedBaselineErrors'])} errors already on develop)" if tc["fixedBaselineErrors"] else ""))
elif tc["exit"] >= 128:
    fail.append("typecheck")
    parts.append(f"typecheck did not complete (signal {tc['exit'] - 128})")
else:
    parts.append(f"typecheck: no new errors (`tsc --noEmit` exits {tc['exit']} only on the {tc['errors']} errors already on develop in test files)")
# lint + format
lint = s["lint"]
if lint["errors"]:
    fail.append("lint")
    parts.append(f"ESLint FAIL: {lint['errors']} error(s): " + "; ".join(m[:140] for m in lint["errorMessages"][:4]))
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
if t["codeFilesChanged"] == 0:
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
                msg += f"; {', '.join(files)} only fails under the gate's runtime DB role (it needs CREATE ROLE) and passes on this PR with a superuser role"
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
    lead = (f"the first run on {fx['initialSha'][:10]} failed on {fx['initialFailure']}; fixed in {fx['sha'][:10]} "
            f"({fx['what']}), and the re-run on that head gives")
mverdict = "FAIL" if fail else "PASS"
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
