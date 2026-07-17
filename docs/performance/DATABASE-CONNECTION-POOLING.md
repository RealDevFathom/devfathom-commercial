# FastAPI database connection pooling

## Decision

The persistent FastAPI service uses SQLAlchemy's async bounded connection pool by default. A process keeps up to five idle database connections and may open five temporary overflow connections, for a maximum of ten concurrent database connections per process.

`NullPool` remains available for runtimes that cannot safely retain asyncpg connections on one event loop. It must be selected explicitly with `DATABASE_POOL_MODE=null`.

## Configuration

| Environment variable | Default | Validation | Purpose |
| --- | ---: | --- | --- |
| `DATABASE_POOL_MODE` | `bounded` | `bounded` or `null` | Select persistent pooling or an explicit connection-per-checkout mode. |
| `DATABASE_POOL_SIZE` | `5` | 1–50 | Persistent connections retained per process. |
| `DATABASE_POOL_MAX_OVERFLOW` | `5` | 0–50 | Temporary connections allowed above the retained pool size. |
| `DATABASE_POOL_RECYCLE_SECONDS` | `1800` | 30–86400 | Recreate connections older than this value on their next checkout. |
| `DATABASE_POOL_PRE_PING` | `true` | Boolean | Validate a retained connection before use. |

Queue-pool-only settings are not passed to SQLAlchemy when `DATABASE_POOL_MODE=null`. Invalid modes, sizes, overflow limits, recycle intervals, and Boolean values fail during settings validation instead of starting with an unsafe pool configuration.

Pool capacity is per process. Deployment capacity planning must multiply `DATABASE_POOL_SIZE + DATABASE_POOL_MAX_OVERFLOW` by the maximum number of FastAPI worker processes or instances.

## Shutdown and missing configuration

The FastAPI lifespan disposes the async engine during shutdown, which closes retained connections. When `DATABASE_URL` is absent, no engine is created and the existing degraded health and database dependency behavior is preserved.

## `/health` benchmark

Measured on 2026-07-18 against an available PostgreSQL database. Both revisions were run with one local Uvicorn process and the same database configuration. After the listening socket became ready, a new HTTP client issued six sequential `GET /health` requests. The first request is reported as cold; the following five are warm. No database endpoint or credential was captured in the benchmark output.

| Revision | Pool | Cold | Warm samples | Warm median |
| --- | --- | ---: | --- | ---: |
| Base `fa1538f76a05f9a90a7766e975e1e0a2871642e9` | `NullPool` | 6547.0 ms | 4062.0, 4042.6, 5505.2, 5020.8, 4802.7 ms | 4802.7 ms |
| Bounded pool | size 5, overflow 5, pre-ping, 1800 s recycle | 6167.7 ms | 2861.2, 1366.6, 1384.5, 1398.8, 1438.9 ms | 1398.8 ms |

The cold request still establishes the first PostgreSQL connection, as expected. The warm median is 70.9% lower (3.4× faster), consistent with removing repeated connection establishment while retaining pre-ping and the health query's existing `SELECT 1` behavior.
