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

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
}
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
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.lock = threading.Lock()
        self.data = {}
        try:
            os.makedirs(data_dir, exist_ok=True)
        except OSError as exc:
            log(f"cannot create DATA_DIR ({type(exc).__name__}); running in-memory only")
        for src in SOURCES:
            try:
                with open(os.path.join(data_dir, f"{src}.json")) as fh:
                    rec = json.load(fh)
                if isinstance(rec, dict) and isinstance(rec.get("payload"), dict):
                    self.data[src] = rec
            except (OSError, ValueError):
                pass

    def put(self, source, payload, now=None):
        rec = {"receivedAt": now or time.time(), "payload": payload}
        with self.lock:
            self.data[source] = rec
            try:
                fd, tmp = tempfile.mkstemp(dir=self.data_dir, prefix=f".{source}.")
                with os.fdopen(fd, "w") as fh:
                    json.dump(rec, fh, separators=(",", ":"))
                os.replace(tmp, os.path.join(self.data_dir, f"{source}.json"))
            except OSError as exc:
                log(f"persist {source} failed ({type(exc).__name__})")
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

    merged_by_issue, titles = {}, {}
    for pr in github.get("merged") or []:
        for issue in pr.get("issues") or []:
            cur = merged_by_issue.get(issue)
            if not cur or (pr.get("mergedAt") or 0) > (cur.get("mergedAt") or 0):
                merged_by_issue[issue] = {k: pr.get(k) for k in ("number", "title", "mergedAt", "sha")}
            titles.setdefault(issue, pr.get("title"))
    closed_by_issue = {}
    for it in github.get("closedIssues") or []:
        for issue in it.get("issues") or []:
            closed_by_issue.setdefault(issue, {k: it.get(k) for k in ("number", "title", "closedAt")})
            titles[issue] = it.get("title") or titles.get(issue)

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
            merge = merged_by_issue.get(issue)
            gh = closed_by_issue.get(issue)
            lin = lstates.get(issue)
            linear_closed = (lin or {}).get("type") in ("completed", "canceled") if linear_ok else None
            gates["merged"] = {"status": "PASS" if merge else "PENDING",
                               **({"pr": merge["number"], "sha": (merge.get("sha") or "")[:10]} if merge else {})}
            gates["linear"] = {"status": "PASS" if linear_closed else ("PENDING" if linear_ok else "SKIP"),
                               **({"state": lin.get("state")} if lin else {})}
            gates["gh"] = {"status": "PASS" if gh else "PENDING", **({"number": gh["number"]} if gh else {})}
            issues_closed = bool(gh) and (linear_closed if linear_ok else True)
            t["gates"] = gates
            t["title"] = titles.get(issue)
            t["merge"] = merge
            t["ghIssue"] = gh
            t["linear"] = lin
            t["merged"] = bool(merge)
            t["ghClosed"] = bool(gh)
            t["linearClosed"] = linear_closed
            t["done"] = bool(t.get("gated")) and bool(merge) and issues_closed
            t["nextGate"], t["nextGateStatus"] = (None, None) if t["done"] else next_gate(gates)
            if t["done"]:
                t["phase"] = "done"
            elif merge and t.get("phase") not in ("running",):
                t["phase"] = "merged"
            tasks.append(t)
            agg = best.setdefault(issue, {"fixed": False, "gated": False, "merged": False, "linear": False,
                                          "gh": False, "done": False})
            agg["fixed"] |= bool(t.get("fixed"))
            agg["gated"] |= bool(t.get("gated"))
            agg["merged"] |= t["merged"]
            agg["linear"] |= bool(linear_closed)
            agg["gh"] |= t["ghClosed"]
            agg["done"] |= t["done"]
        b = dict(b)
        b["tasks"] = tasks
        counts = dict(b.get("counts") or {})
        counts.update({"total": len(tasks),
                       "fixed": sum(1 for t in tasks if t.get("fixed")),
                       "gated": sum(1 for t in tasks if t.get("gated")),
                       "merged": sum(1 for t in tasks if t["merged"]),
                       "closed": sum(1 for t in tasks if t["ghClosed"] and t["linearClosed"] is not False),
                       "done": sum(1 for t in tasks if t["done"]),
                       "running": sum(1 for t in tasks if t.get("running"))})
        b["counts"] = counts
        last = _num(b.get("last")) or 0
        b["historical"] = not b.get("active") and not counts["running"] and now - last > 86400
        batches.append(b)

    codex = worker.get("codex") or {}
    machine = box.get("machine") or {}
    usage = worker.get("usage") or {}
    overview = {
        "tasks": len(best),
        "fixed": sum(1 for v in best.values() if v["fixed"]),
        "gated": sum(1 for v in best.values() if v["gated"]),
        "merged": sum(1 for v in best.values() if v["merged"]),
        "linearClosed": sum(1 for v in best.values() if v["linear"]) if linear_ok else None,
        "ghClosed": sum(1 for v in best.values() if v["gh"]),
        "done": sum(1 for v in best.values() if v["done"]),
        "codexJobsTotal": (worker.get("allTime") or {}).get("codexJobsSeen"),
        "codexActive": codex.get("activeCount"),
        "codexCap": codex.get("cap") or 50,
        "machineHours": machine.get("hours"),
        "machineCostUsd": machine.get("costUsd"),
        "usagePct": usage.get("weeklyPct"),
        "usageStopActive": bool(usage.get("stopActive")),
        "batches": len(batches),
        "mergedLast30d": len(github.get("merged") or []),
    }

    events = list(worker.get("events") or [])
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
            if t.get("phase") == "pending" and not t.get("running"):
                queue.append({"batch": b["id"], "issue": t["issue"], "status": t.get("status"),
                              "model": t.get("model"), "effort": t.get("effort"), "title": t.get("title")})
            if t.get("nextGate") and t.get("phase") not in ("pending",):
                upcoming.setdefault(t["nextGate"], []).append(
                    {"batch": b["id"], "issue": t["issue"], "status": t.get("nextGateStatus"), "phase": t.get("phase")})
    gates_now.sort(key=lambda g: g.get("start") or 0)

    state = {
        "serverTime": now,
        "now": {"gates": gates_now},
        "next": {"queue": queue, "upcoming": upcoming, "pipeline": list(PIPELINE)},
        "sources": sources,
        "repo": box.get("repo") or "RealDevFathom/devfathom-commercial",
        "overview": overview,
        "worker": {k: worker.get(k) for k in ("system", "history", "services", "codexProcs", "killSwitch",
                                              "usage", "allTime", "collectedAt")},
        "box": {k: box.get(k) for k in ("workers", "machine", "region", "collectedAt")},
        "codex": codex,
        "batches": batches,
        "github": {"developSha": github.get("developSha"), "developAt": github.get("developAt"),
                   "merged": (github.get("merged") or [])[:100],
                   "closedIssues": (github.get("closedIssues") or [])[:100]},
        "linear": {"available": linear_ok, "reason": linear.get("reason")},
        "events": events[:MAX_EVENTS],
        "alerts": compute_alerts(worker, box, sources),
        "ai": ai.status() if ai else {"enabled": False},
        "limits": {"spotCap": SPOT_CAP, "usageStop": USAGE_STOP, "diskAlert": DISK_ALERT,
                   "reserveBytes": RESERVE_BYTES, "staleAfter": STALE_AFTER},
    }
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
    usage = worker.get("usage") or {}
    pct = _num(usage.get("weeklyPct"))
    if pct is not None and pct >= USAGE_STOP:
        add("crit", "usage", f"weekly usage {pct:.0f}% ≥ {USAGE_STOP:.0f}% stop line")
    if usage.get("stopActive"):
        add("warn", "usage-stop", "owner usage cutoff STOP marker is active")
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
        return self.send(200, body, STATIC_FILES[name])

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


def make_server(host, port, cfg, data_dir):
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.cfg = cfg
    srv.store = Store(data_dir)
    srv.limiter = RateLimiter()
    srv.ai = AIService(lambda: build_state(srv.store.snapshot(), ai=srv.ai), data_dir)
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
