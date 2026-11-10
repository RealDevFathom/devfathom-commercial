"""Server-side Claude layer for the ops dashboard (Python stdlib only — raw HTTPS via urllib).

* chat():     a tool-using assistant that answers questions about the campaign. Its tools are
              read-only views over the same in-memory snapshot that /api/state serves; none of
              them has side effects and nothing here can trigger merges, deploys or jobs.
* analyze():  a cached, rate-limited structured analysis that produces warnings and suggestions
              (severity, reason, evidence links) grounded in the rule findings.

The API key is read from ANTHROPIC_API_KEY (injected from AWS Secrets Manager at deploy time).
It is only ever sent to api.anthropic.com in the x-api-key header — never logged, never stored,
never returned to the browser.
"""

import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sanitize import scrub_string  # noqa: E402

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2026-10-21"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
DEFAULT_MODEL = "claude-opus-5-5"
# Models that accept server-side refusal fallbacks (`fallbacks: "default"` + the beta header).
# Claude Haiku 5.5 has no server-side fallback, so the parameter is omitted for it and for unknown models.
FALLBACK_MODELS = {"claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
# Claude Fable 5.2 can take several minutes on hard requests.
SLOW_MODELS = {"claude-fable-5-2", "claude-fable-5-1"}
MAX_TOOL_ROUNDS = 8
MAX_TOOL_RESULT_CHARS = 60_000
MAX_DIGEST_CHARS = 180_000
LINK_RE = re.compile(r"^(#(task|run|batch|pr|issue|metric)=[\w%.\-/]+|#(usage|workers)|https://github\.com/[\w.\-]+/[\w.\-]+/(pull|issues|commit)/[\w]+)$")


def log(msg):
    print(f"[ai] {msg}", file=sys.stderr, flush=True)


SYSTEM_PROMPT = """You are the analyst inside the DevFathom campaign ops dashboard. The campaign uses Codex to fix \
Linear/GitHub issues (ids like DEV-123) in batches; each task must pass machine gates (prisma generate, typecheck, \
lint, complete_unit, host_build, docker build contract, a differential unit check against the batch baseline, \
optionally QA/browser and security) on its final SHA, be merged into `develop`, and have its GitHub and Linear issues \
closed. A task is "done" only when all of that holds. Each task carries a `verdict` (status): trust it. PASSED means every \
required gate passed on the exact final SHA; FAILED names the failing gate; MERGED means this task's own final SHA was \
merged into develop during the campaign (a PR that merely mentions the issue does not count, see mergeMismatch). Batches are job roots on the worker; runs inside them are \
codex-*, gates-* and baseline-* directories.

You are strictly read-only. You can look at data through the provided tools and nothing else. You cannot start, \
stop, retry, merge, deploy, close issues or change anything, and you must not claim or offer to. When something \
needs doing, say what a human should do and why.

Ground every statement in tool data. If the data does not show something, say so plainly instead of guessing. \
Times are Pakistan Standard Time (PKT, UTC+5); tool results carry epoch seconds and already-formatted PKT strings.

Cite evidence with markdown links using only these targets:
- [DEV-12](#task=<batch_id>/<issue>) for a task, [codex-1110](#run=<batch_id>/<run>) for a run, [batch](#batch=<batch_id>)
- [PR #994](#pr=994), [issue #1010](#issue=1010), [CPU](#metric=cpuPct) (also memPct, load1, workspacePct, scratchPct)
- [usage](#usage), [workers](#workers), or https://github.com/<repo>/pull/<n> and /issues/<n> links
URL-encode batch ids if they contain unusual characters. Do not invent other URLs.

Write for an engineer checking on the campaign: lead with the answer, keep it short, use bullet lists for several \
items, and include the relevant links."""

ANALYSIS_INSTRUCTIONS = """Review the campaign state digest and the rule findings below and return warnings and \
suggestions for the dashboard. Focus on what is going the wrong way or is about to: stalled or looping Codex jobs, \
repeated gate failures and their likely shared causes, tasks not moving, tests or guards that may have been weakened \
(changed test/config/auth files, fewer passing tests than baseline), Codex running machine checks itself, disk/RAM/CPU \
pressure, spot price or weekly usage nearing limits, stale data, and anything else unusual. Add useful suggestions \
(what a human should look at or do next) — advice only, the dashboard is read-only.

Rules for the output:
- Do not repeat a rule finding verbatim; add new insight, connect findings, or raise severity with a reason.
- severity: "crit" (act now), "warn" (look today), "info" (good to know).
- area: where it is shown — overview, now, next, batches, history or machine.
- Every item needs at least one evidence link using the link formats in your instructions.
- batch and issue: the related batch id / issue id, or "" when not about one.
- At most 12 warnings and 12 suggestions. summary: 2-4 sentences on the overall state."""

ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": ["crit", "warn", "info"]},
        "area": {"type": "string", "enum": ["overview", "now", "next", "batches", "history", "machine"]},
        "title": {"type": "string"},
        "reason": {"type": "string"},
        "batch": {"type": "string"},
        "issue": {"type": "string"},
        "evidence": {"type": "array", "items": {
            "type": "object",
            "properties": {"label": {"type": "string"}, "link": {"type": "string"}},
            "required": ["label", "link"], "additionalProperties": False}},
    },
    "required": ["severity", "area", "title", "reason", "batch", "issue", "evidence"],
    "additionalProperties": False,
}
ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "warnings": {"type": "array", "items": ITEM_SCHEMA},
        "suggestions": {"type": "array", "items": ITEM_SCHEMA},
    },
    "required": ["summary", "warnings", "suggestions"],
    "additionalProperties": False,
}


def _tool(name, description, props=None, required=None):
    return {"name": name, "description": description, "strict": True,
            "input_schema": {"type": "object", "properties": props or {}, "required": required or [],
                             "additionalProperties": False}}


TOOLS = [
    _tool("get_overview", "All-time campaign totals (tasks, fixed, gated, merged, closed, done), Codex jobs, machine "
          "hours/cost, weekly usage, current alerts and how fresh each data source is."),
    _tool("list_batches", "Every discovered batch (current and historical) with progress counts, active runs, "
          "start and last-activity times."),
    _tool("get_batch", "One batch in detail: runs, baseline, ledgers, merge-gate policies and a compact per-task "
          "gate matrix.", {"batch_id": {"type": "string", "description": "Batch id from list_batches"}}, ["batch_id"]),
    _tool("get_task", "Full detail for one task: phase, every run with step timings and statuses, gate results, "
          "differential vs baseline, changed files, merge PR, GitHub and Linear state.",
          {"issue": {"type": "string", "description": "Issue id such as DEV-12"},
           "batch_id": {"type": "string", "description": "Batch id, or empty string for the most recent batch containing the issue"}},
          ["issue", "batch_id"]),
    _tool("get_live_activity", "What is happening right now: running Codex jobs (model, effort, step, duration), "
          "running machine runs and gate steps, Codex process counts."),
    _tool("get_upcoming", "What is about to happen: queued tasks, the next pipeline step each in-flight task is "
          "waiting on, and batches that are queued or have the most remaining work."),
    _tool("get_worker_metrics", "Worker machine: CPU, load, RAM, PSI, disks, last-hour and 7-day history "
          "summaries, systemd services, egress kill-switch, weekly usage, EC2 instance, spot price and cost."),
    _tool("get_github_activity", "Merges into develop and closed GitHub issues with DEV- references.",
          {"days": {"type": "integer", "description": "Look-back window in days (1-30)"}}, ["days"]),
    _tool("get_linear_states", "Linear workflow state for issue ids (read-only snapshot from the ops box).",
          {"issues": {"type": "array", "items": {"type": "string"}, "description": "Issue ids; empty list for all known"}},
          ["issues"]),
    _tool("search_events", "Search the history timeline (Codex starts/finishes, gate step results, run ends, "
          "merges, issue closures, state changes), newest first.",
          {"query": {"type": "string", "description": "Text to match, or empty string"},
           "kind": {"type": "string", "description": "codex, step, gates, baseline, review, merge, issue, state, batch, or empty"},
           "issue": {"type": "string", "description": "Issue id filter, or empty string"},
           "since_hours": {"type": "integer", "description": "Only events newer than this many hours (0 = all)"},
           "limit": {"type": "integer", "description": "Max events to return (1-200)"}},
          ["query", "kind", "issue", "since_hours", "limit"]),
    _tool("get_insights", "Current automatic warnings and suggestions (rule-based and the last AI analysis)."),
]
TOOLS[-1]["cache_control"] = {"type": "ephemeral"}


def fmt_pkt(ts):
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    t = time.gmtime(ts + 5 * 3600)
    return time.strftime("%Y-%m-%d %H:%M PKT", t)


def _with_times(obj, depth=0):
    """Add *_pkt strings next to epoch fields so the model never has to convert."""
    if depth > 8:
        return obj
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            out[k] = _with_times(v, depth + 1)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 1.5e9 and (
                    k in ("ts", "start", "end", "last", "codexStart", "codexEnd", "receivedAt", "mergedAt", "closedAt",
                          "launchTime", "checkedAt", "collectedAt", "developAt", "at", "mtime", "clearedAt", "stopSince")):
                out[f"{k}_pkt"] = fmt_pkt(v)
        return out
    if isinstance(obj, list):
        return [_with_times(v, depth + 1) for v in obj]
    return obj


def _compact_task(t):
    gates = {k: (v or {}).get("status") for k, v in (t.get("gates") or {}).items()}
    return {"issue": t.get("issue"), "title": t.get("title"), "status": (t.get("verdict") or {}).get("label"),
            "phase": t.get("phase"), "nextGate": t.get("nextGate"),
            "finalSHA": t.get("finalSHA"), "model": t.get("model"), "gates": gates, "last": t.get("last"),
            "merged": t.get("merged"), "done": t.get("done")}


class ReadOnlyTools:
    """Pure functions over a state snapshot. No network, no files, no side effects."""

    def __init__(self, state):
        self.s = state

    def run(self, name, args):
        fn = getattr(self, f"t_{name}", None)
        if fn is None:
            return {"error": f"unknown tool {name}"}
        try:
            return _with_times(fn(**(args or {})))
        except TypeError as exc:
            return {"error": f"bad arguments: {exc}"}

    def _batch(self, bid):
        return next((b for b in self.s.get("batches") or [] if b.get("id") == bid), None)

    def t_get_overview(self):
        return {k: self.s.get(k) for k in ("overview", "alerts", "sources", "repo", "limits", "linear")} | {
            "serverTime": self.s.get("serverTime")}

    def t_list_batches(self):
        return [{k: b.get(k) for k in ("id", "label", "counts", "active", "cap", "start", "last", "historical", "attemptDirs")}
                | {"runs": [r.get("name") for r in b.get("runs") or []]} for b in self.s.get("batches") or []]

    def t_get_batch(self, batch_id):
        b = self._batch(batch_id)
        if not b:
            return {"error": "no such batch", "known": [x.get("id") for x in self.s.get("batches") or []]}
        return {k: b.get(k) for k in ("id", "label", "counts", "active", "cap", "start", "last", "runs", "baseline",
                                      "ledgers", "files", "policies", "attemptDirs", "historical")} | {
            "tasks": [_compact_task(t) for t in b.get("tasks") or []]}

    def t_get_task(self, issue, batch_id=""):
        found = []
        for b in self.s.get("batches") or []:
            if batch_id and b.get("id") != batch_id:
                continue
            for t in b.get("tasks") or []:
                if t.get("issue") == issue:
                    found.append((b, t))
        if not found:
            return {"error": f"{issue} not found"}
        found.sort(key=lambda bt: bt[1].get("last") or 0, reverse=True)
        b, t = found[0]
        return {"batch_id": b.get("id"), "batch_label": b.get("label"), "task": t,
                "baseline": {k: (b.get("baseline") or {}).get(k) for k in ("baseSHA", "numPassedTests", "numFailedTests", "failedFileCount")},
                "also_in_batches": [x[0].get("id") for x in found[1:]]}

    def t_get_live_activity(self):
        w = self.s.get("worker") or {}
        return {"codex": self.s.get("codex"), "machineRuns": (self.s.get("now") or {}).get("gates"),
                "codexProcs": w.get("codexProcs")}

    def t_get_upcoming(self):
        nxt = self.s.get("next") or {}
        batches = [{k: b.get(k) for k in ("id", "label", "counts", "start", "last")} for b in self.s.get("batches") or []
                   if not b.get("historical") and (b.get("counts") or {}).get("pending")]
        return {"queue": nxt.get("queue"), "waitingOn": {k: v for k, v in (nxt.get("upcoming") or {}).items()},
                "pipelineOrder": nxt.get("pipeline"), "batchesWithQueuedWork": batches}

    def t_get_worker_metrics(self):
        w = self.s.get("worker") or {}
        hist = w.get("history") or {}
        fields = hist.get("fields") or []
        summary = {}
        for i, f in enumerate(fields[1:], start=1):
            vals = [r[i] for r in hist.get("recent") or [] if isinstance(r[i], (int, float))]
            if vals:
                summary[f] = {"min": min(vals), "avg": round(sum(vals) / len(vals), 2), "max": max(vals), "latest": vals[-1]}
        return {"system": w.get("system"), "lastHour": summary, "hourly7d": {"fields": fields, "rows": (hist.get("hourly") or [])[-168:]},
                "services": w.get("services"), "killSwitch": w.get("killSwitch"), "usage": w.get("usage"),
                "box": self.s.get("box")}

    def t_get_github_activity(self, days=30):
        days = max(1, min(30, int(days or 30)))
        cutoff = (self.s.get("serverTime") or time.time()) - days * 86400
        gh = self.s.get("github") or {}
        return {"repo": self.s.get("repo"), "developSha": gh.get("developSha"), "developAt": gh.get("developAt"),
                "merged": [p for p in gh.get("merged") or [] if (p.get("mergedAt") or 0) >= cutoff],
                "closedIssues": [i for i in gh.get("closedIssues") or [] if (i.get("closedAt") or 0) >= cutoff]}

    def t_get_linear_states(self, issues=None):
        out = {}
        for b in self.s.get("batches") or []:
            for t in b.get("tasks") or []:
                if not issues or t.get("issue") in issues:
                    out[t["issue"]] = {"linear": t.get("linear"), "linearClosed": t.get("linearClosed")}
        return {"linear": self.s.get("linear"), "states": out}

    def t_search_events(self, query="", kind="", issue="", since_hours=0, limit=50):
        limit = max(1, min(200, int(limit or 50)))
        now = self.s.get("serverTime") or time.time()
        q = (query or "").lower()
        res = []
        for e in self.s.get("events") or []:
            if kind and e.get("kind") != kind:
                continue
            if issue and issue not in str(e.get("issue") or ""):
                continue
            if since_hours and (e.get("ts") or 0) < now - since_hours * 3600:
                continue
            if q and q not in " ".join(str(e.get(k) or "") for k in ("text", "issue", "batch", "run")).lower():
                continue
            res.append(e)
            if len(res) >= limit:
                break
        return {"count": len(res), "events": res}

    def t_get_insights(self):
        return self.s.get("insights")


def digest(state):
    """A compact, deterministic snapshot for the analysis prompt."""
    batches = []
    for b in state.get("batches") or []:
        tasks = sorted(b.get("tasks") or [], key=lambda t: (t.get("done") is True, -(t.get("last") or 0)))
        batches.append({k: b.get(k) for k in ("id", "label", "counts", "active", "cap", "start", "last", "historical")}
                       | {"baseline": {k: (b.get("baseline") or {}).get(k) for k in ("baseSHA", "numPassedTests", "numFailedTests")},
                          "runs": [{k: r.get(k) for k in ("name", "kind", "tasks", "active", "start", "last", "counts")} for r in b.get("runs") or []],
                          "ledgers": [{k: l.get(k) for k in ("file", "run", "at", "mtime", "counts")} for l in b.get("ledgers") or []],
                          "tasks": [_compact_task(t) | {"changedPaths": (t.get("changedPaths") or [])[:12],
                                                        "unitPassed": ((t.get("gates") or {}).get("complete_unit") or {}).get("passed"),
                                                        "runs": [{k: r.get(k) for k in ("run", "kind", "status", "start", "end", "codexStart", "codexEnd", "codexExitCode")}
                                                                 for r in (t.get("runs") or [])[-4:]]}
                                    for t in tasks[:150]]})
    w = state.get("worker") or {}
    d = {
        "serverTime": state.get("serverTime"), "overview": state.get("overview"), "alerts": state.get("alerts"),
        "sources": state.get("sources"), "limits": state.get("limits"), "codex": state.get("codex"), "now": state.get("now"),
        "next": {"queue": ((state.get("next") or {}).get("queue") or [])[:60],
                 "waitingOn": {k: len(v) for k, v in ((state.get("next") or {}).get("upcoming") or {}).items()}},
        "worker": {"system": w.get("system"), "services": w.get("services"), "killSwitch": w.get("killSwitch"),
                   "usage": w.get("usage"), "codexProcs": w.get("codexProcs")},
        "box": state.get("box"), "github": {"merged": ((state.get("github") or {}).get("merged") or [])[:25],
                                             "closedIssues": ((state.get("github") or {}).get("closedIssues") or [])[:25]},
        "recentEvents": (state.get("events") or [])[:80], "batches": batches,
    }
    text = json.dumps(_with_times(d), separators=(",", ":"), sort_keys=True, default=str)
    if len(text) > MAX_DIGEST_CHARS:
        text = text[:MAX_DIGEST_CHARS] + "…(truncated)"
    return text


def _clean_item(item):
    ev = [e for e in item.get("evidence") or [] if isinstance(e, dict) and LINK_RE.match(str(e.get("link") or ""))]
    return {"severity": item.get("severity") if item.get("severity") in ("crit", "warn", "info") else "info",
            "area": item.get("area") if item.get("area") in ("overview", "now", "next", "batches", "history", "machine") else "overview",
            "title": scrub_string(str(item.get("title") or ""))[:200], "reason": scrub_string(str(item.get("reason") or ""))[:1200],
            "batch": str(item.get("batch") or "")[:200] or None, "issue": str(item.get("issue") or "")[:40] or None,
            "evidence": [{"label": scrub_string(str(e.get("label")))[:120], "link": e["link"]} for e in ev][:8], "source": "ai"}


def _echo_content(content):
    """Assistant content to send back in the tool loop (drop pre-fallback thinking/tool_use per API rules)."""
    idx = max((i for i, b in enumerate(content) if b.get("type") == "fallback"), default=-1)
    if idx < 0:
        return content
    drop = {"thinking", "redacted_thinking", "tool_use"}
    return [b for i, b in enumerate(content) if i >= idx or b.get("type") not in drop]


class AIError(Exception):
    pass


class AIService:
    def __init__(self, get_state, data_dir, env=None):
        env = env if env is not None else os.environ
        self._key = env.get("ANTHROPIC_API_KEY", "").strip()
        self.model = env.get("AI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
        self.chat_model = env.get("AI_CHAT_MODEL", "").strip() or self.model
        self.analysis_model = env.get("AI_ANALYSIS_MODEL", "").strip() or self.model
        self.chat_effort = env.get("AI_CHAT_EFFORT", "medium")
        self.analysis_effort = env.get("AI_ANALYSIS_EFFORT", "high")
        self.daily_budget = int(env.get("AI_DAILY_TOKEN_BUDGET", "3000000"))
        self.min_interval = int(env.get("AI_ANALYSIS_MIN_INTERVAL", "900"))
        self.max_age = int(env.get("AI_ANALYSIS_MAX_AGE", "21600"))
        self.refresh_cooldown = int(env.get("AI_REFRESH_COOLDOWN", "300"))
        self.chat_per_min = int(env.get("AI_CHAT_PER_MIN", "6"))
        self.chat_per_day = int(env.get("AI_CHAT_PER_DAY", "150"))
        self.get_state = get_state
        self.path = os.path.join(data_dir, "ai_analysis.json")
        self.lock = threading.Lock()
        self.chat_slots = threading.BoundedSemaphore(int(env.get("AI_MAX_CONCURRENT", "2")))
        self.analysis_lock = threading.Lock()
        self.usage = {"day": time.strftime("%Y-%m-%d", time.gmtime()), "tokens": 0, "calls": 0}
        self.chat_hits = {}
        self.last_refresh_request = 0.0
        self.last_error = None
        self.analysis = None
        try:
            with open(self.path) as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                self.analysis = data
        except (OSError, ValueError):
            pass

    # -- status shown in /api/state (never includes the key)
    @property
    def enabled(self):
        return bool(self._key)

    def status(self):
        self._roll_day()
        a = self.analysis or {}
        return {"enabled": self.enabled, "model": self.chat_model if self.enabled else None,
                "analysisConfig": f"{self.analysis_model} ({self.analysis_effort})" if self.enabled else None,
                "lastAnalysisAt": a.get("generatedAt"), "analysisModel": a.get("model"),
                "budgetUsedPct": round(100.0 * self.usage["tokens"] / self.daily_budget, 1) if self.daily_budget else None,
                "budgetExhausted": self._exhausted(), "error": self.last_error}

    # -- budget & rate limits
    def _roll_day(self):
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self.lock:
            if self.usage["day"] != day:
                self.usage = {"day": day, "tokens": 0, "calls": 0}
                self.chat_hits = {}

    def _exhausted(self):
        return self.daily_budget > 0 and self.usage["tokens"] >= self.daily_budget

    def _charge(self, usage):
        u = usage or {}
        weighted = (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) \
            + 0.1 * (u.get("cache_read_input_tokens") or 0)
        with self.lock:
            self.usage["tokens"] += int(weighted)
            self.usage["calls"] += 1

    def allow_chat(self, ip, now=None):
        now = now or time.time()
        self._roll_day()
        with self.lock:
            hits = [t for t in self.chat_hits.get(ip, []) if now - t < 86400]
            if len([t for t in hits if now - t < 60]) >= self.chat_per_min or len(hits) >= self.chat_per_day:
                self.chat_hits[ip] = hits
                return False
            hits.append(now)
            self.chat_hits[ip] = hits
            if len(self.chat_hits) > 5000:
                self.chat_hits = {ip: hits}
            return True

    # -- HTTP
    def _call(self, body, timeout=120):
        if body.get("model") in SLOW_MODELS:
            timeout = max(timeout, 600)
        if not self.enabled:
            raise AIError("AI is not configured (ANTHROPIC_API_KEY missing)")
        self._roll_day()
        if self._exhausted():
            raise AIError("daily AI token budget reached; resets at 00:00 UTC")
        data = json.dumps(body).encode()
        headers = {"Content-Type": "application/json", "x-api-key": self._key, "anthropic-version": API_VERSION}
        if "fallbacks" in body:
            headers["anthropic-beta"] = FALLBACK_BETA
        delay = 2.0
        for attempt in range(3):
            req = urllib.request.Request(API_URL, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    out = json.loads(resp.read(20_000_000))
                self._charge(out.get("usage"))
                self.last_error = None
                return out
            except urllib.error.HTTPError as exc:
                code = exc.code
                retry = code in (408, 409, 429, 500, 502, 503, 504, 529)
                try:
                    detail = json.loads(exc.read(65536)).get("error", {}).get("type", "")
                except (ValueError, OSError, AttributeError):
                    detail = ""
                log(f"Claude API HTTP {code} {detail}")
                self.last_error = f"Claude API error {code}"
                if not retry or attempt == 2:
                    raise AIError(f"Claude API error {code} {detail}".strip()) from None
                ra = exc.headers.get("retry-after") if exc.headers else None
                time.sleep(min(30.0, float(ra)) if ra and ra.replace(".", "", 1).isdigit() else delay)
                delay *= 2
            except (urllib.error.URLError, OSError, ValueError) as exc:
                log(f"Claude API connection error {type(exc).__name__}")
                self.last_error = "Claude API unreachable"
                if attempt == 2:
                    raise AIError("Claude API unreachable") from None
                time.sleep(delay)
                delay *= 2
        raise AIError("Claude API unavailable")

    def _base(self, effort, max_tokens, model=None):
        model = model or self.model
        body = {"model": model, "max_tokens": max_tokens, "thinking": {"type": "adaptive"},
                "output_config": {"effort": effort},
                "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]}
        if model in FALLBACK_MODELS:
            body["fallbacks"] = "default"
        return body

    # -- chat
    def chat(self, history):
        """history: [{role: user|assistant, content: str}], last item from the user."""
        msgs = []
        for m in history[-16:]:
            role = m.get("role")
            text = str(m.get("content") or "").strip()[:6000]
            if role in ("user", "assistant") and text:
                if msgs and msgs[-1]["role"] == role:
                    msgs[-1]["content"] += "\n\n" + text
                else:
                    msgs.append({"role": role, "content": text})
        while msgs and msgs[0]["role"] != "user":
            msgs.pop(0)
        if not msgs or msgs[-1]["role"] != "user":
            raise AIError("the last message must be from the user")
        if not self.chat_slots.acquire(blocking=False):
            raise AIError("assistant is busy, try again in a moment")
        try:
            state = self.get_state()
            tools = ReadOnlyTools(state)
            stamp = f"[Dashboard time: {fmt_pkt(state.get('serverTime'))}]"
            msgs[-1] = {"role": "user", "content": [{"type": "text", "text": stamp}, {"type": "text", "text": msgs[-1]["content"]}]}
            used, model = [], self.chat_model
            for _ in range(MAX_TOOL_ROUNDS):
                body = self._base(self.chat_effort, 16000, self.chat_model) | {"tools": TOOLS, "messages": msgs}
                resp = self._call(body)
                model = resp.get("model") or model
                stop = resp.get("stop_reason")
                content = resp.get("content") or []
                if stop == "refusal":
                    return {"reply": "I can't help with that request.", "tools": used, "model": model}
                if stop == "tool_use":
                    msgs.append({"role": "assistant", "content": _echo_content(content)})
                    results = []
                    for blk in content:
                        if blk.get("type") == "tool_use":
                            used.append(blk.get("name"))
                            data = json.dumps(tools.run(blk.get("name"), blk.get("input")), default=str, separators=(",", ":"))
                            if len(data) > MAX_TOOL_RESULT_CHARS:
                                data = data[:MAX_TOOL_RESULT_CHARS] + "…(truncated; ask a narrower question)"
                            results.append({"type": "tool_result", "tool_use_id": blk.get("id"), "content": data})
                    msgs.append({"role": "user", "content": results})
                    continue
                text = "\n".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
                if stop == "max_tokens":
                    text += "\n\n_(answer truncated)_"
                return {"reply": scrub_string_long(text) or "(no answer)", "tools": used, "model": model}
            return {"reply": "I looked through a lot of data without reaching an answer — please ask a narrower question.",
                    "tools": used, "model": model}
        finally:
            self.chat_slots.release()

    # -- analysis
    def request_refresh(self, now=None):
        now = now or time.time()
        if now - self.last_refresh_request < self.refresh_cooldown:
            return False
        self.last_refresh_request = now
        threading.Thread(target=self.analyze, kwargs={"force": True}, daemon=True).start()
        return True

    def due(self, dig_hash, now):
        a = self.analysis or {}
        last = a.get("generatedAt") or 0
        if now - last < self.min_interval:
            return False
        return a.get("digestHash") != dig_hash or now - last > self.max_age

    def analyze(self, force=False):
        if not self.enabled or not self.analysis_lock.acquire(blocking=False):
            return None
        try:
            state = self.get_state()
            text = digest(state)
            dig_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
            now = time.time()
            if not force and not self.due(dig_hash, now):
                return self.analysis
            if force and self.analysis and now - (self.analysis.get("generatedAt") or 0) < 60:
                return self.analysis
            rules = [{k: f.get(k) for k in ("severity", "area", "title", "reason", "evidence")}
                     for f in (state.get("insights") or {}).get("rules") or []]
            prompt = (f"{ANALYSIS_INSTRUCTIONS}\n\nDashboard time: {fmt_pkt(now)}\n\n"
                      f"<rule_findings>\n{json.dumps(rules, separators=(',', ':'))}\n</rule_findings>\n\n"
                      f"<state_digest>\n{text}\n</state_digest>")
            body = self._base(self.analysis_effort, 16000, self.analysis_model)
            body["output_config"]["format"] = {"type": "json_schema", "schema": ANALYSIS_SCHEMA}
            body["messages"] = [{"role": "user", "content": prompt}]
            try:
                resp = self._call(body, timeout=300)
            except AIError as exc:
                log(f"analysis failed: {exc}")
                return self.analysis
            if resp.get("stop_reason") in ("refusal", "max_tokens"):
                self.last_error = f"analysis stopped: {resp.get('stop_reason')}"
                return self.analysis
            raw = "".join(b.get("text", "") for b in resp.get("content") or [] if b.get("type") == "text")
            try:
                data = json.loads(raw)
            except ValueError:
                self.last_error = "analysis returned invalid JSON"
                return self.analysis
            result = {"generatedAt": now, "model": resp.get("model") or self.analysis_model, "digestHash": dig_hash,
                      "summary": scrub_string(str(data.get("summary") or ""))[:1500],
                      "warnings": [_clean_item(i) | {"kind": "warning"} for i in (data.get("warnings") or [])[:12] if isinstance(i, dict)],
                      "suggestions": [_clean_item(i) | {"kind": "suggestion"} for i in (data.get("suggestions") or [])[:12] if isinstance(i, dict)],
                      "usage": {k: (resp.get("usage") or {}).get(k) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens")}}
            self.analysis = result
            try:
                tmp = self.path + ".tmp"
                with open(tmp, "w") as fh:
                    json.dump(result, fh)
                os.replace(tmp, self.path)
            except OSError:
                pass
            return result
        finally:
            self.analysis_lock.release()

    def start_background(self, interval=60):
        if not self.enabled:
            return

        def loop():
            time.sleep(20)
            while True:
                try:
                    self.analyze()
                except Exception as exc:  # keep the loop alive
                    log(f"background analysis error {type(exc).__name__}")
                time.sleep(interval)

        threading.Thread(target=loop, daemon=True, name="ai-analysis").start()


def scrub_string_long(text):
    """scrub_string truncates at 4000 chars; replies can be longer, so scrub in chunks."""
    return "".join(scrub_string(text[i:i + 3500]).rstrip("…") for i in range(0, min(len(text), 40000), 3500))
