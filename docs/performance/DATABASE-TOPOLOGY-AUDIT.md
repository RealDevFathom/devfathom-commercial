# Database topology and latency audit

## Decision

Keep FastAPI in Vercel Singapore (`sin1`) and place PostgreSQL in the same Singapore metro, specifically AWS `ap-southeast-1`. Use the provider's pooled endpoint with a deliberately small SQLAlchemy pool: two retained connections, no overflow, pre-ping enabled initially, and the existing 1,800-second recycle interval.

The production FastAPI deployment is verified in `sin1`. The configured managed PostgreSQL pooled/proxy endpoint is in AWS `us-east-1`. That is an intercontinental path of approximately 15,521 km. The database must be reprovisioned or migrated to `ap-southeast-1`, then the production secret must be rotated to the new pooled endpoint. That infrastructure action requires explicit user approval; this audit did not make it.

## Sanitized findings

Measurements were collected on 2026-07-22 from the repository's isolated FastAPI process using the configured database. One cold sample and 20 warm samples were collected for every repeated lifecycle. Only connection checks and `SELECT 1` were executed. No business table, connection string, DNS name, IP address, certificate, account identifier, or project identifier was recorded.

| Phase | Cold | Warm p50 | Warm p95 | Interpretation |
| --- | ---: | ---: | ---: | --- |
| DNS lookup | 1,117.19 ms | 0.98 ms | 2.83 ms | Cold resolver setup is material once; cached DNS is not the warm problem. |
| TCP connection | 226.06 ms | 218.41 ms | 229.93 ms | This is the intercontinental network round trip. |
| PostgreSQL SSL request and TLS handshake | 458.38 ms | 451.33 ms | 483.42 ms | Approximately two WAN round trips; relevant to new connections, not pooled warm queries. |
| Direct asyncpg connection establishment | 5,908.72 ms | — | — | Includes DNS, TCP, TLS, PostgreSQL startup, proxy routing, and authentication. |
| Authentication/provider-routing residual | 5,238.00 ms | — | — | Estimated as asyncpg connection total minus independently sampled warm DNS, TCP, and TLS phases. |
| First asyncpg `SELECT 1` on the new connection | 447.32 ms | — | — | The first execution is roughly two WAN round trips. |
| Reused asyncpg `SELECT 1` | — | 222.11 ms | 228.82 ms | Stable one-round-trip baseline; p95/p50 is 1.03. |
| SQLAlchemy cold pool checkout/new connection | 5,444.53 ms | — | — | A separate cold pool lifecycle; new connection setup dominates. |
| SQLAlchemy checkout including `pool_pre_ping` | — | 731.25 ms | 970.07 ms | Pool bookkeeping alone is only 0.08 ms p50. |
| `pool_pre_ping` itself | — | 731.16 ms | 969.98 ms | Three WAN round trips on the asyncpg dialect. |
| Health route's visible `SELECT 1` | — | 479.71 ms | 527.31 ms | Implicit transaction start plus the query: approximately two WAN round trips. |
| Connection return and transaction reset | — | 239.89 ms | 251.85 ms | Rollback/reset: approximately one WAN round trip. |
| FastAPI `/health` TTFB | 6,862.66 ms | 1,558.04 ms | 1,831.65 ms | Local HTTP to an isolated FastAPI process; all responses were HTTP 200 and database-connected. |

The SQLAlchemy pool refinement was collected immediately after the topology run because a second full network pass encountered a safely redacted transient probe failure. It contains its own cold sample and 20 warm samples. The two runs show the same stable one-way topology but modest WAN timing drift, so phase sums should be treated as a component model rather than timestamps from a single request.

## Why the warm request costs about 1.346 seconds

The warm health check is not one database round trip. SQLAlchemy 2.0.43's asyncpg adapter intentionally implements its ping as a transaction start, a ping query, and a rollback so it works with PgBouncer transaction mode. The first route query then starts an implicit transaction, executes `SELECT 1`, and rolls the transaction back when the connection returns to the pool.

That produces six intercontinental database round trips per health check:

1. `pool_pre_ping`: transaction start + ping + rollback, about three round trips.
2. Health `SELECT 1`: implicit transaction start + query, about two round trips.
3. Pool return/reset: rollback, about one round trip.

At the directly measured 222.11 ms reused-query p50, six round trips predict 1,332.66 ms before small application and HTTP overhead. That explains the earlier approximately 1.346-second observation. In the refinement run, WAN latency was slightly higher: 731.16 ms pre-ping + 479.71 ms visible query + 239.89 ms reset + 0.08 ms checkout bookkeeping = 1,450.84 ms. The measured health p50 was 1,558.04 ms, leaving 107.20 ms for cross-run variance plus FastAPI/HTTP work.

Connection establishment is a separate cold problem: the direct asyncpg lifecycle took 5,908.72 ms. Warm pooling successfully removes that cost. The remaining warm delay is geographic RTT multiplied by SQLAlchemy's safe transaction and ping behavior.

## Root-cause assessment

| Candidate | Finding |
| --- | --- |
| Geographic distance | **Principal cause.** Singapore to US East is intercontinental, and a single reused `SELECT 1` is 222.11 ms p50. |
| Pool behavior | **Strong multiplier.** Pre-ping and transaction cleanup turn one health query into about six WAN round trips. |
| Provider proxying | **Secondary, mainly cold.** The endpoint is provider-pooled/proxied, and the 5.24-second startup/authentication residual warrants provider-side connection-path review. It does not explain the stable one-RTT warm query. |
| TLS setup | **Cold-only contributor.** SSL request plus TLS is 451.33 ms p50, but pooled warm requests do not repeat TLS. |
| Database saturation | **Not indicated.** Reused `SELECT 1` is tightly grouped at 222.11 ms p50 and 228.82 ms p95. The timing tracks network RTT rather than compute contention. |

No business-table query or provider capacity telemetry was inspected, so the saturation conclusion is appropriately limited to the stable `SELECT 1` evidence.

## Exact target topology

| Layer | Recommendation |
| --- | --- |
| FastAPI region | Vercel `sin1` (Singapore), unchanged. Production was verified read-only with the Vercel CLI. |
| PostgreSQL region | AWS `ap-southeast-1` (Singapore), in the same metro as `sin1`. |
| Endpoint | Provider pooled endpoint in `ap-southeast-1`; do not use the current US East endpoint. |
| Application pool | `DATABASE_POOL_MODE=bounded`, `DATABASE_POOL_SIZE=2`, `DATABASE_POOL_MAX_OVERFLOW=0`, `DATABASE_POOL_PRE_PING=true`, `DATABASE_POOL_RECYCLE_SECONDS=1800`. |
| Capacity guardrail | `maximum FastAPI instances × 2` must stay below 70% of the provider's client-connection limit, with at least 10 client slots reserved for migration and operations. |

The provider pooler is preferred over a direct endpoint because Vercel can run multiple concurrent Fluid Compute instances. A direct endpoint exposes the database's backend-connection limit to autoscaling. The provider pooler adds a proxy hop, but a co-located proxy hop is measured in single-digit milliseconds rather than the current 218–240 ms WAN round trip. A two-connection, zero-overflow application pool bounds each process and prevents the current default of up to ten client connections per process.

Keep pre-ping enabled for the first co-located rollout. It is expensive only because it currently crosses the world three times. After co-location, disabling it could save a few milliseconds, but only alongside a tested one-retry policy for stale connections; that is an application-behavior decision and is not necessary to meet the target.

If moving PostgreSQL is impossible, the latency-only fallback is to move FastAPI to Vercel `iad1`, adjacent to the existing US East database. That would meet the API-to-database target but move the API away from the current Singapore deployment and likely increase user-facing latency for Asia. It is therefore not the recommended topology.

## Expected improvement

With a co-located pooled endpoint, plan for a raw database round trip of roughly 2–8 ms. The current six-round-trip health behavior should then cost approximately 12–48 ms in database time. Allowing 15–25 ms for FastAPI, local routing, and variance gives an expected warm `/health` p50 of approximately **40–60 ms**, with a conservative target below 100 ms and a p95 target below 150 ms.

Compared with the measured 1,558.04 ms warm p50, 50 ms is about a 96.8% reduction and a 31× speedup. Compared with the earlier 1.346-second observation, it is about a 96.3% reduction and a 27× speedup.

## Approval-gated implementation plan

The following infrastructure action requires explicit user approval:

1. Provision a PostgreSQL database with the same provider in AWS `ap-southeast-1` and enable its pooled endpoint.
2. Perform a separately reviewed schema/data migration and validation. This audit did not inspect or copy business data.
3. Rotate the production `DATABASE_URL` secret to the new pooled endpoint and redeploy FastAPI in the already verified `sin1` region.
4. Apply the bounded pool settings above, verify provider client-connection capacity, and rerun this audit from production.
5. Retain the current US East database as the rollback target until correctness and latency checks pass.

No Vercel, provider, database, DNS, deployment, or secret setting was changed in this work.

## Reproduction and safeguards

Run from a configured local checkout:

```bash
bun run perf:db-topology -- --application-region sin1
bun run perf:db-topology:test
```

The harness enforces at least 20 warm samples and writes numeric/category-only output to `.perf/database/latest.json`. The repository already ignores the complete `.perf/` tree. It never includes the connection string, host, address, certificate, database/user name, or provider account/project identifier in its report or failure message.

The read-only production region check used the already installed Vercel CLI 56.3.1. The CLI was not upgraded. Upgrade it separately to 56.5.0 or later for the current agentic and compatibility improvements; no global installation is authorized by this audit.
