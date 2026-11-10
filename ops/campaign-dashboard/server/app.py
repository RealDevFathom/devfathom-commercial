#!/usr/bin/env python3
"""DevFathom campaign ops dashboard server (Python 3.12 stdlib only, read-only UI).

Routes
  GET  /healthz                 -> "ok" (no auth)
  GET  /, /static/*, /api/state -> HTTP Basic (DASH_USER / DASH_PASSWORD)
  POST /api/ingest/<source>     -> Bearer INGEST_TOKEN, source in {worker, box}
  GET  /api/known-issues        -> Bearer INGEST_TOKEN; issue ids seen by the worker (for the box
                                   collector's read-only Linear lookup)

Environment: DASH_USER (default "ops"), DASH_PASSWORD, INGEST_TOKEN, DATA_DIR (default /tmp/dash),
PORT (default 8080), TRUST_PROXY=1 to rate-limit on the left-most X-Forwarded-For address.
"""

import base64
import hmac
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sanitize import sanitize  # noqa: E402
from ai import AIError, AIService  # noqa: E402
from insights import rule_insights  # noqa: E402
from truth import (  # noqa: E402
    annotate_baseline, annotate_services, counts_from_verdicts, inky_usage_from_box,
    is_archived_batch, is_current_event, pick_current_baseline, previous_complete_baseline,
    stub_baseline_for_tip, verdict_from_current_status, develop_merge_event,
    campaign_pause_from_stops,
)
from s3util import S3Backup  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "icons.svg": "image/svg+xml",
    "fonts/Geist-Variable.woff2": "font/woff2",
    "fonts/GeistMono-Variable.woff2": "font/woff2",
    "fonts/Geist-OFL.txt": "text/plain; charset=utf-8",
    "fonts/Phosphor-MIT.txt": "text/plain; charset=utf-8",
}
LONG_CACHE = {"fonts/Geist-Variable.woff2", "fonts/GeistMono-Variable.woff2"}
SOURCES = ("worker", "box")
MAX_BODY = 8 * 1024 * 1024
MAX_CHAT_BODY = 64 * 1024
STALE_AFTER = 180
FAIL_WINDOW = 300
FAIL_LIMIT = 10
SPOT_CAP = 2.50
USAGE_STOP = 95.0
DISK_ALERT = 85.0
RESERVE_BYTES = 200 * 1024 ** 3
REQUIRED_GATES = ("prisma", "typecheck", "lint", "complete_unit", "host_build", "docker")
PIPELINE = REQUIRED_GATES + ("final_sha", "merged", "gh", "linear")
MAX_EVENTS = 1500


META_GATES = {"merged", "linear", "gh", "final_sha", "differential"}
GATE_NAMES = {"prisma": "Prisma", "typecheck": "Typecheck", "lint": "Lint", "complete_unit": "Unit", "host_build": "Build",
              "docker": "Docker", "differential": "Differential", "qa_browser": "QA", "security": "Security"}


def verdict(t):
    """The single truthful status for a task (mirrored in the UI and given to Claude).

    PASSED/MERGED/DONE only when every required gate passed on the exact final SHA and nothing failed.
    Any failed gate (complete_unit counts unless the differential vs baseline passes) is FAILED and named.
    Baseline-only (pending QA/Security) and assertion-guard rejections come from the current
    rebase-1906 / reclassify status and must not be reported as failed.
    """
    live = t.get("liveVerdict") if isinstance(t.get("liveVerdict"), dict) else None
    if not live and (t.get("currentRun") or t.get("currentSource")):
        live = verdict_from_current_status(t.get("status"), t.get("reclassify"), running=bool(t.get("running")))
    if live and live.get("key") == "running":
        step = t.get("currentStep")
        return {"key": "running", "label": live.get("label") or (
            f"Running {GATE_NAMES.get(step, step)}" if step else "Running"), "status": live.get("status")}
    if live and live.get("key") in ("pending_qa", "rejected", "queued"):
        return live
    if live and live.get("key") == "failed":
        return live
    if live and live.get("key") == "passed":
        # Fall through so merge / done can upgrade a real pass.
        t = dict(t)
        t["gated"] = True
        g = dict(t.get("gates") or {})
        g.setdefault("final_sha", {"status": "PASS"})
        t["gates"] = g
    g = t.get("gates") or {}
    diff_pass = (g.get("differential") or {}).get("status") == "PASS"
    fails = [k for k, v in g.items() if k not in META_GATES and isinstance(v, dict) and v.get("status") == "FAIL"
             and not (k == "complete_unit" and diff_pass)]
    if (g.get("differential") or {}).get("status") == "FAIL":
        fails.append("differential")
    blocked = [k for k, v in g.items() if k not in META_GATES and isinstance(v, dict) and v.get("status") == "BLOCKED"]
    on_final = (g.get("final_sha") or {}).get("status") == "PASS"
    passed = bool(t.get("gated")) and on_final and not fails and not blocked
    name = lambda ks: ", ".join(GATE_NAMES.get(k, k) for k in ks)  # noqa: E731
    if t.get("running"):
        step = t.get("currentStep")
        return {"key": "running", "label": f"Running {GATE_NAMES.get(step, step)}" if step else "Running"}
    if fails:
        return {"key": "failed", "label": f"Failed: {name(fails)}", "gates": fails}
    if blocked or t.get("phase") == "blocked":
        return {"key": "blocked", "label": f"Blocked: {name(blocked)}" if blocked else "Blocked", "gates": blocked}
    if passed and t.get("done"):
        return {"key": "done", "label": "Done"}
    if passed and t.get("merged"):
        return {"key": "merged", "label": "Merged"}
    if passed:
        return {"key": "passed", "label": "Passed on final SHA"}
    if t.get("phase") == "failed":
        fg = t.get("failedGate")
        return {"key": "failed", "label": f"Failed: {GATE_NAMES.get(fg, fg)}" if fg else "Failed: Codex", "gates": [fg] if fg else ["codex"]}
    if t.get("phase") == "pending":
        return {"key": "queued", "label": "Queued"}
    if t.get("fixed"):
        return {"key": "gates", "label": "Awaiting gates"}
    return {"key": "pending", "label": "Pending"}


def _sha_match(a, b):
    a, b = (a or "").lower(), (b or "").lower()
    n = min(len(a), len(b))
    return n >= 7 and a[:n] == b[:n]


def match_merge(candidates, final_sha, since):
    """Pick the PR that merged THIS task's final SHA into develop during the campaign.

    Returns (merge, mismatch): merge is set only for a verified match; mismatch describes the newest
    PR that references the issue but merged a different SHA, merged before the campaign, or has no head SHA.
    """
    verified, mismatch = None, None
    for pr in sorted(candidates, key=lambda p: p.get("mergedAt") or 0, reverse=True):
        head = pr.get("headSha")
        info = {k: pr.get(k) for k in ("number", "title", "mergedAt", "sha", "headSha")}
        if since and (pr.get("mergedAt") or 0) < since:
            mismatch = mismatch or dict(info, reason="merged before this batch started")
        elif not head:
            mismatch = mismatch or dict(info, reason="PR head SHA unknown (box collector too old)")
        elif not final_sha or not (_sha_match(head, final_sha) or _sha_match(pr.get("sha"), final_sha)):
            mismatch = mismatch or dict(info, reason=f"PR merged {str(head)[:10]}, task final SHA is {str(final_sha or 'unknown')[:10]}")
        elif verified is None:
            verified = info
    return verified, (None if verified else mismatch)


def next_gate(gates):
    """First pipeline step (gates -> merge -> closure) that has not passed yet."""
    for key in PIPELINE:
        st = (gates.get(key) or {}).get("status") or "PENDING"
        if key == "complete_unit" and (gates.get("differential") or {}).get("status") == "PASS":
            continue
        if st in ("PASS", "SKIP"):
            continue
        return key, st
    return None, None

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                               "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
                               "form-action 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def log(msg):
    print(f"[dash] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- storage

class Store:
    def __init__(self, data_dir, backup=None):
        self.data_dir = data_dir
        self.backup = backup
        self.lock = threading.Lock()
        self.data = {}
        try:
            os.makedirs(data_dir, exist_ok=True)
        except OSError as exc:
            log(f"cannot create DATA_DIR ({type(exc).__name__}); running in-memory only")
        for src in SOURCES:
            rec = self._read_local(src)
            if rec is None and backup:
                rec = backup.get_json(f"{src}.json")
                if rec and isinstance(rec.get("payload"), dict):
                    log(f"hydrated {src} from durable backup")
                    self._write_local(src, rec)
            if isinstance(rec, dict) and isinstance(rec.get("payload"), dict):
                self.data[src] = rec

    def _read_local(self, source):
        try:
            with open(os.path.join(self.data_dir, f"{source}.json")) as fh:
                rec = json.load(fh)
            if isinstance(rec, dict) and isinstance(rec.get("payload"), dict):
                return rec
        except (OSError, ValueError):
            pass
        return None

    def _write_local(self, source, rec):
        try:
            fd, tmp = tempfile.mkstemp(dir=self.data_dir, prefix=f".{source}.")
            with os.fdopen(fd, "w") as fh:
                json.dump(rec, fh, separators=(",", ":"))
            os.replace(tmp, os.path.join(self.data_dir, f"{source}.json"))
            return True
        except OSError as exc:
            log(f"persist {source} failed ({type(exc).__name__})")
            return False

    def put(self, source, payload, now=None):
        rec = {"receivedAt": now or time.time(), "payload": payload}
        with self.lock:
            self.data[source] = rec
            self._write_local(source, rec)
        if self.backup:
            try:
                self.backup.put_json(f"{source}.json", rec)
            except Exception as exc:  # backup must never break ingest
                log(f"durable persist {source} failed ({type(exc).__name__})")
        return rec

    def snapshot(self):
        with self.lock:
            return dict(self.data)


# --------------------------------------------------------------------------- auth

class RateLimiter:
    def __init__(self, window=FAIL_WINDOW, limit=FAIL_LIMIT):
        self.window, self.limit = window, limit
        self.fails = {}
        self.lock = threading.Lock()

    def blocked(self, ip, now=None):
        now = now or time.time()
        with self.lock:
            hits = [t for t in self.fails.get(ip, []) if now - t < self.window]
            if hits:
                self.fails[ip] = hits
            else:
                self.fails.pop(ip, None)
            return len(hits) >= self.limit

    def fail(self, ip, now=None):
        with self.lock:
            self.fails.setdefault(ip, []).append(now or time.time())
            if len(self.fails) > 10000:  # bound memory under a spray
                self.fails.clear()


def check_basic(header, user, password):
    if not password or not header or not header.startswith("Basic "):
        return False
    try:
        raw = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    got_user, sep, got_pw = raw.partition(":")
    if not sep:
        return False
    ok_user = hmac.compare_digest(got_user.encode(), user.encode())
    ok_pw = hmac.compare_digest(got_pw.encode(), password.encode())
    return ok_user and ok_pw


def check_bearer(header, token):
    if not token or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].strip().encode(), token.encode())


# --------------------------------------------------------------------------- state merge

def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def build_state(snapshot, now=None, ai=None):
    """Merge the latest worker/box payloads into the dashboard view model."""
    now = now or time.time()
    sources = {}
    for src in SOURCES:
        rec = snapshot.get(src)
        if rec:
            age = now - rec["receivedAt"]
            sources[src] = {"receivedAt": rec["receivedAt"], "ageSec": round(age), "stale": age > STALE_AFTER}
        else:
            sources[src] = {"receivedAt": None, "ageSec": None, "stale": True}
    worker = (snapshot.get("worker") or {}).get("payload") or {}
    box = (snapshot.get("box") or {}).get("payload") or {}
    github = box.get("github") or {}
    linear = box.get("linear") or {}
    linear_ok = bool(linear.get("available"))
    lstates = linear.get("states") or {}

    prs_by_issue, titles = {}, {}
    for pr in github.get("merged") or []:
        for issue in pr.get("issues") or []:
            prs_by_issue.setdefault(issue, []).append(pr)
            titles.setdefault(issue, pr.get("title"))
    closed_by_issue = {}
    for it in github.get("closedIssues") or []:
        for issue in it.get("issues") or []:
            closed_by_issue.setdefault(issue, {k: it.get(k) for k in ("number", "title", "closedAt")})
            titles[issue] = it.get("title") or titles.get(issue)
    for issue, st in lstates.items():  # Linear is the source of truth for titles
        if isinstance(st, dict) and st.get("title"):
            titles[issue] = st["title"]

    usage = inky_usage_from_box(box, worker.get("usage"))
    best = {}
    batches = []
    for b in worker.get("batches") or []:
        if not isinstance(b, dict):
            continue
        tasks = []
        for t in b.get("tasks") or []:
            if not isinstance(t, dict) or not isinstance(t.get("issue"), str):
                continue
            issue = t["issue"]
            t = dict(t)
            gates = dict(t.get("gates") or {})
            final_full = t.get("finalSHA")
            merge, mismatch = match_merge(prs_by_issue.get(issue) or [], final_full, b.get("start"))
            gh = closed_by_issue.get(issue)
            lin = lstates.get(issue)
            linear_closed = (lin or {}).get("type") in ("completed", "canceled") if linear_ok else None
            gates["merged"] = {"status": "PASS" if merge else "PENDING",
                               **({"pr": merge["number"], "sha": (merge.get("headSha") or "")[:10]} if merge else {}),
                               **({"note": f"PR #{mismatch['number']} not counted: {mismatch['reason']}"} if mismatch else {})}
            gates["linear"] = {"status": "PASS" if linear_closed else ("PENDING" if linear_ok else "SKIP"),
                               **({"state": lin.get("state")} if lin else {})}
            gates["gh"] = {"status": "PASS" if gh else "PENDING", **({"number": gh["number"]} if gh else {})}
            issues_closed = bool(gh) and (linear_closed if linear_ok else True)
            t["gates"] = gates
            t["title"] = titles.get(issue)
            t["merge"] = merge
            t["mergeMismatch"] = mismatch
            t["ghIssue"] = gh
            t["linear"] = lin
            t["merged"] = bool(merge)
            t["ghClosed"] = bool(gh)
            t["linearClosed"] = linear_closed
            t["done"] = False
            t["done"] = verdict(t)["key"] in ("passed", "merged") and bool(merge) and issues_closed
            t["verdict"] = verdict(t)
            t["nextGate"], t["nextGateStatus"] = (None, None) if t["done"] else next_gate(gates)
            if t["verdict"]["key"] in ("done", "merged", "failed", "pending_qa", "rejected", "running", "queued"):
                t["phase"] = t["verdict"]["key"]
            tasks.append(t)
        b = dict(b)
        b["archived"] = is_archived_batch(b)
        b["tasks"] = tasks
        # Rollups come only from per-task verdicts (PASSED = every required gate on the final SHA).
        counts = dict(b.get("counts") or {})
        counts.update(counts_from_verdicts(tasks))
        b["counts"] = counts
        last = _num(b.get("last")) or 0
        b["historical"] = bool(b["archived"]) or (
            not b.get("active") and not counts["running"] and now - last > 86400)
        if b.get("baseline") or b.get("baselines"):
            policy_tip = (worker.get("develop") or {}).get("sha") or b.get("developTarget")
            tip = policy_tip or github.get("developSha")
            preferred = pick_current_baseline(b.get("baselines") or [b["baseline"]],
                                              (tip[:8] if tip else None),
                                              strict=bool(policy_tip))
            prev = previous_complete_baseline(b.get("baselines") or [b["baseline"]], tip)
            items = list(b.get("baselines") or ([b["baseline"]] if b.get("baseline") else []))
            if preferred is None and tip:
                stub = stub_baseline_for_tip(tip, previous=prev)
                b["baselines"] = [annotate_baseline(x, preferred=False, develop_prefix=tip) for x in items]
                for x in b["baselines"]:
                    x["current"] = False
                    x["historical"] = True
                b["baselines"].insert(0, annotate_baseline(stub, preferred=True, develop_prefix=tip))
                b["baseline"] = b["baselines"][0]
                b["previousBaseline"] = annotate_baseline(prev, preferred=False, develop_prefix=tip) if prev else None
            else:
                b["baselines"] = [annotate_baseline(x, preferred=x is preferred or (
                    preferred and x.get("run") and x.get("run") == preferred.get("run")),
                    develop_prefix=tip)
                    for x in items]
                current = next((x for x in b["baselines"] if x.get("current")), b["baselines"][0] if b["baselines"] else None)
                if current:
                    b["baseline"] = current
                if prev and (not current or not (
                    (current.get("run") and current.get("run") == prev.get("run")) or
                    (current.get("baseSHA") and current.get("baseSHA") == (prev.get("baseSHA") or prev.get("sha")))
                )):
                    b["previousBaseline"] = annotate_baseline(prev, preferred=False, develop_prefix=tip)
        if not b["archived"]:
            for t in tasks:
                issue = t["issue"]
                agg = best.setdefault(issue, {"fixed": False, "gated": False, "merged": False, "linear": False,
                                              "gh": False, "done": False, "failed": False, "verdict": None})
                key = (t.get("verdict") or {}).get("key")
                agg["fixed"] |= key in ("passed", "merged", "done")
                agg["gated"] |= key in ("passed", "merged", "done")
                agg["failed"] |= key == "failed"
                agg["merged"] |= t["merged"]
                agg["linear"] |= bool(t.get("linearClosed"))
                agg["gh"] |= t["ghClosed"]
                agg["done"] |= t["done"]
                agg["verdict"] = t.get("verdict")
        batches.append(b)

    codex = worker.get("codex") or {}
    machine = box.get("machine") or {}
    # Live KPI totals: only non-archived batches, driven by per-task verdicts.
    live_batches = [b for b in batches if not b.get("archived")]
    live_tasks = [t for b in live_batches for t in b.get("tasks") or []]
    live_counts = counts_from_verdicts(live_tasks)
    current = worker.get("current") or {}
    data_as_of = current.get("dataAsOf") or worker.get("dataAsOf") or worker.get("collectedAt")
    if data_as_of is None:
        rec = (snapshot.get("worker") or {}).get("receivedAt")
        data_as_of = rec
    worker_age = sources.get("worker") or {}
    overview = {
        "tasks": live_counts["total"] or len(best),
        "fixed": live_counts["fixed"],
        "failed": live_counts["failed"],
        "gated": live_counts["gated"],
        "merged": sum(1 for v in best.values() if v["merged"]),
        "linearClosed": sum(1 for v in best.values() if v["linear"]) if linear_ok else None,
        "ghClosed": sum(1 for v in best.values() if v["gh"]),
        "done": sum(1 for v in best.values() if v["done"]),
        "pendingQa": live_counts.get("pendingQa") or 0,
        "rejected": live_counts.get("rejected") or 0,
        "running": live_counts.get("running") or 0,
        "queued": live_counts.get("queued") or 0,
        "blocked": live_counts.get("blocked") or 0,
        "codexJobsTotal": current.get("codexJobs") if current.get("codexJobs") is not None else (worker.get("allTime") or {}).get("codexJobsSeen"),
        "codexActive": codex.get("activeCount"),
        "codexCap": codex.get("cap") or 50,
        "machineHours": machine.get("hours"),
        "machineCostUsd": machine.get("costUsd"),
        "usagePct": usage.get("weeklyPct"),
        "usageStopActive": bool(usage.get("stopActive")),
        "batches": len(live_batches),
        "mergedLast30d": len(github.get("merged") or []),
        "currentRun": current.get("run") or next((b.get("currentRun") for b in live_batches if b.get("currentRun")), None),
    }

    events = list(worker.get("events") or [])
    events = [e for e in events if is_current_event(e)]
    for pr in (github.get("merged") or [])[:100]:
        if pr.get("mergedAt"):
            events.append({"ts": pr["mergedAt"], "kind": "merge", "level": "ok", "pr": pr.get("number"),
                           "issue": ", ".join(pr.get("issues") or []) or None,
                           "text": f"PR #{pr.get('number')} merged into develop"})
    for it in (github.get("closedIssues") or [])[:100]:
        if it.get("closedAt"):
            events.append({"ts": it["closedAt"], "kind": "issue", "level": "ok", "ghIssue": it.get("number"),
                           "issue": ", ".join(it.get("issues") or []) or None,
                           "text": f"GitHub issue #{it.get('number')} closed"})
    develop = worker.get("develop") if isinstance(worker.get("develop"), dict) else None
    ev = develop_merge_event(develop) if develop else None
    if ev and ev.get("ts"):
        events = [e for e in events if not (e.get("kind") == "merge" and e.get("run") == "develop")]
        events.append(ev)
        merged_list = list(github.get("merged") or [])
        if ev["ts"] not in {p.get("mergedAt") for p in merged_list}:
            merged_list.insert(0, {
                "number": None, "title": ev["text"], "mergedAt": ev["ts"],
                "sha": ev.get("sha"), "headSha": ev.get("sha"), "issues": [],
                "method": (develop or {}).get("method"), "kind": "fast-forward",
            })
            github = dict(github, merged=merged_list)
    events = [e for e in events if isinstance(e, dict) and _num(e.get("ts"))]
    events.sort(key=lambda e: e["ts"], reverse=True)

    # what is happening right now / what is about to happen
    gates_now, queue, upcoming = [], [], {}
    for b in batches:
        for t in b["tasks"]:
            for r in t.get("runs") or []:
                steps = r.get("steps") or []
                cur = next((s for s in steps if s.get("status") == "RUNNING"), None)
                if cur or (r.get("norm") == "RUNNING" and r.get("kind") != "codex"):
                    gates_now.append({"batch": b["id"], "issue": t["issue"], "run": r.get("run"), "kind": r.get("kind"),
                                      "step": (cur or {}).get("name"), "gate": (cur or {}).get("gate"),
                                      "start": (cur or {}).get("start") or r.get("start"),
                                      "done": sum(1 for s in steps if s.get("status") == "PASS"), "total": len(steps)})
            if b.get("archived"):
                continue
            if (t.get("phase") == "pending" or (t.get("verdict") or {}).get("key") in ("queued", "pending")) and not t.get("running"):
                queue.append({"batch": b["id"], "issue": t["issue"], "status": t.get("status"),
                              "model": t.get("model"), "effort": t.get("effort"), "title": t.get("title")})
            if t.get("nextGate") and t.get("phase") not in ("pending",):
                upcoming.setdefault(t["nextGate"], []).append(
                    {"batch": b["id"], "issue": t["issue"], "status": t.get("nextGateStatus"), "phase": t.get("phase")})
    gates_now.sort(key=lambda g: g.get("start") or 0)

    state = {
        "serverTime": now,
        "dataAsOf": data_as_of,
        "freshness": {
            "dataAsOf": data_as_of,
            "collectedAt": worker.get("collectedAt"),
            "stale": bool(worker_age.get("stale")),
            "ageSec": worker_age.get("ageSec"),
            "staleAfter": STALE_AFTER,
            "currentRun": overview.get("currentRun"),
            "currentSource": current.get("statusFile"),
        },
        "now": {"gates": gates_now},
        "next": {"queue": queue, "upcoming": upcoming, "pipeline": list(PIPELINE)},
        "sources": sources,
        "repo": box.get("repo") or "RealDevFathom/devfathom-commercial",
        "overview": overview,
        "worker": {k: worker.get(k) for k in ("system", "history", "services", "codexProcs", "killSwitch",
                                              "usage", "allTime", "collectedAt", "dataAsOf", "current",
                                              "gateProcs", "rebase", "devfix", "lanes", "stopFiles", "develop", "campaign")},
        "box": {k: box.get(k) for k in ("workers", "machine", "region", "collectedAt", "usage")},
        "usage": usage,
        "codex": codex,
        "batches": batches,
        "develop": develop or {
            "sha": github.get("developSha"),
            "short": (github.get("developSha") or "")[:8] or None,
            "mergedAt": github.get("developAt"),
        },
        "campaign": worker.get("campaign") or campaign_pause_from_stops(
            worker.get("stopFiles"),
            ((worker.get("current") or {}).get("baseline")),
        ),
        "github": {"developSha": (develop or {}).get("sha") or github.get("developSha"),
                   "developAt": (develop or {}).get("mergedAt") or github.get("developAt"),
                   "developMovedAt": (develop or {}).get("mergedAt"),
                   "previousTip": (develop or {}).get("previousTip"),
                   "deployGate": (develop or {}).get("deployGate"),
                   "merged": (github.get("merged") or [])[:100],
                   "closedIssues": (github.get("closedIssues") or [])[:100]},
        "linear": {"available": linear_ok, "reason": linear.get("reason")},
        "events": events[:MAX_EVENTS],
        "alerts": compute_alerts(worker, box, sources),
        "ai": ai.status() if ai else {"enabled": False},
        "limits": {"spotCap": SPOT_CAP, "usageStop": USAGE_STOP, "diskAlert": DISK_ALERT,
                   "reserveBytes": RESERVE_BYTES, "staleAfter": STALE_AFTER,
                   "usageLabel": usage.get("label")},
    }
    if isinstance(state["worker"].get("services"), list):
        state["worker"]["services"] = annotate_services(state["worker"]["services"])
    try:
        rules = rule_insights(state, now)
    except Exception as exc:  # a bad payload must never break the dashboard
        log(f"rule insights failed: {type(exc).__name__}")
        rules = []
    analysis = (ai.analysis if ai else None) or {}
    state["insights"] = {
        "rules": rules,
        "ai": {k: analysis.get(k) for k in ("generatedAt", "model", "summary", "warnings", "suggestions")} if analysis else None,
    }
    return state


def compute_alerts(worker, box, sources):
    alerts = []

    def add(level, code, msg):
        alerts.append({"level": level, "code": code, "message": msg})

    for src, info in sources.items():
        if info["stale"]:
            age = info["ageSec"]
            add("warn", f"stale-{src}",
                f"{src} data is stale ({age // 60} min old)" if age is not None else f"no {src} data received yet")
    sysm = worker.get("system") or {}
    cores = sysm.get("cores") or 1
    if sysm.get("loadHigh5m"):
        add("crit", "load", f"load above 0.9×{cores} cores for 5 min")
    for path, d in (sysm.get("disks") or {}).items():
        if (_num(d.get("pct")) or 0) > DISK_ALERT:
            add("crit", f"disk-{path}", f"{path} disk {d['pct']:.0f}% used (> {DISK_ALERT:.0f}%)")
        if path == "/workspace" and _num(d.get("freeBytes")) is not None and d["freeBytes"] < RESERVE_BYTES:
            add("crit", "reserve", f"/workspace free {d['freeBytes'] / 1024 ** 3:.0f} GiB is below the 200 GiB reserve")
    for svc in worker.get("services") or []:
        if svc.get("active") == "failed":
            add("crit", f"unit-{svc.get('unit')}", f"systemd unit {svc.get('unit')} failed")
    ks = worker.get("killSwitch") or {}
    if ks.get("pass") is False:
        add("crit", "killswitch", "kill-switch / home egress check FAILED")
    for w in box.get("workers") or []:
        price = _num(w.get("spotPrice"))
        if price is not None and price > SPOT_CAP and w.get("state") == "running":
            add("warn", f"spot-{w.get('instanceId')}", f"spot price ${price:.3f}/h above ${SPOT_CAP:.2f} cap")
    camp = worker.get("campaign") or campaign_pause_from_stops(
        worker.get("stopFiles"), (worker.get("current") or {}).get("baseline"))
    if camp and camp.get("paused"):
        reason = camp.get("reason") or "No new Codex dispatch"
        key = camp.get("key") or "campaign-paused"
        add("crit", key,
            f"Campaign paused ({key}): {reason}")
    usage = inky_usage_from_box(box, worker.get("usage"))
    pct = _num(usage.get("weeklyPct"))
    if pct is not None and pct >= USAGE_STOP:
        add("crit", "usage",
            f"Inky (Grok Bot) weekly usage {pct:.0f}% ≥ {USAGE_STOP:.0f}% stop line. "
            "Inky stops its own work at 95%; this is not Codex, worker, or Claude usage.")
    if usage.get("stopActive"):
        add("warn", "usage-stop",
            "Inky (Grok Bot) usage-stop marker is active — Inky has stopped its own work. "
            "This does not mean Codex, the worker, or Claude should be throttled.")
    return alerts


def known_issues(snapshot):
    worker = (snapshot.get("worker") or {}).get("payload") or {}
    ids = set()
    for b in worker.get("batches") or []:
        for t in (b or {}).get("tasks") or []:
            if isinstance(t, dict) and isinstance(t.get("issue"), str):
                ids.add(t["issue"])
    return sorted(ids)


# --------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "ops-dash"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # never log headers or bodies: method, path (no query) and status only
    def log_request(self, code="-", size="-"):
        path = (self.path or "").split("?", 1)[0][:200]
        log(f'{self.command} {path} {code}')

    def log_message(self, fmt, *args):
        pass

    @property
    def cfg(self):
        return self.server.cfg

    def client_ip(self):
        if self.cfg.get("trust_proxy"):
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()[:64]
        return self.client_address[0]

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None, api=False):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in (extra or {}):
            self.send_header("Cache-Control", "no-store" if api else "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj):
        self.send(code, json.dumps(obj, separators=(",", ":")), "application/json", api=True)

    def require_basic(self):
        ip = self.client_ip()
        limiter = self.server.limiter
        if limiter.blocked(ip):
            self.send(429, "too many failed attempts", extra={"Retry-After": str(FAIL_WINDOW)})
            return False
        if check_basic(self.headers.get("Authorization"), self.cfg["user"], self.cfg["password"]):
            return True
        if self.headers.get("Authorization"):
            limiter.fail(ip)
        self.send(401, "authentication required", extra={"WWW-Authenticate": 'Basic realm="ops", charset="UTF-8"'})
        return False

    def require_bearer(self):
        ip = self.client_ip()
        limiter = self.server.limiter
        if limiter.blocked(ip):
            self.send(429, "too many failed attempts", api=True)
            return False
        if check_bearer(self.headers.get("Authorization"), self.cfg["token"]):
            return True
        limiter.fail(ip)
        self.send(401, "unauthorized", api=True)
        return False

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self.send(200, "ok", api=True)
        if path == "/api/known-issues":
            if not self.require_bearer():
                return None
            return self.send_json(200, {"issues": known_issues(self.server.store.snapshot())})
        if not self.require_basic():
            return None
        if path in ("/", "/index.html"):
            return self.static("index.html")
        if path.startswith("/static/"):
            name = path[len("/static/"):]
            if name in STATIC_FILES:
                return self.static(name)
            return self.send(404, "not found")
        if path == "/api/state":
            return self.send_json(200, self.server.state())
        return self.send(404, "not found")

    def static(self, name):
        try:
            with open(os.path.join(STATIC_DIR, name), "rb") as fh:
                body = fh.read()
        except OSError:
            return self.send(404, "not found")
        extra = {"Cache-Control": "private, max-age=604800, immutable"} if name in LONG_CACHE else None
        return self.send(200, body, STATIC_FILES[name], extra=extra)

    def same_origin_json(self, limit):
        """CSRF guard for browser POSTs: custom header (forces a CORS preflight) + Origin check."""
        if self.headers.get("X-Requested-With") != "ops-dash":
            self.send(403, "forbidden", api=True)
            return None
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin.split("://", 1)[-1] != host:
            self.send(403, "forbidden", api=True)
            return None
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            self.send(415, "application/json required", api=True)
            return None
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send(411, "content-length required", api=True)
            return None
        if length < 0 or length > limit:
            self.send(413, "payload too large", api=True)
            return None
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self.send(400, "invalid json", api=True)
            return None
        if not isinstance(body, dict):
            self.send(400, "payload must be a JSON object", api=True)
            return None
        return body

    def ai_post(self, path):
        if not self.require_basic():
            self.close_connection = True
            return None
        body = self.same_origin_json(MAX_CHAT_BODY)
        if body is None:
            self.close_connection = True
            return None
        ai = self.server.ai
        if not ai.enabled:
            return self.send_json(503, {"error": "AI is not configured on this deployment"})
        if path == "/api/ai/chat":
            if not ai.allow_chat(self.client_ip()):
                return self.send_json(429, {"error": "chat rate limit reached, try again shortly"})
            history = body.get("messages")
            if not isinstance(history, list) or not history:
                return self.send_json(400, {"error": "messages required"})
            try:
                return self.send_json(200, ai.chat([m for m in history if isinstance(m, dict)]))
            except AIError as exc:
                return self.send_json(503, {"error": str(exc)})
        if path == "/api/ai/refresh":
            if ai.request_refresh():
                return self.send_json(202, {"ok": True, "message": "analysis started"})
            return self.send_json(429, {"error": f"analysis was refreshed recently; try again in a few minutes"})
        return self.send(404, "not found", api=True)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/ai/"):
            return self.ai_post(path)
        parts = path.strip("/").split("/")
        if len(parts) != 3 or parts[:2] != ["api", "ingest"] or parts[2] not in SOURCES:
            self.close_connection = True
            return self.send(404, "not found", api=True)
        if not self.require_bearer():
            self.close_connection = True
            return None
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.close_connection = True
            return self.send(415, "application/json required", api=True)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.close_connection = True
            return self.send(411, "content-length required", api=True)
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            return self.send(413, "payload too large", api=True)
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return self.send(400, "invalid json", api=True)
        if not isinstance(payload, dict):
            return self.send(400, "payload must be a JSON object", api=True)
        rec = self.server.store.put(parts[2], sanitize(payload))
        return self.send_json(200, {"ok": True, "receivedAt": rec["receivedAt"]})

    def do_PUT(self):
        self.send(405, "method not allowed", api=True)

    do_DELETE = do_PATCH = do_PUT


def make_server(host, port, cfg, data_dir, backup=None):
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.cfg = cfg
    srv.backup = backup if backup is not None else S3Backup()
    srv.store = Store(data_dir, backup=srv.backup)
    srv.limiter = RateLimiter()
    srv.ai = AIService(lambda: build_state(srv.store.snapshot(), ai=srv.ai), data_dir, backup=srv.backup)
    srv.state = lambda: build_state(srv.store.snapshot(), ai=srv.ai)
    return srv


def main():
    cfg = {
        "user": os.environ.get("DASH_USER", "ops"),
        "password": os.environ.get("DASH_PASSWORD", ""),
        "token": os.environ.get("INGEST_TOKEN", ""),
        "trust_proxy": os.environ.get("TRUST_PROXY") == "1",
    }
    if not cfg["password"]:
        log("WARNING: DASH_PASSWORD not set - UI access is disabled (fail closed)")
    if not cfg["token"]:
        log("WARNING: INGEST_TOKEN not set - ingest is disabled (fail closed)")
    port = int(os.environ.get("PORT", "8080"))
    srv = make_server(os.environ.get("BIND", "0.0.0.0"), port, cfg, os.environ.get("DATA_DIR", "/tmp/dash"))
    srv.ai.start_background()
    log(f"listening on :{port} · AI {'enabled (' + srv.ai.model + ')' if srv.ai.enabled else 'disabled (no ANTHROPIC_API_KEY)'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
