# DevFathom Campaign Ops Dashboard

A private, **read-only** monitoring dashboard for the Codex / machine-gate campaign that fixes
Linear/GitHub issues in batches and merges them into `develop`. It covers every batch automatically:
each job root under `/workspace/jobs/` is a batch, and each `codex-*` / `gates-*` / `baseline-*`
directory inside it is a run. New roots and runs appear on the next collection with no config change,
and historical batches are kept.

```
 worker (Ubuntu, root)                      ops box (Inky)
 ┌────────────────────────────┐             ┌──────────────────────────────┐
 │ worker_collector.py  (30 s)│             │ box_collector.py --loop 60   │
 │  reads /workspace/jobs,    │             │  aws ec2 describe-* (RO)     │
 │  /proc, statvfs, systemctl │             │  gh api -X GET (RO), Linear  │
 └─────────────┬──────────────┘             └──────────────┬───────────────┘
               │ POST /api/ingest/worker (Bearer)          │ POST /api/ingest/box
               ▼                                           ▼
        ┌──────────────────────────────────────────────────────────┐
        │ server/app.py  (ECS Fargate, port 8080, stdlib only)      │
        │  /healthz · Basic-auth UI + /api/state · sanitised store  │
        └──────────────────────────────────────────────────────────┘
```

Everything is Python 3 standard library plus vanilla JS. There are no external CDNs or fonts.

## Layout

| Path | What |
|---|---|
| `server/app.py` | HTTP server: auth, ingest, state merge, alerts |
| `server/ai.py` | Claude layer: read-only tools, chat loop, cached analysis, budgets |
| `server/insights.py` | Deterministic warning / suggestion rules |
| `server/sanitize.py` | Sanitiser (byte-identical copy of `collector/sanitize.py`) |
| `server/static/` | `index.html`, `app.css`, `app.js` (UI: inline SVG charts, CSP `'self'` only) |
| `server/Dockerfile` | `python:3.12-slim`, non-root uid 10001, port 8080, linux/amd64 |
| `collector/worker_collector.py` | Worker collector (read-only) |
| `collector/box_collector.py` | Ops-box collector (whitelisted read-only `aws`/`gh`) |
| `collector/systemd/` | `ops-collector.service` + `.timer` (worker), `ops-box-collector.service` (optional, ops box) |
| `collector/ops-collector.env.example` | Env file template (placeholders only) |
| `deploy/ecs-task-def.template.json` | Fargate task definition template (0.25 vCPU / 0.5 GB) |
| `fixtures/` | Fake data that mirrors the real layout |
| `tests/` | stdlib `unittest`: sanitiser, batch discovery, auth/ingest, AI layer (fake Anthropic endpoint, no network) |

## Run locally with fixtures

```bash
cd ops/campaign-dashboard
```

```bash
python3 -m unittest discover -s tests -v
```

Start the server in a separate terminal:

```bash
DASH_USER=ops DASH_PASSWORD=devpass INGEST_TOKEN=devtoken DATA_DIR=/tmp/dash PORT=8080 python3 server/app.py
```

Print what the worker collector would send (no push). `--live-window 0` treats the static fixture ledgers as live:

```bash
python3 collector/worker_collector.py --root fixtures/jobs --once --print --live-window 0 --state-dir /tmp/ops-collector-state
```

Push the fixtures into the local server:

```bash
DASH_URL=http://localhost:8080 INGEST_TOKEN=devtoken python3 collector/worker_collector.py --root fixtures/jobs --once --live-window 0 --state-dir /tmp/ops-collector-state --env-file /dev/null
```

```bash
curl -s -X POST -H 'Authorization: Bearer devtoken' -H 'Content-Type: application/json' --data-binary @fixtures/box.json http://localhost:8080/api/ingest/box
```

Open http://localhost:8080 and log in as `ops` / `devpass`.

## Deploy

All commands run from the repository root. Replace every `<PLACEHOLDER>`. Region is `eu-north-1`.

### 1. Secrets (once)

```bash
aws secretsmanager create-secret --region eu-north-1 --name campaign-dashboard/DASH_PASSWORD --secret-string "$(openssl rand -base64 24)"
```

```bash
aws secretsmanager create-secret --region eu-north-1 --name campaign-dashboard/INGEST_TOKEN --secret-string "$(openssl rand -hex 32)"
```

The ECS **execution role** needs `secretsmanager:GetSecretValue` on both secret ARNs. It also needs
the standard `AmazonECSTaskExecutionRolePolicy` (ECR pull and CloudWatch Logs).

### 2. Build and push the image

```bash
aws ecr create-repository --region eu-north-1 --repository-name campaign-dashboard
```

```bash
aws ecr get-login-password --region eu-north-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com
```

```bash
docker build --platform linux/amd64 -t <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com/campaign-dashboard:<TAG> ops/campaign-dashboard/server
```

```bash
docker push <ACCOUNT_ID>.dkr.ecr.eu-north-1.amazonaws.com/campaign-dashboard:<TAG>
```

### 3. Task definition and service

Copy `deploy/ecs-task-def.template.json` to `taskdef.json`. Fill in the account id, role names, image tag
and the full secret ARNs (`aws secretsmanager describe-secret --name ... --query ARN`). Then register it:

```bash
aws ecs register-task-definition --region eu-north-1 --cli-input-json file://taskdef.json
```

```bash
aws ecs create-service --region eu-north-1 --cluster <CLUSTER> --service-name campaign-dashboard --task-definition campaign-dashboard --desired-count 1 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[<PRIVATE_SUBNET_IDS>],securityGroups=[<SG_ID>],assignPublicIp=DISABLED}" --load-balancers "targetGroupArn=<TG_ARN>,containerName=campaign-dashboard,containerPort=8080"
```

Put it behind an ALB **HTTPS** listener (ACM certificate). The target group health check path is
`/healthz` (expects `200 ok`). Restrict the ALB security group to the IPs that need the UI and to the
worker and ops-box egress addresses that post to `/api/ingest/*`. The server sends HSTS, so serve it
over HTTPS only. `TRUST_PROXY=1` (already in the template) makes the failed-login rate limit use the
client address from the ALB's `X-Forwarded-For`.

To redeploy after a new image, register the task definition again with the new tag, then:

```bash
aws ecs update-service --region eu-north-1 --cluster <CLUSTER> --service campaign-dashboard --task-definition campaign-dashboard --force-new-deployment
```

Data note: the latest payload per source is persisted to `DATA_DIR=/data` inside the task. A process
restart reloads it, but a new task starts empty and fills again within 30–60 s from the collectors.

### 4. Worker collector (on the worker, as root)

```bash
install -d -m 0755 /opt/ops-collector && install -m 0644 ops/campaign-dashboard/collector/worker_collector.py ops/campaign-dashboard/collector/sanitize.py /opt/ops-collector/
```

```bash
install -m 0600 ops/campaign-dashboard/collector/ops-collector.env.example /etc/ops-collector.env
```

Edit `/etc/ops-collector.env`: set `DASH_URL=https://<dashboard-host>` and `INGEST_TOKEN=<value of the INGEST_TOKEN secret>`.

```bash
install -m 0644 ops/campaign-dashboard/collector/systemd/ops-collector.service ops/campaign-dashboard/collector/systemd/ops-collector.timer /etc/systemd/system/
```

```bash
systemctl daemon-reload && systemctl enable --now ops-collector.timer
```

Check it:

```bash
systemctl list-timers ops-collector.timer && journalctl -u ops-collector.service -n 20 --no-pager
```

The unit runs at `Nice=19`, `IOSchedulingClass=idle`, `CPUQuota=15%`, `MemoryMax=256M`,
`ProtectSystem=strict`, `ReadOnlyPaths=/workspace` and `ReadWritePaths=/var/lib/ops-collector`.
The collector only reads campaign files. It never writes under `/workspace`, never starts, stops or
kills anything, and never calls git, gh or codex. Its only subprocesses are whitelisted read-only
`systemctl list-units|show` calls and, every 5 minutes, `ip netns exec codex-home tailscale ... status --json`.
Only pass/fail is reported from that check, never an address.

### 5. Ops-box collector (on Inky's ops box, as the user that has `aws` and `gh` configured)

```bash
mkdir -p ~/ops-collector ~/.config && cp ops/campaign-dashboard/collector/box_collector.py ops/campaign-dashboard/collector/sanitize.py ~/ops-collector/
```

Create `~/.config/ops-box-collector.env` (mode 600) with `DASH_URL`, `INGEST_TOKEN`, `WORKER_INSTANCE_ID`,
and optionally `LINEAR_API_KEY`. The commented section of `ops-collector.env.example` shows the format. Then
either run it directly:

```bash
set -a; . ~/.config/ops-box-collector.env; set +a; python3 ~/ops-collector/box_collector.py --loop 60
```

or as a user service:

```bash
mkdir -p ~/.config/systemd/user && cp ops/campaign-dashboard/collector/systemd/ops-box-collector.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now ops-box-collector
```

The box collector refuses any `aws` call except `ec2 describe-instances|describe-spot-price-history|describe-spot-instance-requests`.
It refuses any `gh` call except `gh api -X GET ...` (no `-f/-F/--input`) and `pr|issue list|view`. Linear is a GraphQL
`query` only, and is skipped when `LINEAR_API_KEY` is unset.

## Claude assistant (AI layer)

The **Ask Claude** button opens a chat drawer. Claude (`claude-opus-5-5` by default, adaptive thinking,
server-side refusal fallbacks) answers questions about past, current and upcoming work. It uses
**read-only tools** over the same data the dashboard shows: overview, batches, tasks, live Codex and
gate runs, the queue, worker metrics, GitHub and Linear state, and the event history. Answers link to
the evidence (for example `#task=<batch>/<issue>`, `#pr=994` or `#metric=memPct`); clicking a link
opens the matching drill-down.

* **Server-side only.** The key is read from `ANTHROPIC_API_KEY`, which the ECS task injects from Secrets
  Manager. It is sent only to `api.anthropic.com`. It is never logged and never sent to the browser
  (`/api/state` exposes only `ai.enabled` and the model name). Without the variable the AI layer is off
  and the button is hidden.
* **Read-only.** Every tool is a pure function over the in-memory snapshot. There are no action
  endpoints, and the system prompt forbids claiming or offering actions. Rendered answers keep only
  links to dashboard routes or this repository on GitHub.
* **Cost controls** (env, defaults in brackets): `AI_DAILY_TOKEN_BUDGET` [3,000,000 weighted tokens/day,
  cache reads count 10 %], `AI_CHAT_PER_MIN` [6] and `AI_CHAT_PER_DAY` [150] per client IP,
  `AI_MAX_CONCURRENT` [2], at most 8 tool rounds per answer, a cached system prompt and tools,
  `AI_CHAT_EFFORT` [medium] / `AI_ANALYSIS_EFFORT` [high], and the per-task models below.
* **CSRF.** `POST /api/ai/*` needs Basic auth, a same-origin `Origin` (when sent) and the custom
  `X-Requested-With: ops-dash` header.

### Model and effort per AI task

Each task picks its model and effort from the environment: `AI_CHAT_MODEL`, `AI_CHAT_EFFORT`,
`AI_ANALYSIS_MODEL` and `AI_ANALYSIS_EFFORT`. A model left unset falls back to `AI_MODEL`, and then to
`claude-opus-5-5`. Prices are per million input/output tokens. Per-call costs assume about 40k input
tokens for an analysis of a ~120-task campaign, and 10-30k input tokens for a chat answer with 2-4 tool rounds.

| Task | Recommended | Why | Alternatives |
|---|---|---|---|
| **Chat assistant** (interactive, tool use, read-only) | **Claude Opus 5.5, effort `medium`** (default). About $0.05-0.15 per answer at $4 / $20 | Strong multi-step reasoning over gates and SHAs with chat-friendly latency | **Sonnet 5.5, `medium`** ($2 / $10): about half the cost, fine for most questions. **Fable 5.2, `medium`** ($8 / $40): best answers on hard investigations, but about twice the cost and noticeably slower replies, so not the default for chat. **Haiku 5.5** ($0.10 / $0.50): cheapest, but too weak for multi-step tool use over the gate and merge rules |
| **Background warnings & suggestions** (structured JSON, at most every 15 min, only when data changed) | **Claude Opus 5.5, effort `high`** (default). About $0.30 per run | Low frequency and highest stakes: connecting failures across tasks and spotting weakened tests rewards deeper reasoning | **Fable 5.2, `high`**: the most capable option, about $0.60 per run, worth it if the budget allows. Raise `AI_DAILY_TOKEN_BUDGET` to match. **Sonnet 5.5, `medium`**: about $0.14 per run, for cost-sensitive periods. **Haiku 5.5**: not recommended; the analysis needs judgement, not just extraction |

Notes:
* **Fable 5.2:**
  * Thinking is always on and effort is the only control, so start at `high`.
  * Requests can run for minutes; the server allows up to 10 minutes per call for it.
  * It needs an organization with 30-day data retention; zero-data-retention orgs get a 400.
  * Structured outputs (used by the analysis) are unavailable in organizations that use customer-managed encryption keys.
* **Server-side refusal fallbacks** (`fallbacks: "default"`) are sent only to Fable 5.2/5.1, Opus 5.5/5 and Sonnet 5.5. Haiku 5.5 has none.
* **Daily budget:** a worst case of 96 analyses a day on Opus 5.5 is about $30/day, and about $60 on Fable 5.2. Both the chat and the
  analysis also stop at `AI_DAILY_TOKEN_BUDGET` (3,000,000 weighted tokens/day by default).

### Automatic warnings and suggestions

Two sources, merged and shown at the top of the screen they concern (Overview, Now, Next, Batches,
History, Machine). They also appear in the **Warnings & suggestions** section and inside the matching
task and batch drill-downs. Each item has a severity (`crit` / `warn` / `info`), a reason and evidence
links.

* **Rules** (`server/insights.py`): deterministic and free, evaluated on every `/api/state`:
  * stalled Codex jobs (> 3 h), gate steps running > 90 min, and ledgers not updated for 15 min while active
  * the same gate failing in ≥ 2 runs of a task, and gates failing across ≥ 3 tasks
  * tasks idle > 24 h
  * **weakened tests or guards**: changed test files, test/lint/TS configs, CI workflows, or auth,
    capability or middleware guards; or fewer passing unit tests than the baseline
  * Codex running machine checks while it is still coding
  * RAM, PSI, disk or `/workspace` reserve pressure before the hard alerts fire
  * spot price within 20 % of the cap, and weekly usage ≥ 85 %
  * suggestions: blocked tasks, gated-but-unmerged tasks, merged tasks whose issues are still open, idle Codex capacity
* **Claude analysis** (`server/ai.py`): a structured JSON (`json_schema`) review of a compact state digest
  plus the rule findings. It runs in the background only when the digest changed and at most every
  `AI_ANALYSIS_MIN_INTERVAL` seconds [900]. It is refreshed at least every `AI_ANALYSIS_MAX_AGE` seconds
  [21600], cached in memory and in `DATA_DIR/ai_analysis.json`, and capped by the daily token budget.
  The **Re-analyse** button (`POST /api/ai/refresh`) is limited to once per `AI_REFRESH_COOLDOWN`
  seconds [300]. Evidence links that are not dashboard routes or repository GitHub links are dropped.

Create the secret once and add its ARN to the task definition (already templated):

```bash
aws secretsmanager create-secret --region eu-north-1 --name campaign-dashboard/ANTHROPIC_API_KEY --secret-string '<key from the Claude Console>'
```

The task needs outbound HTTPS to `api.anthropic.com` (NAT gateway or an egress rule from the private subnets).

## Visual system

* Typography: **Geist** for the UI and **Geist Mono** only for SHAs. Both are bundled as variable WOFF2 in
  `server/static/fonts/` under the SIL OFL (licence alongside) and served by the dashboard itself. There is no
  CDN, and no element (including SVG chart text) falls back to a system monospace font.
* Icons: a vendored Phosphor sprite (`server/static/icons.svg`, MIT).
* Layout follows the OpsPulse "control room" reference (Orbix Studio). It is light and frosted by default: glass panels over a soft
  colour field, a pill icon nav and one yellow call to action. The sun/moon button switches to a dark theme, and the choice is
  remembered per browser. The top grid holds:
  * campaign progress;
  * the pipeline flow, with today's activity;
  * the **gate pulse**: the gate pass rate on final SHAs, plus required gates, differential, security, QA, tests and guards, and egress;
  * four micro-bar KPI cards: Codex jobs, spend, gate pass rate, and P95 gate step time;
  * a 30-day spend forecast with Codex slot capacity and weekly usage;
  * a live runs stream.
* Colour is reserved for state in both themes: green passed/done, red failed (always naming the gate), amber blocked or
  baseline-only failures, blue running, violet merged. Every status carries an icon and a label, never colour alone.
  The chart palettes were checked with a colour-vision-deficiency validator against both surfaces.
* Daily spend for the cost card comes from the ops-box collector (`machine.daily`); redeploy it to populate the chart.
* Motion: counters, flowing pipeline wires, live pulses and toasts. All of it is disabled under
  `prefers-reduced-motion`, and glass panels fall back to solid under `prefers-reduced-transparency`.
* Keyboard: `/` focuses search, `K` opens Claude, `Esc` closes panels.
* This ops tool intentionally uses Geist instead of the product's Instrument Sans / IBM Plex Mono
  (`docs/design-system/DEVFATHOM-STUDIO.md`), at the owner's request. It is a separate internal surface.

### Visual regression tests

`tests/test_visual.py` drives Chromium (Playwright) against the fixtures with a frozen clock. It checks fonts,
console errors and mobile overflow, a structural snapshot, and screenshot baselines in `tests/visual/baseline/`.
It skips when node or Playwright are unavailable. After an intended visual change, refresh the baselines:

```bash
UPDATE_SNAPSHOTS=1 python3 -m unittest tests.test_visual
```

## Security model

* `GET /healthz` returns only `ok`. Everything else needs auth: HTTP Basic (`DASH_USER` / `DASH_PASSWORD`,
  compared in constant time) for the UI and `/api/state`, and `Bearer INGEST_TOKEN` (constant time) for
  `POST /api/ingest/{worker,box}` and `GET /api/known-issues`. More than 10 failed attempts from one IP in
  5 min gets HTTP 429. If either secret is unset, that side is disabled.
* Ingest accepts `application/json` objects only, max 8 MB. The server sanitises again before storing and
  writes atomically to `DATA_DIR/<source>.json`.
* The sanitiser (collectors and server) drops keys matching
  `token|secret|password|passwd|apikey|api_key|authorization|cookie|credential|private|email|phone|ip(v4|v6)?$|host$|url$`.
  It redacts IPv4/IPv6 addresses, e-mails, `ghp_`/`gho_`/`sk-`/`xox` tokens and JWTs, and strips paths to
  the part after `/workspace/jobs/`.
* Response headers: strict CSP (`'self'` only, no inline script or style), `X-Frame-Options: DENY`, HSTS,
  `nosniff`, `no-referrer`, and `Cache-Control: no-store` on `/api`. Static files come from a fixed
  whitelist, so there is no directory listing. Logs record method, path and status only, never headers
  or bodies.

## Operators, Claude waves and superseded batches

* **Operator:** a batch's `OPERATOR.md` names who runs it. The dashboard reads its `Operator: <name>` line,
  or else its first heading, and shows it on the batch and in the control-room heading. The file itself opens as evidence.
* **Claude-operated waves:** `<batch>/wave<N>/` directories are runs; the newest one is the current run when no
  rebase overlay exists. `summary.json` (`{updatedPKT, rows: {"DEV-n": {status, sha, failedSteps, ...}}}`) is read like
  a ledger and each `DEV-*/result.json` like a checkpoint. `sha` is the candidate commit the gates ran on, so it is the
  task's SHA. A `DONE` marker or a stale `runner.log` ends liveness. Wave statuses map as follows:
  `BUILT` is queued or gating, `GATES_GREEN` passes the gates the wave ran, `GATES_GREEN_FEWER_TESTS` is **Failed: Test count**,
  `GATES_FAIL` is failed and names the step, `BUILD_ERROR` is failed, and `EMPTY_DIFF` and `INFRA` are blocked.
  Waves do not run the Docker contract, so a green wave task shows **Awaiting: Docker**, never Passed.
* **Canceled tasks:** `OPS_CANCELED=DEV-339,DEV-341` shows those tasks as Canceled and keeps them out of the counts.
* **Stop files bind their controller:** when `OPERATOR.md` names someone other than Inky, `*_STOP` pause files
  (for example `RETARGET1906_STOP`) are shown as an info note for Inky's lane, not as a campaign-paused alarm.
* **Superseded batches:** set `OPS_SUPERSEDED=rebase-1906-1110` (comma-separated) in `/etc/ops-collector.env`, or drop
  an empty `SUPERSEDED` file into the batch. The batch stays as history, but nothing in it counts as active, running or queued.
  Its unfinished tasks show as **Superseded**, and the warning rules skip it.
* **Services:** `claude-*` systemd units (for example `claude-wave1.service`) are watched with the others.

## Data model and gate vocabulary

* **Batch** = job root. **Run** = `codex-*` / `gates-*` / `baseline-*` directory. `*-attempt*` directories
  are not processed but are counted as history. `BASE-*` issues are baseline-fix jobs and are not tasks.
  The older `pharmacy-review-50/<ISSUE>/` layout, with `*-checkpoint.json` sub-gates, is a `review` run.
* Gate columns: prisma, typecheck, lint, complete_unit, host_build, docker, differential (unit failures
  minus baseline failures, by file), QA/browser, security, final SHA, merged, Linear closed, GH closed.
  Unknown step names become extra columns.
* **Done** = every required gate passes on the final SHA, the task is merged, and its issues are closed.
* Alerts: load > 0.9 × cores for 5 min, disk > 85 %, `/workspace` free < 200 GiB reserve, failed systemd
  units, kill-switch FAIL, data stale > 3 min, spot price > $2.50, weekly usage ≥ 95 %.
