# Dashboard critical bootstrap

## Objective

The dashboard's first visible render uses one authenticated SSR request to `GET /api/dashboard/bootstrap`.
The response contains the stats, activity, first four accessible projects, upcoming meetings, deadlines, and the
current user's open tasks. Revenue-chart history remains a post-paint request to
`GET /api/dashboard/revenue-chart`.

## Request path

Before:

```text
SSR dashboard
  +-- /api/dashboard/stats
  +-- /api/dashboard/activity
  +-- /api/v1/projects
  +-- /api/v1/meetings/upcoming
  +-- /api/dashboard/deadlines
  +-- /api/dashboard/my-tasks

After first paint
  +-- /api/dashboard/revenue-chart
```

After:

```text
SSR dashboard
  +-- /api/dashboard/bootstrap

After first paint
  +-- /api/dashboard/revenue-chart
```

The six critical HTTP requests previously repeated authentication and connection acquisition. Their data paths
also executed about twelve SQL statements in total: the stats route alone could execute up to six, and
meeting attendee hydration required a second statement. The bootstrap resolves its principal once, reuses the
same FastAPI connection dependency, and executes one PostgreSQL statement for all critical data.

## SQL shape

The statement uses permission-gated CTEs for project, task, team, and finance stats; bounded CTEs for projects,
activity, deadlines, and tasks; and a recursive CTE for recurring meetings. PostgreSQL JSON construction returns
the complete critical response in one row. Project members/counts and meeting attendees/attendance are correlated
subqueries inside that statement, not application-side N+1 queries.

Bounds are unchanged from the compatible endpoints:

- Projects: four most recently updated accessible projects.
- Activity: twenty most recent permitted records.
- Meetings: fifty upcoming occurrences attended by the principal.
- Deadlines: ten incomplete future milestones.
- Tasks: eight assigned, non-Done tasks.

## Permission parity

| Dataset | ADMIN session | Non-admin session | Scoped API token |
| --- | --- | --- | --- |
| Stats projects | All projects | Member projects | Requires `projects:read` |
| Stats tasks | All tasks | Assigned tasks | Requires `tasks:read` |
| Pending leave | All pending | Principal's pending | Requires `team:read` |
| Finance KPI totals | ADMIN only | Empty | ADMIN plus `finance:read` |
| Activity | All entities | Principal's activity | Entity types allowed by scopes |
| Projects/deadlines | All accessible | Project membership | Requires `projects:read` |
| Meetings | Principal attendance | Principal attendance | Requires `meetings:read` |
| My tasks | Principal assignment | Principal assignment | Requires `tasks:read` |

When a token lacks the project or meeting scope, the bootstrap mirrors the previous aggregate loader's rejected
optional request behavior with an empty collection and a `failedDatasets` entry. The service also clears any
out-of-scope data after query decoding as defense in depth.

## Browser freshness and hydration

Nuxt serializes the authenticated SSR result in its normal page payload. Hydration reads that payload and does
not issue another bootstrap request. A 45-second in-memory browser cache covers short client-side navigations.
The cache is keyed by the authenticated user id, removes entries belonging to another user, never stores bearer
credentials, and is never used as a server-global cache. Manual refresh returns `undefined` from the cache hook,
which forces a network request.

## Verification

Run:

```sh
.venv/bin/python -m pytest backend/tests/test_dashboard_bootstrap.py
bun test ./tests/dashboard-loading.test.mjs
bun run format:check
bun run typecheck
bun run verify
bun run build
```

For an authenticated connected-database benchmark, provide the dedicated test credentials through environment
variables as documented in `docs/performance/README.md`, then run:

```sh
PERF_SCREENSHOTS=1 bun run perf:smoke
```

Benchmark reports and sanitized request traces are written beneath `.perf/`. They must show one critical
`/api/dashboard/bootstrap` request, no hydration duplicate, and a post-paint/non-blocking revenue-chart request.

## Connected benchmark result

The authenticated client-transition benchmark used the same connected database as the 5,012 ms baseline and a
45-second-expired dashboard cache. First-visible content completed in **2,421.8 ms**, a **51.7% improvement** and
within the 2,500 ms target. The browser recorded exactly one critical bootstrap request and zero hydration
duplicates. Revenue-chart loading began at 2,431.6 ms, after first-visible content, and completed independently.

The critical bootstrap SQL statement took 928.22 ms in a direct warm connected-database probe and used one SQL
execute round trip. With a session principal, the complete request uses at most two executes (one authentication
lookup and one critical-data statement) through one connection checkout.

Reference screenshots:

- `.perf/dashboard-bootstrap/dashboard-1440x900.png`
- `.perf/dashboard-bootstrap/dashboard-390x844.png`
