#!/usr/bin/env python3
"""DevFathom campaign worker collector (READ-ONLY).

Runs on the QA worker every 30 s (systemd timer). It only *reads* campaign files under
the jobs root, /proc, statvfs and read-only `systemctl` / `tailscale status` output.
It never writes under /workspace, never starts/stops/kills anything and never calls
git, gh or codex. Its own state lives in --state-dir (default /var/lib/ops-collector).

Usage:
  worker_collector.py --once                  # collect + push (systemd mode)
  worker_collector.py --root fixtures/jobs --once --print   # local dry run, no push
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sanitize import sanitize  # noqa: E402
import current_run as _cr  # noqa: E402
import live_activity as _live  # noqa: E402

SCHEMA = 1
PKT = timezone(timedelta(hours=5))
DEFAULT_ROOT = "/workspace/jobs"
DEFAULT_STATE = "/var/lib/ops-collector"
DEFAULT_ENV_FILE = "/etc/ops-collector.env"
FORBIDDEN_WRITE_ROOT = "/workspace"
HISTORY_DAYS = 7
SAMPLE_EVERY = 55  # seconds between 1-min history samples
KILLSWITCH_EVERY = 300
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_FILES_LIST = 60
MAX_EVENTS = 1500
RUN_RE = re.compile(r"^(codex|gates|baseline|rebase|retarget|devfix)-", re.I)
ISSUE_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}-\d{1,6}$")
REQUIRED_GATES = ("prisma", "typecheck", "lint", "complete_unit", "host_build", "docker")
SERVICE_PATTERNS = _live.SERVICE_PATTERNS
KILLSWITCH_ARGV = (
    "ip", "netns", "exec", "codex-home", "tailscale",
    "--socket=/run/codex-tailscaled.sock", "status", "--json",
)


def log(msg):
    print(f"[ops-collector] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- helpers

def parse_ts(value):
    """Parse the campaign's timestamp flavours into epoch seconds (naive = PKT)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v <= 0:
            return None
        return v / 1000.0 if v > 1e12 else v
    s = str(value).strip()
    if not s:
        return None
    s = re.sub(r"\s*PKT$", "", s, flags=re.IGNORECASE)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        dt = None
        for fmt in ("%Y%m%d-%H%M%S", "%Y%m%d-%H%M", "%Y%m%dT%H%M%S", "%Y-%m-%d %H:%M"):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=PKT)
    return dt.timestamp()


_ST_WORDS = (
    ("BLOCKED", ("BLOCK", "PRECONDITION", "HARNESS")),
    ("FAIL", ("FAIL", "ERROR", "TIMEOUT", "TIMEDOUT", "ABORT", "CRASH", "BROKEN", "INCOMPLETE", "RED")),
    ("RUNNING", ("RUNNING", "PROGRESS", "STARTED", "VERIFYING", "ACTIVE", "BUSY")),
    ("PASS", ("PASS", "SUCCESS", "SUCCEEDED", "OK", "DONE", "COMPLETE", "COMPLETED", "GREEN", "FIXED", "MERGED")),
    ("SKIP", ("SKIP", "SKIPPED")),
)


def norm_status(value):
    """Map any raw status into PASS/FAIL/RUNNING/BLOCKED/SKIP/PENDING (word based)."""
    if value is None:
        return "PENDING"
    if isinstance(value, bool):
        return "PASS" if value else "FAIL"
    if isinstance(value, int):
        return "PASS" if value == 0 else "FAIL"
    words = [w for w in re.split(r"[^A-Z0-9]+", str(value).upper()) if w]
    for norm, keys in _ST_WORDS:
        for w in words:
            if w in keys or any(w.startswith(k) and len(k) >= 4 for k in keys):
                return norm
    return "PENDING"


def gate_key(name):
    """Canonical gate column for a step / checkpoint name. Unknown names pass through."""
    n = str(name).strip().lower().replace("-", "_").replace(" ", "_")
    n = re.sub(r"_?checkpoint(\.json)?$", "", n)
    if "prisma" in n:
        return "prisma"
    if "typecheck" in n or n in ("tsc", "type_check", "types"):
        return "typecheck"
    if "lint" in n:
        return "lint"
    if "complete_unit" in n or n in ("unit", "unit_tests", "vitest", "tests"):
        return "complete_unit"
    if "host_build" in n or n == "build":
        return "host_build"
    if "docker" in n or "container" in n:
        return "docker"
    if "browser" in n or n in ("qa", "full_qa", "e2e", "playwright"):
        return "qa_browser"
    if "security" in n or n in ("semgrep", "audit"):
        return "security"
    return n or "unknown"


def under(path, root):
    try:
        rp = os.path.realpath(path)
        rr = os.path.realpath(root)
    except OSError:
        return False
    return rp == rr or rp.startswith(rr + os.sep)


def read_json(path, root=None):
    try:
        if root and not under(path, root):
            return None
        if os.path.getsize(path) > MAX_JSON_BYTES:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_text(path, limit=65536):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return ""


def mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


def listdir(path):
    try:
        return sorted(os.listdir(path))
    except OSError:
        return []


def short(sha, n=10):
    return sha[:n] if isinstance(sha, str) and sha else None


def maxts(*vals):
    v = [x for x in vals if isinstance(x, (int, float))]
    return max(v) if v else None


def mints(*vals):
    v = [x for x in vals if isinstance(x, (int, float))]
    return min(v) if v else None


def batch_label(name):
    m = re.match(r"^(.*?)[-_](\d{8})(?:[-_](\d{4,6}))?$", name)
    base, date, hm = (m.group(1), m.group(2), m.group(3)) if m else (name, None, None)
    label = base.replace("-", " ").replace("_", " ").strip()
    label = label[:1].upper() + label[1:]
    if date:
        label += f" · {date[:4]}-{date[4:6]}-{date[6:]}"
        if hm:
            label += f" {hm[:2]}:{hm[2:4]}"
    return label


def name_start_ts(name):
    m = re.search(r"(\d{8})[-_](\d{4})", name)
    return parse_ts(f"{m.group(1)}-{m.group(2)}") if m else None


def file_strings(obj, out, depth=0):
    if depth > 6:
        return
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for k in ("file", "testFile", "path", "name", "filePath"):
            if isinstance(obj.get(k), str):
                out.append(obj[k])
                return
        for v in obj.values():
            file_strings(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            file_strings(v, out, depth + 1)


def norm_file(p):
    p = str(p).strip()
    p = re.sub(r"^.*?/workspace/jobs/[^/]+/[^/]+/(?:[^/]+/)?(?:repo|worktree|src-root)/", "", p)
    p = re.sub(r"^\./", "", p)
    return p


def in_baseline(f, baseline):
    if f in baseline:
        return True
    return any(f.endswith("/" + b) or b.endswith("/" + f) for b in baseline)


# --------------------------------------------------------------------------- steps / runs

def parse_steps(raw):
    """Return list of step dicts from {name: status|{status,...}}."""
    steps = []
    if not isinstance(raw, dict):
        return steps
    for name, val in raw.items():
        if isinstance(val, dict):
            st = {
                "name": name,
                "gate": gate_key(name),
                "raw": str(val.get("status")) if val.get("status") is not None else None,
                "status": norm_status(val.get("status") if "status" in val else val.get("exitCode")),
                "start": parse_ts(val.get("startPKT") or val.get("start") or val.get("startedAt")),
                "end": parse_ts(val.get("endPKT") or val.get("end") or val.get("endedAt")),
                "exit": val.get("exitCode") if isinstance(val.get("exitCode"), int) else None,
            }
            for src, dst in (("numPassedTests", "passed"), ("numFailedTests", "failed")):
                if isinstance(val.get(src), int):
                    st[dst] = val[src]
            ff = []
            file_strings(val.get("failedFiles") or [], ff)
            if ff:
                st["failedFiles"] = [norm_file(f) for f in ff][:200]
        else:
            st = {"name": name, "gate": gate_key(name), "raw": str(val), "status": norm_status(val)}
        steps.append(st)
    return steps


def run_record(run_name, kind, data, ledger_job=None, sub_files=None):
    """Build a run record for one task from a checkpoint (and/or ledger job)."""
    data = data if isinstance(data, dict) else {}
    job = ledger_job if isinstance(ledger_job, dict) else {}
    steps = parse_steps(data.get("steps")) or parse_steps(job.get("steps"))
    failed_files = []
    file_strings(data.get("failedFiles") or job.get("failedFiles") or [], failed_files)
    raw_status = data.get("status") or job.get("status")
    rec = {
        "run": run_name,
        "kind": kind,
        "status": str(raw_status) if raw_status is not None else None,
        "norm": norm_status(raw_status),
        "start": parse_ts(data.get("startPKT") or data.get("codexStartPKT")),
        "end": parse_ts(data.get("endPKT")),
        "codexStart": parse_ts(data.get("codexStartPKT")),
        "codexEnd": parse_ts(data.get("codexEndPKT")),
        "sourceSHA": data.get("sourceSHA") or job.get("sourceSHA"),
        "newSourceSHA": data.get("newSourceSHA") or job.get("newSourceSHA"),
        "model": job.get("model") or data.get("model"),
        "effort": job.get("reasoningEffort") or data.get("reasoningEffort"),
        "failedGate": job.get("failedGate") or data.get("failedGate"),
        "codexExitCode": job.get("codexExitCode", data.get("codexExitCode")),
        "fullQA": data.get("fullQA"),
        "steps": steps,
        "failedFiles": [norm_file(f) for f in failed_files][:200],
        "subGates": [],
    }
    changed = job.get("changedFiles", data.get("changedFiles"))
    if isinstance(changed, list):
        rec["changedFiles"] = len(changed)
        rec["changedPaths"] = [norm_file(c) for c in changed if isinstance(c, str)][:100]
    if data.get("error"):
        rec["error"] = str(data["error"])[:500]
    for fname, sub in sorted((sub_files or {}).items()):
        if not isinstance(sub, dict):
            continue
        prefix = fname[: -len("-checkpoint.json")]
        rec["subGates"].append({
            "name": prefix,
            "gate": gate_key(prefix),
            "status": norm_status(sub.get("status")),
            "raw": str(sub.get("status")) if sub.get("status") is not None else None,
            "start": parse_ts(sub.get("startPKT")),
            "end": parse_ts(sub.get("endPKT")),
            "steps": parse_steps(sub.get("steps")),
        })
    times = [rec["start"], rec["end"], rec["codexStart"], rec["codexEnd"]]
    for s in steps:
        times += [s.get("start"), s.get("end")]
    for g in rec["subGates"]:
        times += [g["start"], g["end"]]
    rec["start"] = rec["start"] or mints(*times)
    rec["last"] = maxts(*times)
    return rec


def is_running_job(status):
    u = str(status or "").upper()
    return norm_status(status) == "RUNNING" or "CODEX_RUNNING" in u or "VERIFYING" in u


# --------------------------------------------------------------------------- tasks

def build_task(issue, runs, baseline_failed):
    runs = sorted(runs, key=lambda r: (r.get("start") or r.get("last") or 0, r.get("kind") != "codex"))
    gates = {}

    def put(key, status, rec, step=None):
        entry = {"status": status, "run": rec["run"], "sha": short(rec.get("newSourceSHA") or rec.get("sourceSHA"))}
        if step is not None:
            if step.get("start") and step.get("end"):
                entry["dur"] = round(step["end"] - step["start"])
            for k in ("passed", "failed", "failedFiles", "raw", "exit"):
                if step.get(k) is not None:
                    entry[k] = step[k]
        gates[key] = entry

    final_sha = None
    fixed = False
    for rec in runs:
        if rec["kind"] == "codex":
            ok_exit = rec.get("codexExitCode") == 0
            if ok_exit and (rec.get("newSourceSHA") or rec.get("changedFiles")):
                fixed = True
            if rec.get("newSourceSHA"):
                final_sha = rec["newSourceSHA"]
        elif rec.get("sourceSHA") and rec["kind"] != "baseline":
            final_sha = rec["sourceSHA"]
        for st in rec["steps"]:
            put(st["gate"], st["status"], rec, st)
        for sub in rec["subGates"]:
            put(sub["gate"], sub["status"], rec, sub)
            for st in sub["steps"]:
                if st["gate"] in REQUIRED_GATES or st["gate"] in ("qa_browser", "security"):
                    put(st["gate"], st["status"], rec, st)
        if rec.get("fullQA") is True:
            put("qa_browser", "PASS", rec)
        if rec.get("failedFiles") and "complete_unit" in gates and not gates["complete_unit"].get("failedFiles"):
            gates["complete_unit"]["failedFiles"] = rec["failedFiles"]
        if final_sha is None and rec.get("sourceSHA"):
            final_sha = rec["sourceSHA"]

    # differential vs baseline
    unit = gates.get("complete_unit")
    diff = {"status": "PENDING", "newFailures": [], "baselineFailures": 0}
    if unit:
        if unit["status"] == "PASS":
            diff["status"] = "PASS"
        elif unit["status"] == "FAIL":
            files = [norm_file(f) for f in unit.get("failedFiles") or []]
            if files and baseline_failed is not None:
                new = [f for f in files if not in_baseline(f, baseline_failed)]
                diff["newFailures"] = new[:MAX_FILES_LIST]
                diff["baselineFailures"] = len(files) - len(new)
                diff["status"] = "PASS" if not new else "FAIL"
            elif files:
                diff["status"] = "BLOCKED"
                diff["note"] = "no baseline available"
                diff["newFailures"] = files[:MAX_FILES_LIST]
            else:
                diff["status"] = "FAIL"
        else:
            diff["status"] = unit["status"]
        diff["sha"] = unit.get("sha")
    gates["differential"] = diff

    def gate_ok(key):
        g = gates.get(key)
        if key == "complete_unit":
            return (g and g["status"] == "PASS") or diff["status"] == "PASS"
        return bool(g) and g["status"] == "PASS"

    final_short = short(final_sha)
    gated = all(gate_ok(k) for k in REQUIRED_GATES)
    stale = [k for k in REQUIRED_GATES if gates.get(k) and gates[k].get("sha") and final_short and gates[k]["sha"] != final_short]
    if gated and not stale:
        gates["final_sha"] = {"status": "PASS", "sha": final_short}
    else:
        gates["final_sha"] = {"status": "PENDING", "sha": final_short}
        if stale:
            gates["final_sha"]["note"] = "gates ran on an older SHA: " + ", ".join(stale)
        gated = False
    fixed = fixed or gated

    last = runs[-1] if runs else {}
    latest_codex = next((r for r in reversed(runs) if r["kind"] == "codex"), None)
    running = any(is_running_job(r.get("status")) for r in runs[-2:]) or any(
        g.get("status") == "RUNNING" for g in gates.values())
    if running:
        phase = "running"
    elif gated:
        phase = "gated"
    elif last.get("norm") == "BLOCKED":
        phase = "blocked"
    elif fixed:
        phase = "fixed"
    elif last.get("norm") == "FAIL" or (latest_codex and latest_codex.get("codexExitCode") not in (None, 0)):
        phase = "failed"
    else:
        phase = "pending"

    current_step = None
    for rec in reversed(runs):
        cur = next((s for s in rec["steps"] if s["status"] == "RUNNING"), None)
        if cur:
            current_step = cur["name"]
            break

    return {
        "issue": issue,
        "phase": phase,
        "status": last.get("status"),
        "model": (latest_codex or {}).get("model"),
        "effort": (latest_codex or {}).get("effort"),
        "failedGate": (latest_codex or {}).get("failedGate"),
        "sourceSHA": short((runs[0] if runs else {}).get("sourceSHA")),
        "finalSHA": final_short,
        "changedFiles": (latest_codex or {}).get("changedFiles"),
        "changedPaths": (latest_codex or {}).get("changedPaths") or [],
        "fixed": fixed,
        "gated": gated,
        "running": running,
        "currentStep": current_step,
        "gates": gates,
        "runs": [compact_run(r) for r in runs],
        "start": mints(*[r.get("start") for r in runs]),
        "last": maxts(*[r.get("last") for r in runs]),
    }


def compact_run(r):
    out = {k: r.get(k) for k in ("run", "kind", "status", "norm", "start", "last", "end", "codexStart",
                                 "codexEnd", "model", "effort", "failedGate", "codexExitCode", "error",
                                 "changedFiles", "changedPaths", "stale") if r.get(k) is not None}
    out["sourceSHA"] = short(r.get("sourceSHA"))
    out["newSourceSHA"] = short(r.get("newSourceSHA"))
    out["steps"] = [{k: v for k, v in s.items() if k != "failedFiles"} for s in r["steps"]]
    out["subGates"] = [{k: v for k, v in g.items() if k != "steps"} for g in r["subGates"]]
    out["failedFiles"] = r.get("failedFiles", [])[:MAX_FILES_LIST]
    return out


# --------------------------------------------------------------------------- discovery

def summarize_file(path, root):
    data = read_json(path, root)
    info = {"file": os.path.basename(path), "mtime": mtime(path)}
    if isinstance(data, dict):
        at = data.get("atPKT") or data.get("generatedPKT") or data.get("updatedPKT") or data.get("createdPKT")
        info["at"] = parse_ts(at)
        for k, v in list(data.items())[:40]:
            if isinstance(v, (int, float)) and not isinstance(v, bool) and len(info) < 14:
                info[k] = v
        jobs = data.get("jobs") if isinstance(data.get("jobs"), list) else data.get("issues")
        if isinstance(jobs, list):
            counts = {}
            for j in jobs:
                s = norm_status(j.get("status")) if isinstance(j, dict) else "PENDING"
                counts[s] = counts.get(s, 0) + 1
            info["counts"] = counts
            info["entries"] = len(jobs)
    elif isinstance(data, list):
        info["entries"] = len(data)
    return info


def scan_issue_dir(path, root):
    main = read_json(os.path.join(path, "checkpoint.json"), root)
    subs = {}
    for f in listdir(path):
        if f.endswith("-checkpoint.json"):
            subs[f] = read_json(os.path.join(path, f), root)
    return main, subs


def collect_batch(root, name, now, live_window):
    broot = os.path.join(root, name)
    batch = {
        "id": name, "name": name, "label": batch_label(name),
        "runs": [], "attemptDirs": 0, "attemptJobs": 0, "ledgers": [], "files": [], "policies": [],
        "baseline": None, "baselineJobs": 0, "codexJobs": [], "events": [],
    }
    per_issue = {}
    baseline_failed = None
    baselines = []
    current_sources = None
    current_run_name = None
    ledgers_live = []
    entries = listdir(broot)
    for entry in entries:
        p = os.path.join(broot, entry)
        if os.path.isfile(p):
            if re.match(r"^MERGE_GATE_POLICY_.*\.md$", entry):
                batch["policies"].append(entry)
            elif "ledger" in entry and entry.endswith(".json"):
                batch["ledgers"].append(summarize_file(p, root))
            elif re.match(r"^campaign\d*-handoff-.*\.json$", entry) or entry == "admission.json":
                batch["files"].append(summarize_file(p, root))
            continue
        if not os.path.isdir(p):
            continue
        if ISSUE_RE.match(entry):
            # legacy layout: <root>/<ISSUE>/ directly inside the batch
            main, subs = scan_issue_dir(p, root)
            if main is None and not subs:
                continue
            rec = run_record("review", "review", main, None, subs)
            if entry.startswith("BASE-"):
                batch["baselineJobs"] += 1
            else:
                per_issue.setdefault(entry, []).append(rec)
            continue
        if not RUN_RE.match(entry):
            continue
        kind = entry.split("-", 1)[0].lower()
        # Current-run overlay: rebase-1906-1110/status.json + reclassify.
        status_path = os.path.join(p, "status.json")
        if (os.path.isfile(status_path) and _cr.CURRENT_STATUS_DIR_RE.search(entry)
                and (current_run_name is None or "1906-1110" in entry)):
            current_run_name = entry
            current_sources = _cr.load_current_sources(
                p, lambda path: read_json(path, root), mtime, os.path.isfile, os.path.join)
        if "-attempt" in entry:
            batch["attemptDirs"] += 1
            batch["attemptJobs"] += sum(1 for d in listdir(p) if ISSUE_RE.match(d))
            continue
        run = {"name": entry, "kind": kind, "tasks": 0, "counts": {}, "active": 0, "cap": None,
               "start": None, "last": mtime(p)}
        ledger_jobs = {}
        for f in listdir(p):
            fp = os.path.join(p, f)
            if "ledger" in f and f.endswith(".json") and os.path.isfile(fp):
                data = read_json(fp, root)
                if not isinstance(data, dict):
                    continue
                at = parse_ts(data.get("atPKT"))
                lm = mtime(fp)
                info = summarize_file(fp, root)
                info["run"] = entry
                batch["ledgers"].append(info)
                live = live_window <= 0 or (lm is not None and now - lm <= live_window)
                if isinstance(data.get("maxConcurrent"), int):
                    run["cap"] = data["maxConcurrent"]
                if isinstance(data.get("activeCodexOrVerify"), int) and live:
                    run["active"] = data["activeCodexOrVerify"]
                run["start"] = mints(run["start"], at)
                run["last"] = maxts(run["last"], at, lm)
                for job in data.get("jobs") or []:
                    if isinstance(job, dict) and isinstance(job.get("issue"), str):
                        ledger_jobs[job["issue"]] = job
                ledgers_live.append(live)
                run["live"] = live
        terminal = read_json(os.path.join(p, "terminal.json"), root)
        terminal_map = {}
        if isinstance(terminal, list):
            for t in terminal:
                if isinstance(t, dict) and isinstance(t.get("issue"), str):
                    terminal_map[t["issue"]] = t
        elif isinstance(terminal, dict):
            for t in terminal.get("jobs") or terminal.get("issues") or []:
                if isinstance(t, dict) and isinstance(t.get("issue"), str):
                    terminal_map[t["issue"]] = t
        if kind == "baseline":
            cp = read_json(os.path.join(p, "checkpoint.json"), root) or {}
            bft = read_json(os.path.join(p, "baseline-failed-tests.json"), root)
            files = []
            file_strings(bft if bft is not None else cp.get("failedFiles", []), files)
            files = sorted({norm_file(f) for f in files})
            baseline_failed = set(files)
            binfo = {
                "run": entry,
                "baseSHA": short(cp.get("baseSHA"), 12) or short(cp.get("sha"), 12),
                "sha": short(cp.get("baseSHA") or cp.get("sha"), 40),
                "status": cp.get("status"),
                "norm": norm_status(cp.get("status")),
                "numFailedTests": cp.get("numFailedTests"),
                "numPassedTests": cp.get("numPassedTests"),
                "numPendingTests": cp.get("numPendingTests"),
                "numTotalTests": cp.get("numTotalTests"),
                "failedFileCount": cp.get("failedFileCount", len(files)),
                "failedFiles": files[:MAX_FILES_LIST],
                "steps": parse_steps(cp.get("steps")),
                "start": parse_ts(cp.get("startPKT")),
                "end": parse_ts(cp.get("endPKT")),
            }
            baselines.append(binfo)
            # Prefer a complete baseline on develop 1906b530 (baseline-1110) over an incomplete hotel-dynamic one.
            chosen = _cr.pick_current_baseline(baselines)
            batch["baseline"] = chosen
            batch["baselines"] = baselines
            run["start"] = mints(run["start"], binfo["start"])
            run["last"] = maxts(run["last"], binfo["end"])
            run["status"] = cp.get("status")
            # Use this baseline's failed files when it is the chosen current baseline.
            if chosen is binfo or (chosen and chosen.get("run") == entry):
                baseline_failed = set(files)
        issues = set(ledger_jobs) | set(terminal_map)
        issues |= {d for d in listdir(p) if ISSUE_RE.match(d) and os.path.isdir(os.path.join(p, d))}
        for issue in sorted(issues):
            main, subs = scan_issue_dir(os.path.join(p, issue), root)
            if main is None and issue in terminal_map:
                main = terminal_map[issue]
            rec = run_record(entry, kind, main, ledger_jobs.get(issue), subs)
            if not run.get("live", True) and is_running_job(rec.get("status")):
                rec["norm"] = "PENDING"
                rec["stale"] = True
            run["counts"][rec["norm"]] = run["counts"].get(rec["norm"], 0) + 1
            run["start"] = mints(run["start"], rec.get("start"))
            run["last"] = maxts(run["last"], rec.get("last"))
            if issue.startswith("BASE-"):
                batch["baselineJobs"] += 1
                continue
            run["tasks"] += 1
            per_issue.setdefault(issue, []).append(rec)
            if kind == "codex":
                batch["codexJobs"].append({
                    "key": f"{name}/{entry}/{issue}",
                    "issue": issue, "run": entry, "status": rec.get("status"),
                    "model": rec.get("model"), "effort": rec.get("effort"),
                    "start": rec.get("codexStart") or rec.get("start"),
                    "running": run.get("live", True) and is_running_job(rec.get("status")),
                    "step": next((s["name"] for s in rec["steps"] if s["status"] == "RUNNING"), None),
                })
        if run.get("live") is False:
            run["active"] = 0
        elif run["active"] == 0:
            run["active"] = sum(1 for j in batch["codexJobs"] if j["run"] == entry and j["running"])
        cls = _cr.classify_run(entry, has_current_rebase=bool(current_run_name),
                               invalid_base=(current_sources or {}).get("status", {}).get("invalidOldBase") if current_sources else None)
        # Also treat an INVALID_ONTO_0c6245c marker in the run dir as superseded.
        invalid_marker = next((f for f in listdir(p) if f.startswith("INVALID_ONTO_0c6245c")), None)
        if invalid_marker:
            cls = _cr.classify_run(entry, has_current_rebase=True, invalid_base="0c6245c")
            run["invalidMarker"] = invalid_marker
        run["current"] = cls["current"]
        run["historical"] = cls["historical"]
        run["superseded"] = cls["superseded"]
        if cls.get("supersededReason"):
            run["supersededReason"] = cls["supersededReason"]
        batch["runs"].append(run)
    batch["_baselineFailed"] = baseline_failed
    batch["_perIssue"] = per_issue
    batch["_currentSources"] = current_sources
    batch["_currentRunName"] = current_run_name
    if baselines and not batch.get("baselines"):
        batch["baselines"] = baselines
    return batch


def collect_batches(root, now=None, live_window=1800):
    """Discover every job root under `root` as a batch, with tasks and runs."""
    now = now or time.time()
    batches = []
    for name in listdir(root):
        p = os.path.join(root, name)
        if not os.path.isdir(p) or name.startswith("."):
            continue
        batches.append(collect_batch(root, name, now, live_window))
    # baseline fallback: the most recent baseline anywhere
    latest_baseline = None
    for b in batches:
        if b["_baselineFailed"] is not None:
            bt = (b["baseline"] or {}).get("end") or (b["baseline"] or {}).get("start") or 0
            if latest_baseline is None or bt >= latest_baseline[0]:
                latest_baseline = (bt, b["_baselineFailed"])
    for b in batches:
        base = b["_baselineFailed"] if b["_baselineFailed"] is not None else (
            latest_baseline[1] if latest_baseline else None)
        current_sources = b.pop("_currentSources", None)
        current_run_name = b.pop("_currentRunName", None)
        # When a current rebase status exists, don't let superseded runs (codex-1110, gates-1110
        # on 0c6245c) drive gates / phase / the `fixed` flag.
        def _runs_for(issue, runs):
            if not current_sources:
                return runs
            current, rest = [], []
            for r in runs:
                if _cr.classify_run(r.get("run") or "", has_current_rebase=True).get("current") or r.get("kind") == "baseline":
                    current.append(r)
                else:
                    rest.append(r)
            # build_task still needs at least the current/baseline runs; overlay replaces verdicts.
            return current or runs

        tasks = [build_task(issue, _runs_for(issue, runs), base)
                 for issue, runs in sorted(b.pop("_perIssue").items())]
        b.pop("_baselineFailed")
        b["tasks"] = tasks
        if current_sources and current_sources.get("status"):
            run_dir = os.path.join(root, b["name"], current_run_name)

            def _load_attempts(issue):
                path = os.path.join(run_dir, issue, "attempts.json")
                if os.path.isfile(path):
                    return _cr.load_attempts(path, lambda p: read_json(p, root))
                return None

            _cr.apply_current_overlay(b, current_run_name, current_sources, _load_attempts)
            tasks = b["tasks"]
        # Prefer a complete baseline-1110 even if overlay didn't run.
        if b.get("baselines"):
            chosen = _cr.pick_current_baseline(b["baselines"])
            b["baselines"] = [_cr.annotate_baseline(x, preferred=x is chosen or (
                chosen and x.get("run") == chosen.get("run"))) for x in b["baselines"]]
            current_b = next((x for x in b["baselines"] if x.get("current")), None)
            if current_b:
                b["baseline"] = current_b
        elif b.get("baseline"):
            b["baseline"] = _cr.annotate_baseline(b["baseline"], preferred=True)
        b["archived"] = _cr.is_archived_batch(b)
        b["counts"] = _cr.counts_from_verdicts(tasks)
        times = [name_start_ts(b["name"])] + [r.get("start") for r in b["runs"]] + [t.get("start") for t in tasks]
        b["start"] = mints(*times)
        b["last"] = maxts(*([r.get("last") for r in b["runs"]] + [t.get("last") for t in tasks] +
                            [l.get("mtime") for l in b["ledgers"]] + [b.get("dataAsOf")]))
        # Active jobs: only current (non-superseded) runs.
        b["active"] = sum(r.get("active") or 0 for r in b["runs"] if not r.get("superseded"))
        caps = [r["cap"] for r in b["runs"] if r.get("cap") and not r.get("superseded")]
        b["cap"] = max(caps) if caps else None
        b["events"] = derive_events(b)
    batches.sort(key=lambda b: b.get("last") or 0, reverse=True)
    return batches


def derive_events(batch):
    ev = []
    bid = batch["id"]
    for t in batch["tasks"]:
        for r in t["runs"]:
            run = r["run"]
            if r.get("codexStart"):
                ev.append({"ts": r["codexStart"], "batch": bid, "issue": t["issue"], "kind": "codex",
                           "run": run, "text": f"Codex started ({r.get('model') or 'model ?'} {r.get('effort') or ''})".strip()})
            if r.get("codexEnd"):
                ev.append({"ts": r["codexEnd"], "batch": bid, "issue": t["issue"], "kind": "codex",
                           "run": run, "level": "ok" if r.get("codexExitCode") == 0 else "bad",
                           "text": f"Codex finished, exit {r.get('codexExitCode')}"})
            if r.get("start") and r["kind"] != "codex":
                ev.append({"ts": r["start"], "batch": bid, "issue": t["issue"], "kind": r["kind"],
                           "run": run, "text": f"{run} started"})
            if r.get("end"):
                ev.append({"ts": r["end"], "batch": bid, "issue": t["issue"], "kind": r["kind"],
                           "level": "bad" if r.get("norm") in ("FAIL", "BLOCKED") else "ok",
                           "run": run, "text": f"{run} ended: {r.get('status')}"})
            for s in r.get("steps", []):
                if s.get("end") and s["status"] in ("PASS", "FAIL", "BLOCKED"):
                    ev.append({"ts": s["end"], "batch": bid, "issue": t["issue"], "kind": "step",
                               "level": "ok" if s["status"] == "PASS" else "bad",
                               "run": run, "gate": s.get("gate"), "text": f"{s['name']} {s['status']} ({run})"})
    b = batch.get("baseline")
    if b and b.get("end"):
        ev.append({"ts": b["end"], "batch": bid, "kind": "baseline", "run": b.get("run"),
                   "level": "ok", "text": f"Baseline recorded: {b.get('status')}"})
    ev.sort(key=lambda e: e["ts"], reverse=True)
    return [_cr.tag_event(e) for e in ev[:MAX_EVENTS] if e.get("ts")]


# --------------------------------------------------------------------------- usage stop

USAGE_RE = re.compile(r"usage[^0-9%]{0,24}(\d{1,3}(?:\.\d+)?)\s*%", re.IGNORECASE)


def collect_usage(root):
    dirs = [root, os.path.dirname(os.path.abspath(root))]
    dirs += [os.path.join(root, d) for d in listdir(root) if os.path.isdir(os.path.join(root, d))]
    stops, resumes = [], []
    for d in dirs:
        for f in listdir(d):
            if not f.startswith("OWNER_USAGE_CUTOFF_STOP"):
                continue
            p = os.path.join(d, f)
            if not os.path.isfile(p):
                continue
            (resumes if ".resume-" in f and f.endswith(".json") else stops).append(p)
    out = {"stopActive": False, "weeklyPct": None, "stopSince": None, "clearedAt": None, "note": None}
    pct_src = []
    for p in resumes:
        data = read_json(p)
        if isinstance(data, dict):
            cleared = parse_ts(data.get("clearedPKT")) or mtime(p)
            if out["clearedAt"] is None or (cleared or 0) > out["clearedAt"]:
                out["clearedAt"] = cleared
            strings = []
            file_strings(list(data.values()), strings)
            for s in strings:
                m = USAGE_RE.search(s)
                if m:
                    pct_src.append((cleared or 0, float(m.group(1)), s[:160]))
    for p in stops:
        mt = mtime(p) or 0
        out["stopSince"] = maxts(out["stopSince"], mt)
        m = USAGE_RE.search(read_text(p))
        if m:
            pct_src.append((mt, float(m.group(1)), m.group(0)))
    if out["stopSince"] and (out["clearedAt"] is None or out["stopSince"] > out["clearedAt"]):
        out["stopActive"] = True
    if pct_src:
        pct_src.sort()
        out["weeklyPct"] = pct_src[-1][1]
        out["note"] = pct_src[-1][2]
    return out


# --------------------------------------------------------------------------- host

def read_cpu():
    try:
        with open("/proc/stat") as fh:
            parts = fh.readline().split()[1:]
        vals = [int(x) for x in parts]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle
    except (OSError, ValueError, IndexError):
        return None


def read_psi():
    out = {}
    for res in ("cpu", "memory", "io"):
        txt = read_text(f"/proc/pressure/{res}")
        if not txt:
            continue
        entry = {}
        for line in txt.splitlines():
            bits = line.split()
            if not bits:
                continue
            kv = dict(b.split("=", 1) for b in bits[1:] if "=" in b)
            try:
                entry[bits[0]] = {"avg10": float(kv.get("avg10", 0)), "avg60": float(kv.get("avg60", 0)),
                                  "avg300": float(kv.get("avg300", 0))}
            except ValueError:
                pass
        out[res] = entry
    return out


def collect_host(state, disks):
    host = {"cores": os.cpu_count() or 1}
    cur = read_cpu()
    prev = state.get("cpuPrev")
    if cur and (not prev or time.time() - prev[2] > 120):
        time.sleep(0.5)
        prev = (*cur, time.time())
        cur = read_cpu()
    if cur and prev:
        dt, di = cur[0] - prev[0], cur[1] - prev[1]
        host["cpuPct"] = round(100.0 * (1 - di / dt), 1) if dt > 0 else 0.0
    if cur:
        state["cpuPrev"] = (cur[0], cur[1], time.time())
    try:
        host["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        host["load"] = None
    mem = {}
    for line in read_text("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        if k in ("MemTotal", "MemAvailable"):
            mem[k] = int(v.split()[0]) * 1024
    if "MemTotal" in mem:
        used = mem["MemTotal"] - mem.get("MemAvailable", 0)
        host["mem"] = {"usedBytes": used, "totalBytes": mem["MemTotal"],
                       "pct": round(100.0 * used / mem["MemTotal"], 1)}
    host["psi"] = read_psi()
    try:
        host["uptimeSec"] = int(float(read_text("/proc/uptime").split()[0]))
    except (IndexError, ValueError):
        host["uptimeSec"] = None
    host["disks"] = {}
    for d in disks:
        try:
            st = os.statvfs(d)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        avail = st.f_bavail * st.f_frsize
        used = total - st.f_bfree * st.f_frsize
        host["disks"][d] = {"usedBytes": used, "totalBytes": total, "freeBytes": avail,
                            "pct": round(100.0 * used / (used + avail), 1) if used + avail else 0.0}
    return host


def run_ro(argv, timeout=10):
    """Run one of a tiny whitelist of read-only commands. Refuses anything else."""
    argv = list(argv)
    ok = False
    if argv[:1] == ["systemctl"] and len(argv) > 1 and argv[1] in ("list-units", "show"):
        ok = all(a not in ("start", "stop", "restart", "kill", "enable", "disable", "mask") for a in argv[2:])
    elif tuple(argv) == KILLSWITCH_ARGV:
        ok = True
    if not ok:
        raise PermissionError("command not in read-only whitelist: " + " ".join(argv[:3]))
    res = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         timeout=timeout, check=False)
    return res.returncode, res.stdout



def collect_services():
    return _live.collect_services(run_ro, patterns=SERVICE_PATTERNS)


def collect_codex_procs(proc_root="/proc"):
    return _live.collect_codex_procs(proc_root)


def collect_gate_procs(proc_root="/proc"):
    return _live.collect_gate_procs(proc_root)


def collect_killswitch(state, now):
    cached = state.get("killSwitch")
    if cached and now - (cached.get("checkedAt") or 0) < KILLSWITCH_EVERY:
        return cached
    result = {"pass": None, "checkedAt": now, "detail": "check unavailable"}
    try:
        rc, out = run_ro(KILLSWITCH_ARGV, timeout=15)
        data = json.loads(out) if out.strip() else {}
        backend = data.get("BackendState")
        exit_online = bool((data.get("ExitNodeStatus") or {}).get("Online"))
        result["pass"] = backend == "Running" and exit_online
        result["detail"] = ("backend running" if backend == "Running" else "backend not running") + \
                           (", exit node online" if exit_online else ", exit node offline")
    except FileNotFoundError:
        result["detail"] = "ip/tailscale not installed"
    except (OSError, subprocess.SubprocessError, ValueError, PermissionError) as exc:
        result["pass"] = False
        result["detail"] = f"check failed ({type(exc).__name__})"
    state["killSwitch"] = result
    return result


# --------------------------------------------------------------------------- state & history

def safe_state_dir(path):
    rp = os.path.realpath(path)
    if rp == FORBIDDEN_WRITE_ROOT or rp.startswith(FORBIDDEN_WRITE_ROOT + "/"):
        raise SystemExit("refusing to keep state under /workspace")
    try:
        os.makedirs(rp, mode=0o750, exist_ok=True)
        probe = tempfile.NamedTemporaryFile(dir=rp, delete=True)
        probe.close()
        return rp
    except OSError:
        fallback = os.path.join(os.path.expanduser("~"), ".cache", "ops-collector")
        log(f"state dir {path} not writable, using {fallback}")
        os.makedirs(fallback, exist_ok=True)
        return fallback


def load_state(sdir, name):
    data = read_json(os.path.join(sdir, name))
    return data if isinstance(data, dict) else {}


def save_state(sdir, name, data):
    fd, tmp = tempfile.mkstemp(dir=sdir, prefix=f".{name}.")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
        os.replace(tmp, os.path.join(sdir, name))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def update_history(hist, now, host):
    samples = hist.setdefault("samples", [])
    disks = host.get("disks") or {}
    sample = [round(now), host.get("cpuPct"), (host.get("load") or [None])[0],
              (host.get("mem") or {}).get("pct"), (disks.get("/workspace") or {}).get("pct"),
              (disks.get("/scratch") or {}).get("pct")]
    if not samples or now - samples[-1][0] >= SAMPLE_EVERY:
        samples.append(sample)
    cutoff = now - HISTORY_DAYS * 86400
    hist["samples"] = [s for s in samples if s[0] >= cutoff]
    recent = [s for s in hist["samples"] if s[0] >= now - 3600]
    hourly = {}
    for s in hist["samples"]:
        hourly.setdefault(int(s[0] // 3600), []).append(s)
    agg = []
    for hour in sorted(hourly):
        rows = hourly[hour]
        row = [hour * 3600]
        for i in range(1, 6):
            vals = [r[i] for r in rows if isinstance(r[i], (int, float))]
            row.append(round(sum(vals) / len(vals), 2) if vals else None)
        agg.append(row)
    return {"fields": ["ts", "cpuPct", "load1", "memPct", "workspacePct", "scratchPct"],
            "recent": recent, "hourly": agg}


def load_high_5m(hist, cores, now):
    window = [s for s in hist.get("samples", []) if s[0] >= now - 300]
    if len(window) < 4:
        return False
    return all(isinstance(s[2], (int, float)) and s[2] > 0.9 * cores for s in window)


# --------------------------------------------------------------------------- main collect

def collect(root, state_dir=None, live_window=1800, disks=("/workspace", "/scratch"), now=None, host_metrics=True):
    now = now or time.time()
    sdir = safe_state_dir(state_dir) if state_dir else None
    state = load_state(sdir, "state.json") if sdir else {}
    hist = load_state(sdir, "history.json") if sdir else {}

    batches = collect_batches(root, now, live_window)
    payload = {"schema": SCHEMA, "collector": "worker", "collectedAt": now, "batches": batches}

    # all-time counters
    seen = set(state.get("seenCodexJobs") or [])
    tasks_seen = set(state.get("seenTasks") or [])
    active = []
    by_model = {}
    cap = None
    attempt_jobs = 0
    for b in batches:
        attempt_jobs += b.get("attemptJobs", 0)
        if b.get("cap"):
            cap = max(cap or 0, b["cap"])
        for j in b.pop("codexJobs"):
            seen.add(j["key"])
            if j["running"]:
                active.append({k: v for k, v in j.items() if k not in ("key", "running")} | {"batch": b["id"]})
                by_model[j.get("model") or "unknown"] = by_model.get(j.get("model") or "unknown", 0) + 1
        for t in b["tasks"]:
            tasks_seen.add(t["issue"])
    ledger_active = sum(b.get("active") or 0 for b in batches)
    payload["codex"] = {"active": sorted(active, key=lambda j: j.get("start") or 0),
                        "activeCount": max(ledger_active, len(active)), "cap": cap or 50, "byModel": by_model}
    state["seenCodexJobs"] = sorted(seen)
    state["seenTasks"] = sorted(tasks_seen)
    state["maxAttemptJobs"] = max(state.get("maxAttemptJobs", 0), attempt_jobs)
    state.setdefault("firstSeen", now)
    payload["allTime"] = {"codexJobsSeen": len(seen) + state["maxAttemptJobs"], "tasksSeen": len(tasks_seen),
                          "firstSeen": state["firstSeen"], "batches": len(batches)}

    # state-change events
    prev_phase = state.get("phases") or {}
    new_phase = {}
    state_events = state.get("stateEvents") or []
    for b in batches:
        for t in b["tasks"]:
            key = f"{b['id']}/{t['issue']}"
            new_phase[key] = t["phase"]
            old = prev_phase.get(key)
            if old and old != t["phase"]:
                state_events.append({"ts": now, "batch": b["id"], "issue": t["issue"], "kind": "state",
                                     "level": "bad" if t["phase"] in ("failed", "blocked") else "ok",
                                     "text": f"{old} → {t['phase']}"})
        if prev_phase and not any(k.startswith(b["id"] + "/") for k in prev_phase) and b["tasks"]:
            state_events.append({"ts": now, "batch": b["id"], "kind": "batch", "text": f"New batch discovered: {b['label']}"})
    state["phases"] = new_phase
    state["stateEvents"] = state_events[-300:]
    events = list(state["stateEvents"])
    for e in events:
        # State-change events are about the live task phase; treat as current unless the batch is archived.
        e.setdefault("current", True)
    for b in batches:
        evs = b.pop("events") or []
        if b.get("archived"):
            for e in evs:
                e["archived"] = True
                e["current"] = False
        events.extend(evs)
    events = [e for e in events if isinstance(e, dict) and e.get("ts")]
    events.sort(key=lambda e: e["ts"], reverse=True)
    current_events = [e for e in events if _cr.is_current_event(e)]
    payload["events"] = current_events[:MAX_EVENTS]
    payload["archivedEvents"] = [e for e in events if not _cr.is_current_event(e)][:200]

    payload["usage"] = collect_usage(root)
    # Current-run rollup used by the dashboard KPIs (never the all-time 161 Codex jobs).
    current_batches = [b for b in batches if not b.get("archived")]
    data_as_of = max(filter(None, [b.get("dataAsOf") for b in current_batches] + [now]), default=now)
    payload["dataAsOf"] = max(filter(None, [b.get("dataAsOf") for b in current_batches]), default=now)
    payload["current"] = {
        "run": next((b.get("currentRun") for b in current_batches if b.get("currentRun")), None),
        "statusFile": next((b.get("currentSource") for b in current_batches if b.get("currentSource")), None),
        "reclassifyFile": next((b.get("reclassifySource") for b in current_batches if b.get("reclassifySource")), None),
        "dataAsOf": payload["dataAsOf"],
        "codexJobs": sum(b.get("currentCodexJobs") or 0 for b in current_batches),
        "counts": {
            k: sum((b.get("counts") or {}).get(k) or 0 for b in current_batches)
            for k in ("total", "fixed", "failed", "running", "queued", "pendingQa", "rejected",
                      "gated", "merged", "blocked")
        },
        "baseline": next((b.get("baseline") for b in current_batches if b.get("baseline")), None),
    }
    if host_metrics:
        host = collect_host(state, disks)
        payload["history"] = update_history(hist, now, host)
        host["loadHigh5m"] = load_high_5m(hist, host["cores"], now)
        payload["system"] = host
        payload["services"] = collect_services()
        payload["codexProcs"] = collect_codex_procs()
        payload["gateProcs"] = collect_gate_procs()
        payload["codex"] = _live.merge_live_codex(payload.get("codex"), payload["codexProcs"])
        payload["killSwitch"] = collect_killswitch(state, now)
        def _read_stop(path, limit=256):
            try:
                with open(path, "r", errors="replace") as fh:
                    return fh.read(limit)
            except OSError:
                return ""
        payload["stopFiles"] = _cr.collect_stop_files(root, listdir, os.path.isfile, mtime, _read_stop)
    lanes = _live.collect_lane_status(root)
    payload["rebase"] = lanes.get("rebase")
    payload["devfix"] = lanes.get("devfix")
    payload["lanes"] = lanes.get("all")
    if sdir:
        save_state(sdir, "state.json", state)
        save_state(sdir, "history.json", hist)
    return sanitize(payload)


def load_env_file(path):
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except OSError:
        pass


def push(payload, source="worker"):
    base = os.environ.get("DASH_URL", "").rstrip("/")
    token = os.environ.get("INGEST_TOKEN", "")
    if not base or not token:
        log("DASH_URL/INGEST_TOKEN not set; skipping push")
        return False
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(f"{base}/api/ingest/{source}", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            log(f"pushed {len(body)} bytes -> HTTP {resp.status}")
            return True
    except urllib.error.HTTPError as exc:
        log(f"push failed: HTTP {exc.code}")
    except (urllib.error.URLError, OSError) as exc:
        log(f"push failed: {type(exc).__name__}")
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=DEFAULT_ROOT, help="jobs root (default /workspace/jobs)")
    ap.add_argument("--state-dir", default=os.environ.get("OPS_COLLECTOR_STATE", DEFAULT_STATE))
    ap.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    ap.add_argument("--once", action="store_true", help="collect once and exit")
    ap.add_argument("--loop", type=int, default=0, help="collect every N seconds (alternative to the timer)")
    ap.add_argument("--print", action="store_true", help="print the payload (implies --no-push)")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--live-window", type=int, default=1800,
                    help="ledgers older than this many seconds are not counted as active (0 = always live)")
    args = ap.parse_args(argv)
    load_env_file(args.env_file)
    while True:
        try:
            payload = collect(args.root, args.state_dir, args.live_window)
            if args.print:
                print(json.dumps(payload, indent=2))
            elif not args.no_push:
                push(payload)
        except Exception as exc:  # never crash the timer loop on a bad file
            log(f"collect failed: {type(exc).__name__}: {exc}")
            if args.once or not args.loop:
                return 1
        if args.once or not args.loop:
            return 0
        time.sleep(max(5, args.loop))


if __name__ == "__main__":
    sys.exit(main())
