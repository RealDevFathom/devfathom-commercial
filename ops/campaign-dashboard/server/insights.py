"""Deterministic warning / suggestion rules over the merged dashboard state (stdlib only).

These run on every /api/state build, cost nothing, and are also handed to the AI analysis as
grounding. Every finding carries a severity, an area (which screen shows it), a reason and
evidence links (dashboard hash routes such as `#task=<batch>/<issue>`).

Everything here is read-only: findings are advice for humans, never actions.
"""

import re
import time
from urllib.parse import quote

GiB = 1024 ** 3
STALL_CODEX_SEC = 3 * 3600
STALL_STEP_SEC = 90 * 60
LEDGER_STALE_SEC = 15 * 60
IDLE_TASK_SEC = 24 * 3600
READY_TO_MERGE_SEC = 6 * 3600
TEST_DROP_TOLERANCE = 5
GUARD_PATTERNS = [
    (re.compile(r"(^|/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$"), "test file"),
    (re.compile(r"(^|/)(__tests__|tests?|e2e)/"), "test directory"),
    (re.compile(r"(^|/)(vitest|jest|playwright)[^/]*\.config\.[cm]?[jt]s$"), "test runner config"),
    (re.compile(r"(^|/)vitest\.(setup|server-only)[^/]*$"), "test setup"),
    (re.compile(r"(^|/)(eslint\.config\.[cm]?js|\.eslintrc[^/]*)$"), "lint config"),
    (re.compile(r"(^|/)tsconfig[^/]*\.json$"), "TypeScript config"),
    (re.compile(r"(^|/)\.github/workflows/"), "CI workflow"),
    (re.compile(r"(^|/)(middleware|proxy)\.[jt]s$"), "request guard"),
    (re.compile(r"(^|/)[^/]*(auth|permission|capabilit|guard|policy|rbac)[^/]*\.[jt]sx?$", re.I), "auth / capability guard"),
]


def link_task(batch, issue):
    return f"#task={quote(str(batch), safe='')}/{quote(str(issue), safe='')}"


def link_run(batch, run):
    return f"#run={quote(str(batch), safe='')}/{quote(str(run), safe='')}"


def _ev(label, link):
    return {"label": str(label)[:120], "link": link}


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def guard_hits(paths):
    hits = []
    for p in paths or []:
        for rx, kind in GUARD_PATTERNS:
            if rx.search(p):
                hits.append((p, kind))
                break
    return hits


def rule_insights(state, now=None):
    now = now or time.time()
    out = []

    def add(kind, severity, area, key, title, reason, evidence=None, batch=None, issue=None):
        out.append({"id": f"rule:{key}", "kind": kind, "severity": severity, "area": area, "title": title,
                    "reason": reason, "evidence": (evidence or [])[:8], "batch": batch, "issue": issue,
                    "source": "rules"})

    batches = state.get("batches") or []
    by_id = {b.get("id"): b for b in batches}
    codex = state.get("codex") or {}
    worker = state.get("worker") or {}
    sysm = worker.get("system") or {}
    usage = worker.get("usage") or {}
    limits = state.get("limits") or {}

    # --- stalled Codex jobs
    for j in codex.get("active") or []:
        start = _num(j.get("start"))
        if start and now - start > STALL_CODEX_SEC:
            add("warning", "warn", "now", f"stall-codex:{j.get('batch')}:{j.get('issue')}",
                f"{j.get('issue')} Codex job running {int((now - start) // 3600)} h",
                f"Codex has been on {j.get('issue')} since {_hm(start)} PKT ({j.get('status')}, step {j.get('step') or 'coding'}) — "
                "longer than 3 h usually means it is looping or waiting on something.",
                [_ev(f"{j.get('issue')} task", link_task(j.get("batch"), j.get("issue")))], j.get("batch"), j.get("issue"))

    # --- long-running machine steps
    for g in (state.get("now") or {}).get("gates") or []:
        start = _num(g.get("start"))
        if start and now - start > STALL_STEP_SEC:
            add("warning", "warn", "now", f"stall-step:{g.get('batch')}:{g.get('issue')}:{g.get('run')}",
                f"{g.get('issue')} {g.get('step') or g.get('kind')} running {int((now - start) // 60)} min",
                f"Step {g.get('step')} in {g.get('run')} started {_hm(start)} PKT and has not finished.",
                [_ev(f"{g.get('issue')} task", link_task(g.get("batch"), g.get("issue"))), _ev(g.get("run"), link_run(g.get("batch"), g.get("run")))],
                g.get("batch"), g.get("issue"))

    for b in batches:
        bid = b.get("id")
        tasks = b.get("tasks") or []
        # --- ledger not updating while the batch claims active work
        if b.get("active"):
            newest = max([_num(l.get("mtime")) or 0 for l in b.get("ledgers") or []] or [0])
            if newest and now - newest > LEDGER_STALE_SEC:
                add("warning", "warn", "batches", f"ledger-stale:{bid}", f"{b.get('label') or bid}: ledger not updated for {int((now - newest) // 60)} min",
                    f"The batch reports {b.get('active')} active jobs but its ledger was last written {_hm(newest)} PKT; the runner may have stopped.",
                    [_ev(b.get("label") or bid, f"#batch={quote(str(bid), safe='')}")], bid)

        gate_fail_tasks = {}
        idle, ready, unclosed, blocked = [], [], [], []
        base = b.get("baseline") or {}
        base_passed = _num(base.get("numPassedTests"))
        for t in tasks:
            issue = t.get("issue")
            runs = t.get("runs") or []
            # --- repeated gate failures on the same task
            fails = {}
            for r in runs:
                for s in r.get("steps") or []:
                    if s.get("status") == "FAIL":
                        fails.setdefault(s.get("gate"), set()).add(r.get("run"))
            for gate, rs in fails.items():
                gate_fail_tasks.setdefault(gate, []).append(issue)
                if len(rs) >= 2:
                    add("warning", "warn", "batches", f"repeat-fail:{bid}:{issue}:{gate}", f"{issue}: {gate} failed in {len(rs)} runs",
                        f"{gate} failed again across {', '.join(sorted(rs))}. Another attempt with the same approach is unlikely to pass.",
                        [_ev(f"{issue} task", link_task(bid, issue))] + [_ev(r, link_run(bid, r)) for r in sorted(rs)][:3], bid, issue)
            # --- weakened tests / guards
            hits = guard_hits(t.get("changedPaths"))
            if hits:
                kinds = sorted({k for _, k in hits})
                add("warning", "warn", "batches", f"guards:{bid}:{issue}", f"{issue} changes {', '.join(kinds)}",
                    "The fix touches " + ", ".join(p for p, _ in hits[:4]) + (" …" if len(hits) > 4 else "") +
                    ". Review that tests, lint rules or guards were not weakened to make gates pass.",
                    [_ev(f"{issue} task", link_task(bid, issue))], bid, issue)
            unit = (t.get("gates") or {}).get("complete_unit") or {}
            if base_passed and _num(unit.get("passed")) is not None and unit["passed"] < base_passed - TEST_DROP_TOLERANCE:
                add("warning", "crit", "batches", f"tests-drop:{bid}:{issue}", f"{issue}: {base_passed - unit['passed']} fewer passing tests than baseline",
                    f"complete_unit passed {unit['passed']} tests vs {base_passed} on the baseline. Tests may have been deleted or skipped.",
                    [_ev(f"{issue} task", link_task(bid, issue)), _ev("baseline", link_run(bid, base.get("run") or "baseline"))], bid, issue)
            # --- Codex doing machine checks itself
            for r in runs:
                if r.get("kind") != "codex":
                    continue
                cs, ce = _num(r.get("codexStart")), _num(r.get("codexEnd"))
                inside = [s for s in r.get("steps") or [] if _num(s.get("start")) and cs and s["start"] >= cs and (ce is None or s["start"] < ce)]
                if inside and (ce is not None or "CODEX_RUNNING" in str(r.get("status") or "").upper()):
                    add("warning", "warn", "now", f"codex-checks:{bid}:{issue}:{r.get('run')}", f"{issue}: Codex appears to run machine checks itself",
                        f"Steps {', '.join(s['name'] for s in inside[:4])} started while Codex was still coding. Gates should run in the harness after Codex exits.",
                        [_ev(f"{issue} task", link_task(bid, issue))], bid, issue)
                    break
            phase = t.get("phase")
            last = _num(t.get("last"))
            if phase not in ("done", "pending", "running") and last and now - last > IDLE_TASK_SEC:
                idle.append(t)
            if t.get("gated") and not t.get("merged") and last and now - last > READY_TO_MERGE_SEC:
                ready.append(t)
            if t.get("merged") and not t.get("done") and t.get("gated"):
                unclosed.append(t)
            if phase == "blocked":
                blocked.append(t)
        label = b.get("label") or bid
        if idle:
            add("warning", "warn", "batches", f"idle:{bid}", f"{label}: {len(idle)} tasks not moving for >24 h",
                "No new runs or step results for: " + ", ".join(t["issue"] for t in idle[:8]) + (" …" if len(idle) > 8 else ""),
                [_ev(t["issue"], link_task(bid, t["issue"])) for t in idle[:6]], bid)
        for gate, issues in gate_fail_tasks.items():
            if len(issues) >= 3:
                add("suggestion", "warn", "batches", f"common-fail:{bid}:{gate}", f"{gate} failing on {len(issues)} tasks in {label}",
                    f"The same gate fails across {', '.join(issues[:6])}. Look for a shared cause (baseline drift, harness, flaky test) before retrying tasks one by one.",
                    [_ev(i, link_task(bid, i)) for i in issues[:6]], bid)
        if blocked:
            add("suggestion", "warn", "batches", f"blocked:{bid}", f"Unblock {len(blocked)} tasks in {label}",
                "These stopped on a harness or precondition blocker, not a code failure; fixing the precondition should release them together.",
                [_ev(t["issue"], link_task(bid, t["issue"])) for t in blocked[:6]], bid)
        if ready:
            add("suggestion", "info", "next", f"ready:{bid}", f"{len(ready)} gated tasks waiting to merge in {label}",
                "All required gates pass on the final SHA but no merge into develop has been seen for over 6 h.",
                [_ev(t["issue"], link_task(bid, t["issue"])) for t in ready[:6]], bid)
        if unclosed:
            add("suggestion", "info", "history", f"unclosed:{bid}", f"{len(unclosed)} merged tasks still have open issues",
                "Merged and gated, but the GitHub and/or Linear issue is not closed yet.",
                [_ev(t["issue"], link_task(bid, t["issue"])) for t in unclosed[:6]], bid)

    # --- machine pressure (earlier than the hard alerts)
    mem = _num((sysm.get("mem") or {}).get("pct"))
    if mem is not None and mem >= 85:
        add("warning", "crit" if mem >= 92 else "warn", "machine", "ram", f"RAM at {mem:.0f}%",
            "Memory is close to exhaustion; parallel gate runs may start failing or swapping.", [_ev("RAM history", "#metric=memPct")])
    psi_mem = (((sysm.get("psi") or {}).get("memory") or {}).get("full") or {}).get("avg10")
    if _num(psi_mem) and psi_mem > 5:
        add("warning", "warn", "machine", "psi-mem", f"Memory stall pressure {psi_mem:.1f}%",
            "PSI memory 'full' shows tasks completely stalled on memory.", [_ev("RAM history", "#metric=memPct")])
    for path, d in (sysm.get("disks") or {}).items():
        pct = _num(d.get("pct"))
        field = "workspacePct" if path == "/workspace" else "scratchPct"
        if pct is not None and 75 <= pct <= limits.get("diskAlert", 85):
            add("warning", "warn", "machine", f"disk-soon:{path}", f"{path} at {pct:.0f}% — approaching the 85% line",
                "Clean up finished run directories before the disk alert fires.", [_ev(f"{path} history", f"#metric={field}")])
        if path == "/workspace" and _num(d.get("freeBytes")) is not None:
            head = d["freeBytes"] - limits.get("reserveBytes", 200 * GiB)
            if 0 <= head < 100 * GiB:
                add("warning", "warn", "machine", "reserve-soon", f"/workspace only {head / GiB:.0f} GiB above the reserve",
                    "Headroom over the 200 GiB reserve is shrinking.", [_ev("/workspace history", "#metric=workspacePct")])

    # --- budget / usage
    pct = _num(usage.get("weeklyPct"))
    if pct is not None and 85 <= pct < limits.get("usageStop", 95):
        add("warning", "warn", "overview", "usage-soon", f"Weekly usage {pct:.0f}% — nearing the 95% stop line",
            "Plan the remaining work: the owner usage cutoff stops Codex at 95%.", [_ev("usage", "#usage")])
    for w in (state.get("box") or {}).get("workers") or []:
        price, cap = _num(w.get("spotPrice")), limits.get("spotCap", 2.5)
        if price is not None and 0.8 * cap <= price <= cap:
            add("warning", "warn", "machine", f"spot-soon:{w.get('instanceId')}", f"Spot price ${price:.2f}/h near the ${cap:.2f} cap",
                "Spot price is within 20% of the cap; an interruption or cap breach is more likely.", [_ev("workers", "#workers")])

    # --- capacity
    queue = (state.get("next") or {}).get("queue") or []
    active, cap = codex.get("activeCount") or 0, codex.get("cap") or 50
    if queue and active < cap * 0.5 and not usage.get("stopActive"):
        add("suggestion", "info", "next", "capacity", f"{len(queue)} queued tasks with Codex at {active}/{cap}",
            "There is spare Codex capacity while tasks wait in the queue.", [_ev(q["issue"], link_task(q["batch"], q["issue"])) for q in queue[:5]])

    order = {"crit": 0, "warn": 1, "info": 2}
    out.sort(key=lambda f: (order.get(f["severity"], 3), f["kind"] != "warning"))
    return out[:120]


def _hm(ts):
    t = time.gmtime(ts + 5 * 3600)
    return f"{t.tm_mday} {time.strftime('%b', t)} {t.tm_hour:02d}:{t.tm_min:02d}"
