#!/usr/bin/env python3
"""Live campaign activity: processes, *-1110 units, and status files.

Read-only helpers used by worker_collector. Stdlib only. Never prints secrets,
never writes under /workspace, never starts/stops units.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections import Counter

ISSUE_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b")
LANE_RE = re.compile(
    r"(rebase(?:\d+)?-\d+|devfix-\d+|gates-\d+(?:-[a-z0-9]+)?|codex-\d+|baseline-\d+|after\d+-\d+|qa-campaign[^/]*)",
    re.I,
)
STATUS_NAME_RE = re.compile(r"^(status.*|regate.*)\.json$", re.I)
SKIP_STATUS_RE = re.compile(
    r"(attempt\d|objects-missing|DRYRUN|vitest|baseline-failed|handoff|ledger|plan|terminal|classification)",
    re.I,
)
DIR_LANE_RE = re.compile(
    r"^(rebase|devfix|regate|after\d*|gates|codex|baseline)(-|$)|-\d{4}$|1110",
    re.I,
)
SERVICE_MATCH_RE = re.compile(
    r"(1110|rebase|devfix|after\d+|qa-|codex|postgres|tailscale|ops-collector)",
    re.I,
)
SERVICE_PATTERNS = (
    "qa-*", "codex*", "postgresql*", "tailscaled*", "ops-collector*",
    "*1110*", "rebase*", "devfix*", "after*",
)

# Keys that must never be forwarded from status JSON.
DROP_KEYS = {
    "prompt", "prompttxt", "prompttext", "token", "secret", "password",
    "authorization", "error", "traceback", "stderr", "stdout", "log",
    "cmd", "command", "args", "argv",
}


def _clk_tck():
    try:
        return int(os.sysconf("SC_CLK_TCK")) or 100
    except (OSError, ValueError, TypeError):
        return 100


def boot_time(proc_root="/proc"):
    for path in (os.path.join(proc_root, "stat"), "/proc/stat"):
        try:
            with open(path) as fh:
                for line in fh:
                    if line.startswith("btime "):
                        return int(line.split()[1])
        except (OSError, ValueError, IndexError):
            continue
    return None


def listdir(path):
    try:
        return os.listdir(path)
    except OSError:
        return []


def read_json(path, limit=8 * 1024 * 1024):
    try:
        size = os.path.getsize(path)
        if size > limit:
            return None
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def short_sha(value):
    if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{7,40}", value, re.I):
        return value[:12]
    return value if isinstance(value, str) and len(value) <= 16 else None


def issue_from_text(*parts):
    for part in parts:
        if not part:
            continue
        found = ISSUE_RE.findall(str(part))
        if found:
            return found[-1]
    return None


def lane_from_path(path):
    if not path:
        return None
    m = LANE_RE.search(path.replace("\\", "/"))
    return m.group(1) if m else None


def task_from_path(path):
    """Issue id, or a devfix job name (audit/guard/...), from a cwd or -C path."""
    if not path:
        return None, None
    norm = path.replace("\\", "/")
    issue = issue_from_text(norm)
    lane = lane_from_path(norm)
    job = None
    m = re.search(r"/devfix-\d+/([^/]+)/", norm, re.I)
    if m and not ISSUE_RE.fullmatch(m.group(1)):
        job = m.group(1)
    return issue or job, lane


def parse_codex_args(args):
    model = None
    effort = None
    chdir = None
    is_exec = False
    for i, a in enumerate(args):
        al = a.lower()
        if a == "exec" or al.endswith("/exec"):
            is_exec = True
        if a in ("-m", "--model") and i + 1 < len(args):
            model = args[i + 1]
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]
        elif a in ("-C", "--cd", "--chdir") and i + 1 < len(args):
            chdir = args[i + 1]
        elif a.startswith("--cd=") or a.startswith("--chdir="):
            chdir = a.split("=", 1)[1]
        elif a == "-c" and i + 1 < len(args):
            spec = args[i + 1].strip().strip("\"'")
            if spec.startswith("model_reasoning_effort="):
                effort = spec.split("=", 1)[1].strip().strip("\"'")
            elif spec.startswith("model="):
                model = spec.split("=", 1)[1].strip().strip("\"'")
        elif "model_reasoning_effort=" in a:
            effort = a.split("model_reasoning_effort=", 1)[1].strip().strip("\"'")
    return {"model": model, "effort": effort, "chdir": chdir, "is_exec": is_exec}


def is_codex_bin(args):
    if not args:
        return False
    names = [os.path.basename(a) for a in args[:3]]
    return any(
        n == "codex" or n in ("codex.js", "codex-exec") or re.match(r"^codex-(x86_64|aarch64|linux)", n)
        for n in names
    )


def _read_cmdline(path):
    try:
        with open(path, "rb") as fh:
            return [a.decode("utf-8", "replace") for a in fh.read().split(b"\0") if a]
    except OSError:
        return []


def _read_stat(path):
    """Return (ppid, start_ticks) from a /proc/pid/stat file."""
    try:
        with open(path) as fh:
            text = fh.read()
        rest = text.rsplit(")", 1)[1].split()
        ppid = rest[1]
        start_ticks = int(rest[19])
        return ppid, start_ticks
    except (OSError, IndexError, ValueError):
        return None, None


def _start_epoch(start_ticks, btime, clk):
    if start_ticks is None or btime is None:
        return None
    return btime + (start_ticks / float(clk))


def _read_cwd(proc_root, pid):
    try:
        return os.readlink(os.path.join(proc_root, pid, "cwd"))
    except OSError:
        return None


def iter_proc_entries(proc_root="/proc"):
    btime = boot_time(proc_root)
    clk = _clk_tck()
    now = time.time()
    for name in listdir(proc_root):
        if not name.isdigit():
            continue
        args = _read_cmdline(os.path.join(proc_root, name, "cmdline"))
        if not args:
            continue
        ppid, start_ticks = _read_stat(os.path.join(proc_root, name, "stat"))
        start = _start_epoch(start_ticks, btime, clk)
        cwd = _read_cwd(proc_root, name)
        elapsed = (now - start) if start else None
        yield {
            "pid": int(name),
            "ppid": int(ppid) if ppid and str(ppid).isdigit() else ppid,
            "args": args,
            "cwd": cwd,
            "start": start,
            "elapsedSec": round(elapsed) if elapsed is not None and elapsed >= 0 else None,
        }


def collect_codex_procs(proc_root="/proc"):
    """Live `codex exec` PIDs with model, effort and task from cwd/args."""
    jobs = []
    for proc in iter_proc_entries(proc_root):
        args = proc["args"]
        if not is_codex_bin(args):
            continue
        meta = parse_codex_args(args)
        if not meta["is_exec"]:
            continue
        issue, lane = task_from_path(meta["chdir"] or proc.get("cwd") or "")
        if not issue:
            issue, lane2 = task_from_path(" ".join(args))
            lane = lane or lane2
        jobs.append({
            "pid": proc["pid"],
            "ppid": proc["ppid"],
            "model": meta["model"],
            "effort": meta["effort"],
            "issue": issue,
            "lane": lane,
            "cwd": meta["chdir"] or proc.get("cwd"),
            "start": proc["start"],
            "elapsedSec": proc["elapsedSec"],
        })
    by_model = Counter((j.get("model") or "unknown") for j in jobs)
    by_effort = Counter((j.get("effort") or "unknown") for j in jobs)
    by_lane = Counter((j.get("lane") or "unknown") for j in jobs)
    jobs.sort(key=lambda j: j.get("start") or 0)
    return {
        "total": len(jobs),
        "execCount": len(jobs),
        "byModel": dict(by_model),
        "byEffort": dict(by_effort),
        "byLane": dict(by_lane),
        "jobs": jobs,
    }


def classify_gate_args(args):
    """Return a gate step name for a tsc/vitest/prisma/eslint process, or None."""
    if not args:
        return None
    joined = " ".join(args)
    # Skip helper / worker forks; we only want the main gate process.
    if "vitest/dist/workers/" in joined or "suppress-warnings" in joined:
        return None
    if os.path.basename(args[0]) == "runuser" or args[0].endswith("/runuser"):
        return None
    names = [os.path.basename(a) for a in args]
    paths = args
    def has(frag):
        return any(frag in a for a in paths) or frag in names

    if any(n == "tsc" or a.endswith("/typescript/bin/tsc") or a.endswith("/bin/tsc") for n, a in zip(names, paths)):
        return "typecheck"
    if any(n in ("vitest", "vitest.mjs") or a.endswith("/vitest.mjs") or a.endswith("/bin/vitest") for n, a in zip(names, paths)):
        return "complete_unit"
    if any(n == "eslint" or "/eslint/" in a or a.endswith("/eslint") for n, a in zip(names, paths)):
        return "lint"
    if any(n == "prisma" or "/prisma/" in a or a.endswith("/prisma") for n, a in zip(names, paths)):
        return "prisma_generate"
    return None


def collect_gate_procs(proc_root="/proc"):
    jobs = []
    seen = set()
    for proc in iter_proc_entries(proc_root):
        step = classify_gate_args(proc["args"])
        if not step:
            continue
        issue, lane = task_from_path(proc.get("cwd") or "")
        if not issue:
            issue, lane2 = task_from_path(" ".join(proc["args"]))
            lane = lane or lane2
        key = (step, issue, lane, proc.get("cwd"))
        if key in seen:
            continue
        seen.add(key)
        jobs.append({
            "pid": proc["pid"],
            "step": step,
            "issue": issue,
            "lane": lane,
            "cwd": proc.get("cwd"),
            "start": proc["start"],
            "elapsedSec": proc["elapsedSec"],
        })
    jobs.sort(key=lambda j: j.get("start") or 0)
    return {
        "total": len(jobs),
        "byStep": dict(Counter(j["step"] for j in jobs)),
        "byLane": dict(Counter((j.get("lane") or "unknown") for j in jobs)),
        "jobs": jobs,
    }


def parse_systemctl_list(out):
    units = []
    for line in (out or "").splitlines():
        if not line.strip():
            continue
        name = line.split()[0]
        if re.match(r"^[\w@.\-:]+$", name):
            units.append(name)
    return units


def parse_systemctl_show(out):
    services, cur = [], {}
    for line in (out or "").splitlines() + [""]:
        if not line.strip():
            if cur.get("Id"):
                services.append({
                    "unit": cur["Id"],
                    "active": cur.get("ActiveState"),
                    "sub": cur.get("SubState"),
                    "result": cur.get("Result"),
                })
            cur = {}
            continue
        k, _, v = line.partition("=")
        cur[k] = v
    return services


def collect_services(run_ro, patterns=SERVICE_PATTERNS):
    """Read-only systemctl list; includes any *-1110 (or rebase/devfix/after) unit.

    List every loaded service/timer and filter in Python. Transient units such as
    rebase37-1110.service are easy to miss if we rely only on systemd globs.
    """
    try:
        rc, out = run_ro([
            "systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager",
            "--type=service,timer",
        ])
    except (OSError, PermissionError) as exc:
        return None
    units = parse_systemctl_list(out)
    extra = []
    if patterns:
        try:
            rc, out2 = run_ro([
                "systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager",
                "--type=service,timer", *patterns,
            ])
            extra = parse_systemctl_list(out2)
        except (OSError, PermissionError):
            extra = []
    merged = []
    seen = set()
    for u in units + extra:
        if u in seen:
            continue
        if not SERVICE_MATCH_RE.search(u):
            continue
        seen.add(u)
        merged.append(u)
    merged = merged[:80]
    if not merged:
        return []
    try:
        rc, out = run_ro([
            "systemctl", "show", "--no-pager",
            "-p", "Id", "-p", "ActiveState", "-p", "SubState", "-p", "Result",
            *merged,
        ])
    except (OSError, PermissionError):
        return None
    return parse_systemctl_show(out)


def kind_from_dirname(name):
    lower = name.lower()
    if lower.startswith("devfix"):
        return "devfix"
    if lower.startswith("rebase"):
        return "rebase"
    if lower.startswith("regate"):
        return "regate"
    if lower.startswith("after"):
        return "after"
    if lower.startswith("gates"):
        return "gates"
    if lower.startswith("codex"):
        return "codex"
    if "devfix" in lower:
        return "devfix"
    if "rebase" in lower:
        return "rebase"
    return "other"


def discover_status_files(jobs_root):
    """Auto-discover status/regate JSON under batch lanes, including new *-NNNN dirs."""
    found = []
    for batch in listdir(jobs_root):
        bpath = os.path.join(jobs_root, batch)
        if not os.path.isdir(bpath) or batch.startswith("."):
            continue
        for entry in listdir(bpath):
            dpath = os.path.join(bpath, entry)
            if not os.path.isdir(dpath) or not DIR_LANE_RE.search(entry):
                continue
            kind = kind_from_dirname(entry)
            for fname in listdir(dpath):
                if not STATUS_NAME_RE.match(fname):
                    continue
                if SKIP_STATUS_RE.search(fname):
                    continue
                path = os.path.join(dpath, fname)
                if not os.path.isfile(path):
                    continue
                found.append({
                    "batch": batch,
                    "lane": entry,
                    "kind": kind,
                    "file": fname,
                    "path": path,
                    "mtime": mtime(path),
                })
    found.sort(key=lambda f: f.get("mtime") or 0, reverse=True)
    return found


def _gate_map(gates):
    out = {}
    if not isinstance(gates, dict):
        return out
    for name, info in gates.items():
        if name.startswith("_"):
            continue
        if isinstance(info, dict):
            st = info.get("status") or info.get("state")
            if st:
                out[name] = st
        elif isinstance(info, str):
            out[name] = info
    return out


def compact_rebase_task(issue, rec):
    if not isinstance(rec, dict):
        return {"issue": issue, "status": rec if isinstance(rec, str) else None}
    codex = rec.get("codex") if isinstance(rec.get("codex"), dict) else {}
    gates = _gate_map(rec.get("gates"))
    running_gate = next((n for n, s in gates.items() if str(s).upper() in ("RUNNING", "IN_PROGRESS")), None)
    status = rec.get("status") or rec.get("state") or rec.get("phase")
    return {
        "issue": rec.get("issue") or issue,
        "status": status,
        "rebaseMode": rec.get("rebaseMode"),
        "model": codex.get("model"),
        "effort": codex.get("effort"),
        "pid": codex.get("pid") if not rec.get("codexEndPKT") or not codex.get("codexExitCode") else None,
        "codexRunning": bool(
            status and "CODEX" in str(status).upper() and "RUNNING" in str(status).upper()
        ),
        "gates": gates,
        "currentGate": running_gate,
        "rebasedSHA": short_sha(rec.get("rebasedSHA")),
        "finalSHA": short_sha(rec.get("finalSHA")),
        "containsDevelop1906": rec.get("containsDevelop1906"),
        "conflictFileCount": len(rec["conflictFiles"]) if isinstance(rec.get("conflictFiles"), list) else None,
    }


def summarize_rebase_status(data, meta=None):
    meta = meta or {}
    tasks_in = data.get("tasks") if isinstance(data, dict) else {}
    if not isinstance(tasks_in, dict):
        tasks_in = {}
    tasks = [compact_rebase_task(k, v) for k, v in tasks_in.items()]
    counts = Counter(t.get("status") or "unknown" for t in tasks)
    running_status = lambda s: bool(s) and "RUNNING" in str(s).upper()
    running = [t for t in tasks if running_status(t.get("status")) or t.get("currentGate")]
    return {
        "kind": "rebase",
        "batch": meta.get("batch"),
        "lane": meta.get("lane"),
        "source": meta.get("file"),
        "mtime": meta.get("mtime"),
        "startPKT": data.get("startPKT") if isinstance(data, dict) else None,
        "endPKT": data.get("endPKT") if isinstance(data, dict) else None,
        "onto": short_sha(data.get("onto") if isinstance(data, dict) else None),
        "total": len(tasks),
        "running": len(running),
        "counts": dict(counts),
        "tasks": running or tasks[:40],
        "allTasks": tasks,
    }


def compact_devfix_job(name, rec, defaults=None):
    defaults = defaults or {}
    if not isinstance(rec, dict):
        return {"name": name, "status": rec if isinstance(rec, str) else None}
    rounds = rec.get("rounds") if isinstance(rec.get("rounds"), list) else []
    return {
        "name": name,
        "status": rec.get("status") or rec.get("state"),
        "model": rec.get("model") or defaults.get("model"),
        "effort": rec.get("effort") or defaults.get("effort"),
        "rounds": len(rounds),
        "startPKT": rec.get("startPKT") or defaults.get("startPKT"),
        "endPKT": rec.get("endPKT"),
        "running": bool(rec.get("status") and "CODEX_ROUND" in str(rec.get("status")).upper()
                        or (rec.get("status") and "RUNNING" in str(rec.get("status")).upper())),
    }


def summarize_devfix_status(data, meta=None):
    meta = meta or {}
    if not isinstance(data, dict):
        data = {}
    jobs_in = data.get("jobs") if isinstance(data.get("jobs"), dict) else {}
    defaults = {k: data.get(k) for k in ("model", "effort", "startPKT")}
    jobs = [compact_devfix_job(k, v, defaults) for k, v in jobs_in.items()]
    counts = Counter(j.get("status") or "unknown" for j in jobs)
    return {
        "kind": "devfix",
        "batch": meta.get("batch"),
        "lane": meta.get("lane"),
        "source": meta.get("file"),
        "mtime": meta.get("mtime"),
        "startPKT": data.get("startPKT"),
        "model": data.get("model"),
        "effort": data.get("effort"),
        "total": len(jobs),
        "running": sum(1 for j in jobs if j.get("running")),
        "counts": dict(counts),
        "jobs": jobs,
    }


def summarize_regate_status(data, meta=None):
    meta = meta or {}
    tasks_in = data.get("tasks") if isinstance(data, dict) else {}
    if not isinstance(tasks_in, dict):
        tasks_in = {}
    tasks = []
    for issue, rec in tasks_in.items():
        if not isinstance(rec, dict):
            continue
        tasks.append({
            "issue": issue,
            "status": rec.get("status"),
            "gates": _gate_map(rec.get("gates")),
            "rebasedSHA": short_sha(rec.get("rebasedSHA")),
            "startPKT": rec.get("startPKT"),
            "endPKT": rec.get("endPKT"),
        })
    return {
        "kind": "regate",
        "batch": meta.get("batch"),
        "lane": meta.get("lane"),
        "source": meta.get("file"),
        "mtime": meta.get("mtime"),
        "total": len(tasks),
        "counts": dict(Counter(t.get("status") or "unknown" for t in tasks)),
        "tasks": tasks,
    }


def _prefer_current(files):
    """Pick the live-most status file: no endPKT preferred, then newest mtime."""
    scored = []
    for f in files:
        data = f.get("data") if isinstance(f.get("data"), dict) else {}
        ended = 1 if data.get("endPKT") else 0
        generic = 1 if f.get("file") == "status.json" else 0
        scored.append((ended, generic, -(f.get("mtime") or 0), f))
    scored.sort(key=lambda x: (x[0], x[1], x[2]))
    return scored[0][3] if scored else None


def collect_lane_status(jobs_root):
    """Read rebase/devfix/regate status files, auto-discovering new lanes."""
    discovered = discover_status_files(jobs_root)
    groups = {}
    all_sources = []
    for meta in discovered:
        data = read_json(meta["path"])
        if data is None:
            continue
        rec = dict(meta)
        rec["data"] = data
        key = (meta["batch"], meta["lane"], meta["kind"])
        groups.setdefault(key, []).append(rec)
        all_sources.append({
            "batch": meta["batch"], "lane": meta["lane"], "kind": meta["kind"],
            "file": meta["file"], "mtime": meta["mtime"],
        })

    rebases, devfixes, regates, other = [], [], [], []
    for (batch, lane, kind), files in groups.items():
        if kind == "rebase":
            status_files = [f for f in files if str(f.get("file", "")).startswith("status")]
            current = _prefer_current(status_files) or _prefer_current(files)
            if current:
                rebases.append(summarize_rebase_status(current["data"], current))
            for f in files:
                if str(f.get("file", "")).startswith("regate"):
                    regates.append(summarize_regate_status(f["data"], f))
        elif kind == "devfix":
            current = _prefer_current(files)
            if current:
                devfixes.append(summarize_devfix_status(current["data"], current))
        elif kind == "regate":
            for f in files:
                regates.append(summarize_regate_status(f["data"], f))
        else:
            current = _prefer_current(files)
            if current and isinstance(current.get("data"), dict) and "jobs" in current["data"]:
                other.append(summarize_devfix_status(current["data"], current))
            elif current:
                other.append(summarize_rebase_status(current["data"], current))

    # Prefer the rebase/devfix group with the most running work, then newest.
    def pick(items):
        if not items:
            return None
        return sorted(items, key=lambda x: (x.get("running") or 0, x.get("mtime") or 0), reverse=True)[0]

    rebase = pick(rebases)
    if rebase and regates:
        # Attach matching-lane regate summaries.
        rebase = dict(rebase)
        rebase["regate"] = [r for r in regates if r.get("lane") == rebase.get("lane") or r.get("batch") == rebase.get("batch")]

    return {
        "rebase": rebase,
        "devfix": pick(devfixes),
        "regate": regates,
        "other": other,
        "all": all_sources,
        "rebases": rebases,
        "devfixes": devfixes,
    }


def merge_live_codex(codex, procs):
    """Prefer live `codex exec` processes as the source of active jobs."""
    codex = dict(codex or {})
    jobs = list((procs or {}).get("jobs") or [])
    if not jobs:
        return codex
    active = []
    by_model = Counter()
    for j in jobs:
        issue = j.get("issue") or f"pid-{j.get('pid')}"
        active.append({
            "issue": issue,
            "run": j.get("lane") or "live",
            "status": "RUNNING",
            "model": j.get("model"),
            "effort": j.get("effort"),
            "start": j.get("start"),
            "running": True,
            "step": "exec",
            "pid": j.get("pid"),
            "lane": j.get("lane"),
            "elapsedSec": j.get("elapsedSec"),
        })
        by_model[j.get("model") or "unknown"] += 1
    codex["active"] = active
    codex["activeCount"] = len(active)
    codex["byModel"] = dict(by_model)
    codex["liveFromProcs"] = True
    return codex


def gates_now_from_procs(gate_procs, default_batch=None):
    """Shape live gate processes like server `now.gates` entries."""
    out = []
    for j in (gate_procs or {}).get("jobs") or []:
        out.append({
            "batch": default_batch,
            "issue": j.get("issue"),
            "run": j.get("lane") or "live",
            "kind": (j.get("lane") or "gates").split("-")[0],
            "step": j.get("step"),
            "gate": j.get("step"),
            "start": j.get("start"),
            "pid": j.get("pid"),
            "done": 0,
            "total": 0,
            "live": True,
        })
    return out
