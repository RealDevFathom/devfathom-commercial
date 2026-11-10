#!/usr/bin/env python3
"""DevFathom campaign ops-box collector (READ-ONLY).

Runs on the ops box (`--loop 60`) using the already-configured `aws` and `gh` CLIs.
Only describe/list/view and `gh api` GET calls are allowed: every command goes through
`run_ro`, which refuses anything outside an explicit whitelist. Linear is queried with a
read-only GraphQL `query` when LINEAR_API_KEY is set, and skipped otherwise.

Environment:
  DASH_URL, INGEST_TOKEN    dashboard ingest endpoint + bearer token (required to push)
  WORKER_INSTANCE_ID        primary worker EC2 instance id
  AWS_REGION                default eu-north-1
  GH_REPO                   default RealDevFathom/devfathom-commercial
  LINEAR_API_KEY            optional, read-only Linear access
  BOX_STATE_DIR             default ~/.local/state/ops-box-collector
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
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sanitize import sanitize  # noqa: E402

SCHEMA = 1
DEFAULT_REPO = "RealDevFathom/devfathom-commercial"
DEFAULT_REGION = "eu-north-1"
ISSUE_REF = re.compile(r"\bDEV-\d{1,6}\b")
INSTANCE_RE = re.compile(r"^i-[0-9a-f]{8,17}$")
IDENT_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}-\d{1,6}$")
LINEAR_ENDPOINT = "https://api.linear.app/graphql"

AWS_ALLOWED = {
    ("ec2", "describe-instances"),
    ("ec2", "describe-spot-price-history"),
    ("ec2", "describe-spot-instance-requests"),
}
GH_ALLOWED_SUB = {("api",), ("pr", "list"), ("pr", "view"), ("issue", "list"), ("issue", "view")}
GH_FORBIDDEN_FLAGS = {"-f", "-F", "--field", "--raw-field", "--input", "--method"}


def log(msg):
    print(f"[ops-box-collector] {msg}", file=sys.stderr, flush=True)


def check_readonly(argv):
    """Raise PermissionError unless argv is a whitelisted read-only aws/gh call."""
    argv = list(argv)
    if not argv:
        raise PermissionError("empty command")
    tool = argv[0]
    if tool == "aws":
        positional = [a for a in argv[1:] if not a.startswith("-")]
        if tuple(positional[:2]) not in AWS_ALLOWED:
            raise PermissionError("aws subcommand not allowed")
        return
    if tool == "gh":
        if tuple(argv[1:2]) == ("api",):
            for i, a in enumerate(argv):
                if a in GH_FORBIDDEN_FLAGS or a.startswith(("--field=", "--raw-field=", "--method=", "--input=")):
                    raise PermissionError("gh api write flag not allowed")
                if a in ("-X",) and (i + 1 >= len(argv) or argv[i + 1].upper() != "GET"):
                    raise PermissionError("gh api only allows -X GET")
                if a.startswith("-X") and len(a) > 2 and a[2:].upper() != "GET":
                    raise PermissionError("gh api only allows -X GET")
            if "-X" not in argv and "-XGET" not in argv:
                raise PermissionError("gh api calls must pass -X GET explicitly")
            return
        if tuple(argv[1:3]) in GH_ALLOWED_SUB:
            return
        raise PermissionError("gh subcommand not allowed")
    raise PermissionError("tool not allowed")


def run_ro(argv, timeout=30):
    check_readonly(argv)
    res = subprocess.run(list(argv), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         timeout=timeout, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"{argv[0]} {argv[1]} exited {res.returncode}")
    return json.loads(res.stdout) if res.stdout.strip() else None


def iso_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --------------------------------------------------------------------------- AWS

def aws(region, *args):
    return run_ro(["aws", *args, "--region", region, "--output", "json"])


def collect_workers(region, instance_id):
    ids = []
    if instance_id and INSTANCE_RE.match(instance_id):
        ids.append(instance_id)
    reservations = []
    try:
        if ids:
            reservations += (aws(region, "ec2", "describe-instances", "--instance-ids", *ids) or {}).get("Reservations", [])
        reservations += (aws(region, "ec2", "describe-instances", "--filters",
                             "Name=tag:Name,Values=devfathom-qa*",
                             "Name=instance-state-name,Values=pending,running,stopping,stopped") or {}
                         ).get("Reservations", [])
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        log(f"describe-instances failed: {exc}")
        return None
    workers, seen = [], set()
    for r in reservations:
        for inst in r.get("Instances", []):
            iid = inst.get("InstanceId")
            if not iid or iid in seen:
                continue
            seen.add(iid)
            name = next((t.get("Value") for t in inst.get("Tags", []) if t.get("Key") == "Name"), None)
            workers.append({
                "instanceId": iid,
                "name": name,
                "primary": iid == instance_id,
                "state": (inst.get("State") or {}).get("Name"),
                "instanceType": inst.get("InstanceType"),
                "az": (inst.get("Placement") or {}).get("AvailabilityZone"),
                "launchTime": iso_ts(inst.get("LaunchTime")),
                "lifecycle": inst.get("InstanceLifecycle") or "on-demand",
                "spotRequestId": inst.get("SpotInstanceRequestId"),
            })
    for w in workers:
        if w["instanceType"] and w["az"]:
            try:
                hist = aws(region, "ec2", "describe-spot-price-history", "--instance-types", w["instanceType"],
                           "--availability-zone", w["az"], "--product-descriptions", "Linux/UNIX",
                           "--start-time", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                           "--max-items", "1") or {}
                prices = hist.get("SpotPriceHistory") or []
                if prices:
                    w["spotPrice"] = float(prices[0].get("SpotPrice"))
                    w["spotPriceAt"] = iso_ts(prices[0].get("Timestamp"))
            except (RuntimeError, OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
                log(f"spot price failed: {exc}")
        if w.get("spotRequestId"):
            try:
                req = (aws(region, "ec2", "describe-spot-instance-requests", "--spot-instance-request-ids",
                           w["spotRequestId"]) or {}).get("SpotInstanceRequests") or []
                if req:
                    w["spotRequestState"] = req[0].get("State")
                    w["spotRequestStatus"] = (req[0].get("Status") or {}).get("Code")
                    w["spotMaxPrice"] = req[0].get("SpotPrice")
            except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
                log(f"spot request failed: {exc}")
    workers.sort(key=lambda w: (not w["primary"], w["instanceId"]))
    return workers


def update_machine_history(state, workers, now, interval):
    m = state.setdefault("machine", {"hours": 0.0, "costUsd": 0.0, "since": now, "perInstance": {}})
    last = state.get("lastSampleAt")
    elapsed = min(max(0.0, now - last), 2.5 * interval) if last else 0.0
    for w in workers or []:
        if w.get("state") != "running":
            continue
        price = w.get("spotPrice") if w.get("lifecycle") == "spot" else None
        hrs = elapsed / 3600.0
        per = m["perInstance"].setdefault(w["instanceId"], {"hours": 0.0, "costUsd": 0.0})
        per["hours"] += hrs
        m["hours"] += hrs
        if price:
            per["costUsd"] += hrs * price
            m["costUsd"] += hrs * price
    state["lastSampleAt"] = now
    return {"hours": round(m["hours"], 2), "costUsd": round(m["costUsd"], 2), "since": m["since"],
            "perInstance": {k: {"hours": round(v["hours"], 2), "costUsd": round(v["costUsd"], 2)}
                            for k, v in m["perInstance"].items()}}


# --------------------------------------------------------------------------- GitHub

def gh_get(path):
    return run_ro(["gh", "api", "-X", "GET", "-H", "Accept: application/vnd.github+json", path])


def refs(*texts):
    found = []
    for t in texts:
        for m in ISSUE_REF.findall(t or ""):
            if m not in found:
                found.append(m)
    return found


def collect_github(repo, now, days=30):
    out = {"repo": repo, "merged": [], "closedIssues": []}
    cutoff = now - days * 86400
    since = datetime.fromtimestamp(cutoff, timezone.utc).strftime("%Y-%m-%d")
    try:
        tip = gh_get(f"repos/{repo}/commits/develop") or {}
        out["developSha"] = tip.get("sha")
        out["developAt"] = iso_ts(((tip.get("commit") or {}).get("committer") or {}).get("date"))
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        log(f"develop tip failed: {exc}")
    for page in range(1, 6):
        try:
            pulls = gh_get(f"repos/{repo}/pulls?state=closed&base=develop&sort=updated&direction=desc"
                           f"&per_page=100&page={page}") or []
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
            log(f"pulls failed: {exc}")
            break
        for pr in pulls:
            merged_at = iso_ts(pr.get("merged_at"))
            if merged_at and merged_at >= cutoff:
                out["merged"].append({
                    "number": pr.get("number"), "title": (pr.get("title") or "")[:200],
                    "mergedAt": merged_at, "sha": pr.get("merge_commit_sha"),
                    "issues": refs(pr.get("title"), (pr.get("head") or {}).get("ref"), pr.get("body")),
                })
        if len(pulls) < 100 or (iso_ts(pulls[-1].get("updated_at")) or 0) < cutoff:
            break
    out["merged"].sort(key=lambda p: p["mergedAt"], reverse=True)
    q = urllib.parse.quote(f"repo:{repo} is:issue is:closed closed:>={since}")
    for page in range(1, 6):
        try:
            res = gh_get(f"search/issues?q={q}&per_page=100&page={page}") or {}
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
            log(f"issue search failed: {exc}")
            break
        items = res.get("items") or []
        for it in items:
            ids = refs(it.get("title"), it.get("body"))
            if not ids:
                continue
            out["closedIssues"].append({"number": it.get("number"), "title": (it.get("title") or "")[:200],
                                        "closedAt": iso_ts(it.get("closed_at")), "issues": ids,
                                        "stateReason": it.get("state_reason")})
        if len(items) < 100:
            break
    out["closedIssues"].sort(key=lambda i: i.get("closedAt") or 0, reverse=True)
    return out


# --------------------------------------------------------------------------- Linear

def known_issue_ids():
    """Issue ids the worker has seen, fetched from the dashboard with the ingest token."""
    base = os.environ.get("DASH_URL", "").rstrip("/")
    token = os.environ.get("INGEST_TOKEN", "")
    if not base or not token:
        return []
    req = urllib.request.Request(f"{base}/api/known-issues", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read(2_000_000))
            return [i for i in data.get("issues", []) if isinstance(i, str) and IDENT_RE.match(i)]
    except (urllib.error.URLError, OSError, ValueError) as exc:
        log(f"known-issues fetch failed: {type(exc).__name__}")
        return []


def linear_query(api_key, query):
    if not query.lstrip().startswith("query"):
        raise PermissionError("only GraphQL queries are allowed")
    req = urllib.request.Request(LINEAR_ENDPOINT, data=json.dumps({"query": query}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": api_key})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read(5_000_000))


def collect_linear(identifiers):
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        return {"available": False, "reason": "LINEAR_API_KEY not set", "states": {}}
    ids = sorted({i for i in identifiers if IDENT_RE.match(i)})
    states = {}
    for chunk_start in range(0, len(ids), 50):
        chunk = ids[chunk_start:chunk_start + 50]
        parts = [f'q{n}: issue(id: "{ident}") {{ identifier state {{ name type }} completedAt canceledAt }}'
                 for n, ident in enumerate(chunk)]
        try:
            res = linear_query(api_key, "query {\n" + "\n".join(parts) + "\n}")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            log(f"linear query failed: {type(exc).__name__}")
            return {"available": False, "reason": "query failed", "states": states}
        for val in (res.get("data") or {}).values():
            if isinstance(val, dict) and val.get("identifier"):
                st = val.get("state") or {}
                states[val["identifier"]] = {"state": st.get("name"), "type": st.get("type"),
                                             "completedAt": iso_ts(val.get("completedAt")),
                                             "canceledAt": iso_ts(val.get("canceledAt"))}
    return {"available": True, "states": states}


# --------------------------------------------------------------------------- main

def state_dir():
    d = os.environ.get("BOX_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".local", "state",
                                                          "ops-box-collector")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def load_state(d):
    try:
        with open(os.path.join(d, "history.json")) as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(d, data):
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".history.")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, os.path.join(d, "history.json"))


def collect(interval=60):
    now = time.time()
    region = os.environ.get("AWS_REGION") or DEFAULT_REGION
    repo = os.environ.get("GH_REPO") or DEFAULT_REPO
    sdir = state_dir()
    state = load_state(sdir)
    workers = collect_workers(region, os.environ.get("WORKER_INSTANCE_ID", ""))
    machine = update_machine_history(state, workers, now, interval)
    github = collect_github(repo, now)
    ids = set(known_issue_ids())
    for item in github["merged"] + github["closedIssues"]:
        ids.update(item.get("issues") or [])
    linear = collect_linear(ids)
    save_state(sdir, state)
    return sanitize({"schema": SCHEMA, "collector": "box", "collectedAt": now, "repo": repo, "region": region,
                     "workers": workers, "machine": machine, "github": github, "linear": linear})


def push(payload):
    base = os.environ.get("DASH_URL", "").rstrip("/")
    token = os.environ.get("INGEST_TOKEN", "")
    if not base or not token:
        log("DASH_URL/INGEST_TOKEN not set; skipping push")
        return False
    req = urllib.request.Request(f"{base}/api/ingest/box", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            log(f"pushed -> HTTP {resp.status}")
            return True
    except urllib.error.HTTPError as exc:
        log(f"push failed: HTTP {exc.code}")
    except (urllib.error.URLError, OSError) as exc:
        log(f"push failed: {type(exc).__name__}")
    return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--loop", type=int, default=0, help="collect every N seconds (e.g. 60)")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--print", action="store_true", help="print payload instead of pushing")
    args = ap.parse_args(argv)
    interval = args.loop or 60
    while True:
        started = time.time()
        try:
            payload = collect(interval)
            if args.print:
                print(json.dumps(payload, indent=2))
            else:
                push(payload)
        except Exception as exc:  # keep looping on transient failures
            log(f"collect failed: {type(exc).__name__}: {exc}")
        if args.once or not args.loop:
            return 0
        time.sleep(max(5.0, interval - (time.time() - started)))


if __name__ == "__main__":
    sys.exit(main())
