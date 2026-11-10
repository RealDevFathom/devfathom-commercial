"""Dashboard view-model helpers: verdict rollups, Inky usage, analysis guards, service display, baselines."""
from __future__ import annotations

import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

# Current develop tip the 70 were retargeted onto (10 Nov 2026 campaign repair).
CURRENT_DEVELOP_PREFIX = "fa2004e2"
PREVIOUS_DEVELOP_PREFIX = "1906b530"
INVALID_BASE_PREFIX = "0c6245c"
ARCHIVED_BATCH_IDS = {"pharmacy-review-50"}
ARCHIVED_LABELS = {"pharmacy review 50"}

# Lane-stop markers (not the owner usage cutoff, not db-stop logs).
STOP_FILE_RE = re.compile(r"^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*_STOP$")
STOP_SKIP_RE = re.compile(r"(OWNER_USAGE|stop-resume|db-stop|\.log$|\.stderr|\.stdout)", re.I)

CURRENT_LANE_RE = re.compile(r"^(rebase-1906|retarget-?1906)", re.I)
SUPERSEDED_LANE_RE = re.compile(r"^(rebase-1110|rebase37|status-37)", re.I)
HISTORICAL_RUN_RE = re.compile(r"^(codex-1110|gates-1110)(-|$)", re.I)

MAX_ATTEMPTS = 40
MAX_FAILING_TESTS = 40


def short(sha, n=10):
    if not sha:
        return None
    s = str(sha)
    return s[:n] if len(s) >= n else s


def sha_matches(value, prefix):
    if not value or not prefix:
        return False
    a, b = str(value).lower(), str(prefix).lower()
    n = min(len(a), len(b))
    return n >= 7 and a[:n] == b[:n]


def is_complete_baseline(b):
    if not isinstance(b, dict):
        return False
    sha = b.get("baseSHA") or b.get("sha")
    if not sha:
        return False
    if b.get("numPassedTests") is not None:
        return True
    # rebase-1906 status.baseline on fa2004e2 records unitFailedCount and complete=true
    # without a pass count (from empty-after-fa2004e2).
    if b.get("complete") and (b.get("unitFailedCount") is not None or b.get("numFailedTests") is not None):
        return True
    return False


def baseline_incomplete_reason(b):
    if is_complete_baseline(b):
        return None
    missing = []
    if not (b or {}).get("baseSHA") and not (b or {}).get("sha"):
        missing.append("no base SHA")
    if ((b or {}).get("numPassedTests") is None and (b or {}).get("numFailedTests") is None
            and (b or {}).get("unitFailedCount") is None):
        missing.append("no test counts")
    return ", ".join(missing) or "incomplete"


def annotate_baseline(b, preferred=False, develop_prefix=CURRENT_DEVELOP_PREFIX):
    if not isinstance(b, dict):
        return b
    out = dict(b)
    sha = out.get("baseSHA") or out.get("sha")
    if sha and not out.get("baseSHA"):
        out["baseSHA"] = short(sha, 12)
    out["complete"] = is_complete_baseline(out)
    out["incomplete"] = not out["complete"]
    if out["incomplete"]:
        out["incompleteReason"] = baseline_incomplete_reason(out)
    out["current"] = bool(preferred)
    out["historical"] = not bool(preferred)
    out["matchesDevelop"] = sha_matches(sha, develop_prefix)
    if out.get("run") and "hotel-dynamic" in str(out.get("run")):
        out.setdefault("incompleteReason", out.get("incompleteReason") or "canonical bootstrap, not a full QA baseline")
        if not out["complete"]:
            out["incomplete"] = True
    return out


def pick_current_baseline(baselines, develop_prefix=None, strict=False):
    """Prefer a complete baseline on the current develop SHA; else the newest complete one.

    When strict=True (caller has MERGE_POLICY or rebase status.target showing the tip
    has moved), return None if no complete baseline matches so the caller can stub
    the new tip instead of quietly keeping 1906b530 as current.
    """
    items = [b for b in (baselines or []) if isinstance(b, dict)]
    complete = [b for b in items if is_complete_baseline(b)]

    def recency(b):
        return (b.get("end") or b.get("start") or 0, 1 if (b.get("run") or "").startswith("baseline-1110") else 0)

    on_develop = [b for b in complete if sha_matches(b.get("baseSHA") or b.get("sha"), develop_prefix)]
    if on_develop:
        return max(on_develop, key=recency)
    if strict and develop_prefix and complete and not on_develop:
        return None
    if complete:
        return max(complete, key=recency)
    return max(items, key=recency) if items else None


def previous_complete_baseline(baselines, current_sha=None):
    items = [b for b in (baselines or []) if isinstance(b, dict) and is_complete_baseline(b)]
    if current_sha:
        items = [b for b in items if not sha_matches(b.get("baseSHA") or b.get("sha"), current_sha)]
    if not items:
        return None
    return max(items, key=lambda b: (b.get("end") or b.get("start") or 0, 1 if str(b.get("run") or "").startswith("baseline-1110") else 0))


def stub_baseline_for_tip(develop_sha, previous=None, run="develop-tip"):
    """Current develop tip when no complete recorded baseline exists on that SHA."""
    prev_sha = (previous or {}).get("baseSHA") or (previous or {}).get("sha") if previous else None
    reason = "no recorded test counts on the current develop tip yet"
    if prev_sha:
        reason += (f"; previous complete baseline {short(prev_sha, 8)} "
                   f"({(previous or {}).get('numPassedTests')} pass / {(previous or {}).get('numFailedTests')} fail) is historical")
    return {
        "run": run,
        "baseSHA": short(develop_sha, 8),
        "sha": develop_sha,
        "status": "PENDING_BASELINE_ON_NEW_TIP",
        "complete": False,
        "incomplete": True,
        "incompleteReason": reason,
        "current": True,
        "matchesDevelop": True,
        "numPassedTests": None,
        "numFailedTests": None,
        "previousSHA": short(prev_sha, 8) if prev_sha else None,
    }


def classify_run(name, *, has_current_rebase=False, invalid_base=None, target=None):
    """Tag a run as current, historical or superseded.

    status.invalidOldBase is historical metadata ("we left 0c6245c"). It must
    not mark the current rebase-1906 lane superseded when the live target is
    fa2004e2 (or any non-invalid SHA). Only a live target (or a per-run
    INVALID_ONTO_0c6245c marker, passed as target/invalid_base for that run)
    on the invalid base can demote the current lane.
    """
    name = name or ""
    info = {"name": name, "current": False, "historical": False, "superseded": False, "supersededReason": None}
    if CURRENT_LANE_RE.search(name):
        info["current"] = True
        # Live target wins over the recorded invalidOldBase.
        if sha_matches(target, INVALID_BASE_PREFIX):
            info["superseded"] = True
            info["current"] = False
            info["supersededReason"] = f"rebased onto invalid base {short(target)}"
        return info
    if SUPERSEDED_LANE_RE.search(name) or sha_matches(target, INVALID_BASE_PREFIX) or sha_matches(invalid_base, INVALID_BASE_PREFIX):
        info["superseded"] = True
        info["historical"] = True
        bad = target if sha_matches(target, INVALID_BASE_PREFIX) else invalid_base
        info["supersededReason"] = (
            f"rebased onto invalid base {short(bad)}" if sha_matches(bad, INVALID_BASE_PREFIX)
            else "superseded by rebase onto develop 1906b530 / fa2004e2"
        )
        return info
    if has_current_rebase and HISTORICAL_RUN_RE.search(name):
        info["historical"] = True
        info["supersededReason"] = "historical; current state is rebase-1906-1110"
        return info
    return info


def is_archived_batch(batch):
    if not isinstance(batch, dict):
        return False
    if batch.get("archived"):
        return True
    bid = str(batch.get("id") or batch.get("name") or "")
    label = str(batch.get("label") or "").strip().lower()
    if bid in ARCHIVED_BATCH_IDS or label in ARCHIVED_LABELS:
        return True
    hay = f"{bid} {label}".lower().replace("_", "-")
    return "review-50" in hay or "review 50" in hay



def campaign_pause_from_stops(stop_files, baseline=None):
    """Detect a controller pause of Codex dispatch (do not infer from jobs).

    RETARGET1906_STOP currently reads:
      "PAUSE_CODEX no new Codex dispatch until baseline is corrected. Inky 09:34 PKT."
    That is BASELINE_SUSPECT / campaign-paused — display only.
    """
    for rec in stop_files or []:
        if not isinstance(rec, dict):
            continue
        name = str(rec.get("name") or "")
        text = str(rec.get("text") or "")
        blob = f"{name} {text}"
        if "PAUSE_CODEX" not in blob and "no new Codex dispatch" not in blob:
            continue
        suspect = bool(
            "BASELINE_SUSPECT" in blob
            or "baseline is corrected" in text.lower()
            or "until baseline" in text.lower()
        )
        return {
            "key": "BASELINE_SUSPECT" if suspect else "campaign-paused",
            "status": "campaign-paused",
            "paused": True,
            "dispatch": "paused",
            "reason": text or "No new Codex dispatch",
            "stopFile": name,
            "stoppedAt": rec.get("mtime"),
            "baseline": {
                "sha": (baseline or {}).get("baseSHA") or (baseline or {}).get("sha"),
                "from": (baseline or {}).get("from"),
                "complete": (baseline or {}).get("complete"),
                "numPassedTests": (baseline or {}).get("numPassedTests"),
                "numFailedTests": (baseline or {}).get("numFailedTests"),
            } if baseline else None,
        }
    return None


def collect_stop_files(root, listdir, isfile, mtime, read_text, under=None):
    """Lane-stop markers such as CODEX_1110_STOP and RETARGET1906_STOP."""
    found = []
    bases = [root]
    try:
        bases += [os.path.join(root, d) for d in listdir(root)
                  if not str(d).startswith(".") and not isfile(os.path.join(root, d))]
    except TypeError:
        pass
    seen = set()
    for base in bases:
        try:
            names = listdir(base)
        except (OSError, TypeError):
            continue
        for name in names:
            if not STOP_FILE_RE.match(name) or STOP_SKIP_RE.search(name):
                continue
            path = os.path.join(base, name)
            if not isfile(path):
                continue
            if path in seen:
                continue
            seen.add(path)
            lines = [ln.strip() for ln in (read_text(path, limit=1024) or "").splitlines() if ln.strip()]
            rec = {
                "name": name,
                "dir": os.path.basename(base) if base != root else "",
                "mtime": mtime(path),
                "active": True,
                # First line may be only a timestamp; keep following lines (PAUSE_CODEX …).
                "text": " ".join(lines)[:240] if lines else None,
            }
            found.append(rec)
    found.sort(key=lambda r: r.get("mtime") or 0, reverse=True)
    return found[:80]


def _failing_from_steps(steps):
    failing_gates, tests = [], []
    for name, val in (steps or {}).items():
        if not isinstance(val, dict):
            status = str(val)
            if status.upper() == "FAIL":
                failing_gates.append(name)
            continue
        st = str(val.get("status") or "")
        if st.upper() == "FAIL":
            failing_gates.append(name)
            for key in ("failedTests", "failedNames", "failedFiles"):
                items = val.get(key) or []
                if isinstance(items, list):
                    tests.extend(str(x) for x in items[:MAX_FAILING_TESTS])
    return failing_gates, tests[:MAX_FAILING_TESTS]


def attempts_from_status_task(task):
    """Synthesize fix-round history from status.json when attempts.json is absent."""
    attempts = []
    codex = task.get("codex") if isinstance(task.get("codex"), list) else []
    gate_runs = task.get("gateRuns") if isinstance(task.get("gateRuns"), list) else []
    for i, c in enumerate(codex, start=1):
        if not isinstance(c, dict):
            continue
        rec = {
            "round": i,
            "model": c.get("model"),
            "effort": c.get("effort"),
            "purpose": c.get("purpose"),
            "start": c.get("codexStartPKT") or c.get("startPKT"),
            "end": c.get("codexEndPKT") or c.get("endPKT"),
            "exit": c.get("codexExitCode"),
            "failingGate": None,
            "failingTests": [],
            "rootCause": None,
            "source": "status.json",
        }
        attempts.append(rec)
    # Attach the first failing gate run to the last attempt (typical: gates after a fix round).
    if attempts and gate_runs:
        last_gate = gate_runs[-1] if isinstance(gate_runs[-1], dict) else None
        if last_gate:
            gates, tests = _failing_from_steps(last_gate.get("steps"))
            if gates:
                attempts[-1]["failingGate"] = gates[0]
                attempts[-1]["failingGates"] = gates
            attempts[-1]["failingTests"] = tests
            if task.get("status"):
                attempts[-1]["rootCause"] = str(task["status"])
    elif not attempts and task.get("status"):
        gates, tests = ([], [])
        if gate_runs and isinstance(gate_runs[-1], dict):
            gates, tests = _failing_from_steps(gate_runs[-1].get("steps"))
        attempts.append({
            "round": 1, "model": None, "effort": None, "purpose": "gates",
            "failingGate": gates[0] if gates else None, "failingGates": gates,
            "failingTests": tests, "rootCause": str(task.get("status")), "source": "status.json",
        })
    return attempts[:MAX_ATTEMPTS]


def load_attempts(path, read_json):
    data = read_json(path)
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("attempts") or data.get("rounds") or data.get("items") or []
    else:
        return []
    out = []
    for i, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            continue
        out.append({
            "round": row.get("round") or i,
            "model": row.get("model"),
            "effort": row.get("effort"),
            "purpose": row.get("purpose") or row.get("kind"),
            "start": row.get("start") or row.get("startPKT") or row.get("codexStartPKT"),
            "end": row.get("end") or row.get("endPKT") or row.get("codexEndPKT"),
            "exit": row.get("exit") or row.get("codexExitCode"),
            "failingGate": row.get("failingGate") or row.get("failedGate") or (row.get("failingGates") or [None])[0],
            "failingGates": row.get("failingGates") or ([row["failingGate"]] if row.get("failingGate") else []),
            "failingTests": (row.get("failingTests") or row.get("failedTests") or [])[:MAX_FAILING_TESTS],
            "rootCause": row.get("rootCause") or row.get("reason") or row.get("summary"),
            "source": "attempts.json",
        })
    return out[:MAX_ATTEMPTS]


def flags_by_issue(flags):
    items = []
    if isinstance(flags, dict):
        items = flags.get("items") or flags.get("flags") or []
        meta = {k: flags.get(k) for k in ("updatedPKT", "audience", "source", "targetDevelop") if k in flags}
    elif isinstance(flags, list):
        items, meta = flags, {}
    else:
        return {}
    out = {}
    for it in items:
        if isinstance(it, dict) and it.get("issue"):
            rec = dict(it)
            rec.update(meta)
            out[it["issue"]] = rec
    return out


def annotate_services(services):
    """For oneshot units driven by a timer, expose the timer's health instead of 'activating'/'inactive'."""
    services = list(services or [])
    by = {s.get("unit"): s for s in services if isinstance(s, dict) and s.get("unit")}
    out = []
    for raw in services:
        if not isinstance(raw, dict):
            continue
        s = dict(raw)
        name = s.get("unit") or ""
        typ = str(s.get("type") or "").lower()
        timer_name = name[:-8] + ".timer" if name.endswith(".service") else None
        timer = by.get(timer_name) if timer_name else None
        is_oneshot = typ == "oneshot" or (timer is not None and typ in ("", "oneshot", "simple"))
        if name.endswith(".timer"):
            s["role"] = "timer"
            s["displayActive"] = s.get("active")
            s["displaySub"] = s.get("sub")
            sub = s.get("sub") or s.get("active") or "unknown"
            s["displayLabel"] = f"timer {sub}"
        elif is_oneshot and timer:
            s["role"] = "oneshot-timer"
            s["companionTimer"] = timer.get("unit")
            s["type"] = s.get("type") or "oneshot"
            svc_active = s.get("active")
            timer_active, timer_sub = timer.get("active"), timer.get("sub")
            if svc_active == "activating" or timer_sub == "running":
                s["displayActive"] = "active"
                s["displaySub"] = "running"
                s["displayLabel"] = "running (scheduled oneshot)"
            elif svc_active == "failed" or str(s.get("result") or "").lower() == "failed":
                s["displayActive"] = "failed"
                s["displaySub"] = s.get("sub") or "failed"
                s["displayLabel"] = "last run failed"
            elif timer_active == "active":
                s["displayActive"] = "active"
                s["displaySub"] = timer_sub or "waiting"
                result = s.get("result") or "unknown"
                s["displayLabel"] = f"scheduled (last run {result})"
            else:
                s["displayActive"] = timer_active or svc_active
                s["displaySub"] = timer_sub or s.get("sub")
                s["displayLabel"] = f"{s['displayActive']}/{s['displaySub']}"
        else:
            s["role"] = "service"
            s["displayActive"] = s.get("active")
            s["displaySub"] = s.get("sub")
            s["displayLabel"] = f"{s.get('active') or '?'}/{s.get('sub') or '?'}"
        out.append(s)
    return out


# systemd show keys we ask for (safe, read-only).
SERVICE_SHOW_PROPS = (
    "Id", "Type", "ActiveState", "SubState", "Result", "UnitFileState",
    "LastTriggerUSec", "NextElapseUSecRealtime",
    "ExecMainStatus", "ExecMainStartTimestamp", "ExecMainExitTimestamp",
    "Triggers", "TriggeredBy", "Description",
)

SERVICE_PROP_MAP = {
    "Id": "unit", "Type": "type", "ActiveState": "active", "SubState": "sub", "Result": "result",
    "UnitFileState": "unitFileState", "LastTriggerUSec": "lastTrigger",
    "NextElapseUSecRealtime": "nextElapse", "ExecMainStatus": "execStatus",
    "ExecMainStartTimestamp": "execStart", "ExecMainExitTimestamp": "execExit",
    "Triggers": "triggers", "TriggeredBy": "triggeredBy", "Description": "description",
}


def parse_systemctl_show_full(out):
    services, cur = [], {}
    for line in (out or "").splitlines() + [""]:
        if not line.strip():
            if cur.get("Id"):
                rec = {}
                for src, dst in SERVICE_PROP_MAP.items():
                    if cur.get(src):
                        rec[dst] = cur[src]
                rec.setdefault("unit", cur.get("Id"))
                rec.setdefault("active", cur.get("ActiveState"))
                rec.setdefault("sub", cur.get("SubState"))
                rec.setdefault("result", cur.get("Result"))
                services.append(rec)
            cur = {}
            continue
        k, _, v = line.partition("=")
        cur[k] = v
    return annotate_services(services)


def inky_usage_from_box(box, worker_usage=None):
    """Inky (Grok Bot) weekly usage: prefer the box collector, never treat it as Codex/worker/Claude usage."""
    label = "Inky (Grok Bot) weekly usage, stop at 95%"
    raw = (box or {}).get("usage") if isinstance((box or {}).get("usage"), dict) else {}
    fallback = worker_usage if isinstance(worker_usage, dict) else {}
    weekly = raw.get("weeklyPct")
    source = "box" if weekly is not None else None
    if weekly is None and fallback.get("weeklyPct") is not None:
        # Resume-note / stop-file figure from the worker is last-recorded, not live Inky usage.
        weekly = fallback.get("weeklyPct")
        source = "worker-stop-note"
    stop_active = raw.get("stopActive")
    if stop_active is None:
        stop_active = bool(fallback.get("stopActive"))
    return {
        "subject": "inky-grok-bot",
        "label": label,
        "weeklyPct": weekly,
        "stopLine": 95.0,
        "stopActive": bool(stop_active),
        "stopSince": raw.get("stopSince") or fallback.get("stopSince"),
        "clearedAt": raw.get("clearedAt") or fallback.get("clearedAt"),
        "resetAt": raw.get("resetAt"),
        "checkedAt": raw.get("checkedAt") or raw.get("collectedAt"),
        "note": raw.get("note") or (fallback.get("note") if source != "box" else None),
        "source": source or raw.get("source") or "unknown",
        "stale": source == "worker-stop-note",
    }


def compact_guards(state):
    """A small, never-truncated prefix for the AI analysis digest."""
    w = (state or {}).get("worker") or {}
    box = (state or {}).get("box") or {}
    sysm = w.get("system") or {}
    disks = {}
    for path, d in (sysm.get("disks") or {}).items():
        if isinstance(d, dict):
            disks[path] = {k: d.get(k) for k in ("pct", "freeBytes", "totalBytes") if k in d}
    workers = []
    for rec in box.get("workers") or []:
        if not isinstance(rec, dict):
            continue
        workers.append({k: rec.get(k) for k in (
            "instanceId", "instanceType", "az", "region", "spotPrice", "state", "lifecycle",
            "name", "spotRequestState")})
    usage = (state or {}).get("usage") or {}
    baseline = None
    for b in ((state or {}).get("batches") or []):
        if isinstance(b, dict) and b.get("baseline") and not b.get("archived"):
            baseline = {k: (b.get("baseline") or {}).get(k) for k in (
                "run", "baseSHA", "complete", "incompleteReason", "numPassedTests", "numFailedTests", "current")}
            break
    return {
        "sources": (state or {}).get("sources"),
        "system": {k: sysm.get(k) for k in ("cores", "cpuPct", "load", "mem", "psi", "uptimeSec", "loadHigh5m")}
                  | {"disks": disks},
        "killSwitch": w.get("killSwitch"),
        "stopFiles": w.get("stopFiles") or [],
        "usage": {k: usage.get(k) for k in (
            "subject", "label", "weeklyPct", "stopLine", "stopActive", "resetAt", "checkedAt", "source", "stale", "note")},
        "machine": box.get("machine"),
        "region": box.get("region"),
        "workers": workers,
        "overview": {k: ((state or {}).get("overview") or {}).get(k) for k in (
            "tasks", "fixed", "failed", "gated", "merged", "done", "pendingQa", "rejected", "running", "queued",
            "usagePct", "machineHours", "machineCostUsd", "codexActive", "codexCap")},
        "develop": (state or {}).get("develop"),
        "current": (w.get("current") or (state or {}).get("current")),
        "baseline": baseline,
    }


def verdict_key(t):
    return ((t or {}).get("verdict") or {}).get("key")


PASSED_VERDICTS = {"passed", "merged", "done"}


def counts_from_verdicts(tasks):
    """Batch / overview rollup: only per-task verdicts, never the raw collector `fixed` flag."""
    c = Counter()
    c["total"] = len(tasks or [])
    for t in tasks or []:
        k = verdict_key(t) or ((t or {}).get("liveVerdict") or {}).get("key")
        if k in PASSED_VERDICTS:
            c["fixed"] += 1
            c["gated"] += 1
        if k == "failed":
            c["failed"] += 1
        elif k == "blocked":
            c["blocked"] += 1
        elif k in ("queued", "pending"):
            c["queued"] += 1
        elif k == "running":
            c["running"] += 1
        elif k == "gates":
            c["awaitingGates"] += 1
        elif k == "pending_qa":
            c["pendingQa"] += 1
        elif k == "rejected":
            c["rejected"] += 1
        if t.get("merged"):
            c["merged"] += 1
        if t.get("done"):
            c["done"] += 1
        if t.get("ghClosed") and t.get("linearClosed") is not False:
            c["closed"] += 1
        if t.get("running"):
            c["runningLive"] += 1
    return {
        "total": c["total"], "fixed": c["fixed"], "failed": c["failed"], "gated": c["gated"],
        "merged": c["merged"], "closed": c["closed"], "done": c["done"],
        "running": c["running"] or c["runningLive"], "queued": c["queued"], "blocked": c["blocked"],
        "awaitingGates": c["awaitingGates"], "pending": c["queued"],
        "pendingQa": c["pendingQa"], "rejected": c["rejected"],
    }

# --------------------------------------------------------------------------- current rebase-1906 status

REQUIRED_GATES = ("prisma", "typecheck", "lint", "complete_unit", "host_build", "docker")
CURRENT_STATUS_DIR_RE = re.compile(r"rebase-1906", re.I)
PENDING_QA_STATUSES = {
    "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
}
REAL_FAIL_STATUSES = {
    "GATES_FAIL_NEW_VS_BASELINE",
    "NEEDS_PRODUCT_FIX",
}
RECLASS_BASELINE_ONLY = "HARNESS_FALSE_OR_BASELINE_ONLY"
RECLASS_REAL_FAIL = "REAL_NEW_FAILURES"


def parse_pkt(value):
    """Parse campaign timestamps (ISO / PKT / epoch) to epoch seconds."""
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
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def is_running_status(status):
    return bool(re.search(r"RUNNING|VERIFYING", str(status or ""), re.I))


def verdict_from_current_status(status, reclass=None, running=False):
    """Map rebase-1906 / reclassify statuses to a dashboard verdict.

    Baseline-only (pending QA/Security) is never failed. Only new-vs-baseline
    (or NEEDS_PRODUCT_FIX) counts as a real failure. Rejected is its own key.
    """
    st = str(status or "")
    rec = reclass if isinstance(reclass, dict) else {}
    rec_verdict = rec.get("verdict")
    if running or is_running_status(st):
        if "GATES" in st:
            label = "Running gates"
        elif "CONFLICT" in st:
            label = "Running conflict fix"
        elif "CODEX" in st:
            label = "Running Codex"
        else:
            label = "Running"
        return {"key": "running", "label": label, "status": st or None}
    if "REJECTED" in st:
        return {"key": "rejected", "label": "Rejected: assertion guard", "status": st}
    if st in ("QUEUED_RESUME", "GATES_INTERRUPTED_NEED_RERUN"):
        return {"key": "queued", "label": "Queued to resume" if st == "QUEUED_RESUME" else "Queued: gates interrupted", "status": st}
    if st == "NEEDS_MIGRATION_FIX":
        return {"key": "failed", "label": "Failed: needs migration fix", "gates": ["prisma"], "status": st}
    if st == "NEEDS_PRODUCT_FIX":
        return {"key": "failed", "label": "Failed: needs product fix", "gates": ["differential"], "status": st}
    if st == "GATES_FAILED_CODEX_NO_CHANGE":
        return {"key": "failed", "label": "Failed: gates, no code change", "gates": ["differential"], "status": st}
    if st in ("BLOCKED_BY_DEVELOP_BASELINE_TYPECHECK", "BLOCKED_BY_DEVELOP_BASELINE"):
        return {"key": "blocked", "label": "Blocked by develop baseline", "gates": ["typecheck"], "status": st}
    if "HARNESS_BLOCKER" in st or st.startswith("HARNESS_BLOCK"):
        return {"key": "blocked", "label": "Blocked: harness", "status": st}
    if "BLOCKED" in st:
        return {"key": "blocked", "label": st.replace("_", " ").title(), "status": st}
    # Prefer the live status when it has moved on from the reclassify snapshot.
    if st in PENDING_QA_STATUSES or (
        rec_verdict == RECLASS_BASELINE_ONLY and (not st or st == rec.get("newStatus"))
    ):
        return {"key": "pending_qa", "label": "Pending QA / Security (baseline-only)", "status": st or rec.get("newStatus")}
    if st in REAL_FAIL_STATUSES or (
        rec_verdict == RECLASS_REAL_FAIL and (not st or st == rec.get("newStatus"))
    ):
        return {"key": "failed", "label": "Failed: new vs baseline", "gates": ["differential"], "status": st or rec.get("newStatus")}
    if st in ("", "PENDING", "QUEUED", "NOT_STARTED", None) and not rec:
        return {"key": "queued", "label": "Queued", "status": st or None}
    if st in ("GATES_PASS", "GATES_PASSED", "PASSED", "TERMINAL_GATES_PASSED") or rec.get("verdict") == "PASSED_ALL":
        return {"key": "passed", "label": "Passed on final SHA", "status": st}
    if not st:
        return {"key": "queued", "label": "Queued", "status": None}
    return {"key": "pending", "label": st.replace("_", " ").title(), "status": st}


def _path_names(items, limit=60):
    out = []
    for x in items or []:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            out.append(x.get("file") or x.get("name") or x.get("key") or str(x))
        else:
            out.append(str(x))
        if len(out) >= limit:
            break
    return out


def gates_from_current(status, reclass, sha, run="rebase-1906-1110"):
    """Synthesize gate cells from the current status + reclassify lists."""
    rec = reclass if isinstance(reclass, dict) else {}
    v = verdict_from_current_status(status, rec)
    sha_s = short(sha, 10)
    baseline_only = _path_names(rec.get("baselineOnly"))
    new_vs = _path_names(rec.get("newVsBaseline"))
    g = {}
    if v["key"] in ("pending_qa", "passed", "merged", "done"):
        for k in REQUIRED_GATES:
            g[k] = {"status": "PASS", "run": run, "sha": sha_s,
                    "note": "passed vs complete baseline-1110"}
        if baseline_only:
            g["complete_unit"] = {
                "status": "FAIL", "run": run, "sha": sha_s,
                "failedFiles": baseline_only, "failed": len(baseline_only),
                "note": "baseline-only failures; not new vs develop 1906b530",
            }
        g["differential"] = {
            "status": "PASS", "newFailures": [],
            "baselineFailures": len(baseline_only), "sha": sha_s, "run": run,
            "note": "no new failures vs complete baseline-1110",
        }
        g["final_sha"] = {"status": "PASS", "sha": sha_s, "run": run}
        g["qa_browser"] = {"status": "PENDING", "note": "pending QA"}
        g["security"] = {"status": "PENDING", "note": "pending Security"}
    elif v["key"] == "failed":
        g["complete_unit"] = {
            "status": "FAIL", "run": run, "sha": sha_s,
            "failedFiles": (new_vs + baseline_only)[:60],
            "failed": len(new_vs) + len(baseline_only),
            "note": f"{len(new_vs)} new vs baseline, {len(baseline_only)} baseline-only",
        }
        g["differential"] = {
            "status": "FAIL", "newFailures": new_vs,
            "baselineFailures": len(baseline_only), "sha": sha_s, "run": run,
        }
        g["final_sha"] = {"status": "PENDING", "sha": sha_s, "run": run}
    elif v["key"] == "running":
        if "GATES" in str(status or ""):
            g["complete_unit"] = {"status": "RUNNING", "run": run, "sha": sha_s}
        g["final_sha"] = {"status": "PENDING", "sha": sha_s, "run": run}
    elif v["key"] == "rejected":
        g["final_sha"] = {"status": "PENDING", "sha": sha_s, "run": run,
                         "note": "rejected by assertion guard; not a gate failure"}
    return g


def compact_reclassify(rec):
    if not isinstance(rec, dict):
        return None
    return {
        "oldStatus": rec.get("oldStatus"),
        "newStatus": rec.get("newStatus"),
        "verdict": rec.get("verdict"),
        "failedOnTaskCount": rec.get("failedOnTaskCount"),
        "newVsBaseline": _path_names(rec.get("newVsBaseline"), 40),
        "baselineOnly": _path_names(rec.get("baselineOnly"), 40),
        "rebasedSHA": short(rec.get("rebasedSHA"), 12),
        "label": rec.get("label"),
        "eacces": rec.get("eacces"),
    }


def task_from_current_status(issue, st, reclass=None, flag=None, attempts=None, run="rebase-1906-1110"):
    """Build a collector task view-model from status.json + reclassify."""
    st = st if isinstance(st, dict) else {}
    rec = reclass if isinstance(reclass, dict) else {}
    status = st.get("status") or rec.get("newStatus")
    running = is_running_status(status)
    sha = (st.get("finalRebasedSHA") or st.get("rebasedSHA") or rec.get("rebasedSHA")
           or st.get("finalSHA") or st.get("head"))
    v = verdict_from_current_status(status, rec, running=running)
    last = parse_pkt(st.get("endPKT") or st.get("reclassifiedPKT") or rec.get("linkedPKT"))
    starts = [parse_pkt(st.get("startPKT"))]
    codex = st.get("codex") if isinstance(st.get("codex"), list) else []
    for c in codex:
        if isinstance(c, dict):
            starts.append(parse_pkt(c.get("codexStartPKT") or c.get("startPKT")))
            last = max(filter(None, [last, parse_pkt(c.get("codexEndPKT") or c.get("codexStartPKT"))]), default=last)
    start = min([x for x in starts if x], default=None)
    latest_codex = next((c for c in reversed(codex) if isinstance(c, dict)), None) or {}
    phase = {"running": "running", "failed": "failed", "rejected": "rejected",
             "pending_qa": "pending_qa", "passed": "gated", "queued": "pending",
             "pending": "pending"}.get(v["key"], v["key"])
    return {
        "issue": issue,
        "phase": phase,
        "status": status,
        "model": latest_codex.get("model") or (st.get("codex") or {}).get("model") if isinstance(st.get("codex"), dict) else latest_codex.get("model"),
        "effort": latest_codex.get("effort"),
        "failedGate": "differential" if v["key"] == "failed" else None,
        "finalSHA": short(sha, 12) if sha else None,
        "sourceSHA": short(st.get("oldInvalidResult") or st.get("mergeBase"), 12),
        "changedFiles": None,
        "changedPaths": [],
        "fixed": v["key"] in PASSED_VERDICTS,
        "gated": v["key"] in PASSED_VERDICTS,
        "running": running,
        "currentStep": "complete_unit" if running and "GATES" in str(status or "") else (
            "codex" if running else None),
        "gates": gates_from_current(status, rec, sha, run=run),
        "runs": [],
        "start": start,
        "last": last or start,
        "currentRun": run,
        "currentSource": "rebase-1906-1110/status.json",
        "liveVerdict": v,
        "reclassify": compact_reclassify(rec) if rec else None,
        "reclassifyVerdict": rec.get("verdict") if rec else None,
        "attempts": attempts or attempts_from_status_task(st),
        "flag": flag,
        "onDevelopTip": st.get("onDevelopTip"),
        "contains0c6245c": st.get("contains0c6245c"),
        "securityHold": st.get("securityHold"),
        "mode": st.get("mode") or st.get("transplant"),
    }


def find_current_status_dir(entries):
    """Prefer rebase-1906-1110 among run directory names."""
    names = [n for n in entries or [] if CURRENT_STATUS_DIR_RE.search(n)]
    if not names:
        return None
    # Prefer the exact 1110 retarget directory, then the lexicographically latest.
    exact = [n for n in names if "1906-1110" in n or n.endswith("1906-1110")]
    return sorted(exact or names)[-1]


def load_current_sources(run_dir, read_json, mtime, isfile, join):
    """Load status.json + reclassify-baseline1110.json + flags.json from a run dir."""
    status_path = join(run_dir, "status.json")
    reclass_path = join(run_dir, "reclassify-baseline1110.json")
    flags_path = join(run_dir, "flags.json")
    status = read_json(status_path) if isfile(status_path) else None
    reclass = read_json(reclass_path) if isfile(reclass_path) else None
    flags = read_json(flags_path) if isfile(flags_path) else None
    as_of = None
    for path in (status_path, reclass_path, flags_path):
        if isfile(path):
            as_of = max(filter(None, [as_of, mtime(path), parse_pkt((status or {}).get("startPKT") if path.endswith("status.json") else None)]), default=as_of)
    # Prefer the newest task end / reclassified timestamp inside status.json.
    if isinstance(status, dict):
        as_of = max(filter(None, [as_of, parse_pkt(status.get("startPKT"))]), default=as_of)
        for t in (status.get("tasks") or {}).values():
            if isinstance(t, dict):
                for k in ("endPKT", "reclassifiedPKT"):
                    as_of = max(filter(None, [as_of, parse_pkt(t.get(k))]), default=as_of)
                for c in (t.get("codex") if isinstance(t.get("codex"), list) else []):
                    if isinstance(c, dict):
                        as_of = max(filter(None, [as_of, parse_pkt(c.get("codexEndPKT") or c.get("codexStartPKT"))]), default=as_of)
        as_of = max(filter(None, [as_of, parse_pkt((reclass or {}).get("atPKT") if isinstance(reclass, dict) else None)]), default=as_of)
        bl = status.get("baseline") if isinstance(status.get("baseline"), dict) else {}
        as_of = max(filter(None, [as_of, parse_pkt(bl.get("loadedPKT")), parse_pkt(status.get("retargetFa2004e2PKT"))]), default=as_of)
    return {
        "status": status if isinstance(status, dict) else None,
        "reclassify": reclass if isinstance(reclass, dict) else None,
        "flags": flags,
        "dataAsOf": as_of,
        "statusMtime": mtime(status_path) if isfile(status_path) else None,
        "reclassifyAt": parse_pkt((reclass or {}).get("atPKT")) if isinstance(reclass, dict) else None,
    }



def baseline_from_status(status, run_name=None):
    """Normalize rebase status.baseline (including the fa2004e2 empty-after tip)."""
    raw = (status or {}).get("baseline") if isinstance(status, dict) else None
    if not isinstance(raw, dict):
        return None
    sha = raw.get("sha") or raw.get("baseSHA")
    if not sha:
        return None
    failed = raw.get("numFailedTests")
    if failed is None:
        failed = raw.get("unitFailedCount")
    loaded = parse_pkt(raw.get("loadedPKT") or raw.get("endedPKT") or raw.get("endPKT"))
    return {
        "run": run_name or "develop-tip",
        "baseSHA": short(sha, 8),
        "sha": sha,
        "from": raw.get("from"),
        "complete": bool(raw.get("complete")) or raw.get("numPassedTests") is not None,
        "numPassedTests": raw.get("numPassedTests"),
        "numFailedTests": failed,
        "unitFailedCount": raw.get("unitFailedCount") if raw.get("unitFailedCount") is not None else failed,
        "unitFailures": list(raw.get("unitFailures") or [])[:40],
        "loadedAt": loaded,
        "end": loaded,
        "start": loaded,
        "status": raw.get("status") or ("COMPLETE" if raw.get("complete") else "PENDING"),
    }


def apply_current_overlay(batch, run_name, sources, load_issue_attempts=None):
    """Replace per-task gates/verdicts with rebase-1906-1110 status + reclassify.

    Historical runs stay attached but are marked superseded and must not drive
    KPIs, the pipeline or today's counts.
    """
    status = (sources or {}).get("status") or {}
    reclass = (sources or {}).get("reclassify") or {}
    flags = flags_by_issue((sources or {}).get("flags"))
    rec_tasks = reclass.get("tasks") if isinstance(reclass.get("tasks"), dict) else {}
    st_tasks = status.get("tasks") if isinstance(status.get("tasks"), dict) else {}
    existing = {t["issue"]: t for t in (batch.get("tasks") or []) if isinstance(t, dict) and t.get("issue")}
    issues = sorted(set(st_tasks) | set(rec_tasks) | set(existing))
    out = []
    current_codex = 0
    for issue in issues:
        st = st_tasks.get(issue) or {}
        rec = rec_tasks.get(issue)
        attempts = None
        if load_issue_attempts:
            attempts = load_issue_attempts(issue)
        if not attempts and st:
            attempts = attempts_from_status_task(st)
        overlay = task_from_current_status(issue, st, rec, flags.get(issue), attempts, run=run_name) if (st or rec) else None
        prev = existing.get(issue)
        if overlay is None:
            # Task only exists on a superseded run — keep it but tag it.
            if prev:
                prev = dict(prev)
                prev["superseded"] = True
                prev["currentRun"] = None
                for r in prev.get("runs") or []:
                    if isinstance(r, dict):
                        r["superseded"] = True
                        r["historical"] = True
                out.append(prev)
            continue
        # Count current-run Codex jobs (each status.codex entry).
        codex = st.get("codex") if isinstance(st.get("codex"), list) else []
        current_codex += sum(1 for c in codex if isinstance(c, dict))
        if prev:
            hist_runs = []
            for r in prev.get("runs") or []:
                if not isinstance(r, dict):
                    continue
                r = dict(r)
                cls = classify_run(r.get("run") or "")
                if cls.get("current"):
                    r["current"] = True
                    r["superseded"] = False
                else:
                    r["current"] = False
                    r["superseded"] = True
                    r["historical"] = True
                    r["supersededReason"] = cls.get("supersededReason") or "superseded by rebase-1906-1110"
                hist_runs.append(r)
            # Synthesize a current run record so the live lane is visible.
            current_rec = {
                "run": run_name, "kind": "rebase", "status": overlay["status"],
                "norm": "RUNNING" if overlay["running"] else (
                    "FAIL" if overlay["liveVerdict"]["key"] == "failed" else
                    "PASS" if overlay["liveVerdict"]["key"] in ("pending_qa", "passed") else "PENDING"),
                "start": overlay.get("start"), "last": overlay.get("last"),
                "end": None if overlay["running"] else overlay.get("last"),
                "current": True, "superseded": False,
                "newSourceSHA": overlay.get("finalSHA"),
                "sourceSHA": overlay.get("sourceSHA"),
                "model": overlay.get("model"), "effort": overlay.get("effort"),
                "steps": [], "subGates": [],
            }
            overlay["runs"] = hist_runs + [current_rec]
            # Keep titles / merge fields if the server already set them (collector won't have them).
            for k in ("title", "changedPaths", "changedFiles"):
                if prev.get(k) and not overlay.get(k):
                    overlay[k] = prev[k]
        overlay["superseded"] = False
        out.append(overlay)
    batch["tasks"] = out
    batch["counts"] = counts_from_verdicts(out)
    # "fixed" in counts is only real passed/merged/done verdicts (never the old Codex-changed-files flag).
    batch["currentRun"] = run_name
    batch["currentSource"] = f"{run_name}/status.json"
    batch["reclassifySource"] = f"{run_name}/reclassify-baseline1110.json"
    batch["dataAsOf"] = sources.get("dataAsOf") or sources.get("statusMtime")
    batch["currentCodexJobs"] = current_codex
    tip_base = baseline_from_status(status, run_name)
    if tip_base:
        existing_bases = list(batch.get("baselines") or ([] if not batch.get("baseline") else [batch["baseline"]]))
        merged = False
        out = []
        for b in existing_bases:
            if not isinstance(b, dict):
                continue
            if sha_matches(b.get("baseSHA") or b.get("sha"), tip_base.get("sha")):
                rich = dict(b)
                for k, v in tip_base.items():
                    if k in ("numPassedTests", "numFailedTests", "unitFailedCount") and v is None and rich.get(k) is not None:
                        continue
                    if k == "run" and str(rich.get("run") or "").startswith("baseline-") and not str(v or "").startswith("baseline-"):
                        continue
                    if k == "complete":
                        rich[k] = bool(rich.get(k) or v or rich.get("numPassedTests") is not None)
                        continue
                    if v not in (None, [], ""):
                        rich[k] = v
                out.append(rich)
                merged = True
            else:
                out.append(b)
        if not merged:
            out.insert(0, tip_base)
        batch["baselines"] = out
        # Leave batch["baseline"] to pick_current_baseline so a complete same-SHA
        # record (baseline-1110) is not replaced by a status.json pointer.
    if isinstance(reclass.get("summary"), dict):
        batch["reclassifySummary"] = {
            k: reclass["summary"].get(k) for k in ("verdicts", "statusAfter", "counts", "n")
            if k in reclass["summary"]
        }
        batch["reclassifySummary"]["realNewFailures"] = (reclass["summary"].get("realNewFailures") or [])[:20]
        batch["reclassifySummary"]["passedAll"] = reclass["summary"].get("passedAll") or []
    return batch


def tag_event(event, run=None):
    """Mark an event current or superseded from its run name."""
    ev = dict(event)
    name = run or ev.get("run") or ""
    cls = classify_run(name)
    ev["current"] = bool(cls.get("current"))
    ev["superseded"] = bool(cls.get("superseded") or (cls.get("historical") and not cls.get("current")))
    ev["historical"] = bool(cls.get("historical"))
    if ev["superseded"] and cls.get("supersededReason"):
        ev["supersededReason"] = cls["supersededReason"]
    # Baseline-1110 and rebase-1906 are current; codex-1110 / gates-1110 / rebase-1110 are not.
    if CURRENT_STATUS_DIR_RE.search(name) or str(name).startswith("baseline-1110") or ev.get("kind") == "baseline" and "1110" in str(name):
        ev["current"] = True
        ev["superseded"] = False
    return ev


def is_current_event(ev):
    if not isinstance(ev, dict):
        return False
    if ev.get("superseded") or ev.get("archived"):
        return False
    if ev.get("current") is False:
        return False
    return True


def _first(src, *keys):
    for key in keys:
        cur = src
        ok = True
        for part in str(key).split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, "", {}, []):
            return cur
    return None


def compact_develop_lane(policy, status=None, target=None):
    """Fast-forward merge of fa2004e2 (or later) plus the outstanding Azure deploy gate."""
    policy = policy if isinstance(policy, dict) else {}
    status = status if isinstance(status, dict) else {}
    src = dict(status)
    src.update({k: policy[k] for k in policy})
    merge_sha = _first(src, "developMergeSHA", "approvedForMerge", "finalGreenSHA", "sha") or target
    if not merge_sha:
        return None
    prev = _first(src, "developPreviousTip", "previousTip", "previousDevelopTip", "fromTip", "previousSHA")
    merged_raw = _first(src, "developMergePKT", "developMergedAt", "mergedAtPKT", "mergedAt", "mergedPKT")
    method = _first(src, "developMergeMethod", "method", "mergeMethod") or "fast-forward"
    gate = _first(src, "deployGate", "qaPolicy.deployGate", "azureDeployGate") or {}
    if not isinstance(gate, dict):
        gate = {"status": gate}
    auto = src.get("autoDeployCheck") if isinstance(src.get("autoDeployCheck"), dict) else {}
    return {
        "sha": merge_sha,
        "short": short(merge_sha, 8),
        "previousTip": prev,
        "previousShort": short(prev, 8),
        "mergedAt": parse_pkt(merged_raw),
        "mergedAtPkt": merged_raw if isinstance(merged_raw, str) else None,
        "method": method,
        "merged": bool(src.get("mergedIntoDevelop") or merge_sha),
        "reason": src.get("reason"),
        "deployGate": {
            "name": "Azure deploy gate",
            "status": str(gate.get("status") or "PENDING").upper(),
            "check": gate.get("check") or "Azure OpenAI token fetch and Azure Blob evidence",
            "note": gate.get("note") or gate.get("summary"),
            "required": bool(gate.get("requiredBeforeAnyDeploy", True)),
        },
        "autoDeployCheck": {
            "result": auto.get("result"),
            "checkedAt": auto.get("checkedPKT"),
            "summary": auto.get("summary"),
        } if auto else None,
    }


def pkt_clock(ts):
    if not ts:
        return None
    pkt = timezone(timedelta(hours=5))
    return datetime.fromtimestamp(float(ts), tz=pkt).strftime("%H:%M:%S")


def develop_merge_event(lane, batch_id=None):
    if not lane or not lane.get("mergedAt"):
        return None
    sha = lane.get("short") or short(lane.get("sha"), 8)
    prev = lane.get("previousShort") or "previous tip"
    clock = pkt_clock(lane["mergedAt"])
    when = f" at {clock} PKT" if clock else ""
    return {
        "ts": lane["mergedAt"],
        "batch": batch_id,
        "kind": "merge",
        "level": "ok",
        "run": "develop",
        "current": True,
        "superseded": False,
        "sha": lane.get("sha"),
        "text": f"develop moved to {sha}{when} ({lane.get('method') or 'fast-forward'} from {prev})",
    }

