# DEV-503 — Medicines and counter page-load measurement

**Every figure in this document is local, synthetic data, not staging.** Staging timings wait
for the infrastructure hold. Nothing here was measured against AWS, staging or production.

Issue #1276 (DEV-503) reported `/pharmacy/medicines` at 3.2 s and `/pharmacy/counter` at 3.8 s.
The code changes are on develop: ed23e6695 (parallel catalogue loads when the URL names the
selection, one shared request context), the 25-row catalogue pages, and DEV-514 (counter
skeleton of the real layout). This document records the measurement that was still open:
before/after load times and profiling of the server components on develop.

## Summary

**Conclusion:** on local synthetic data no measurable improvement is attributable to
ed23e6695; both commits are equally fast once the server is up, and the cold cost is the
server's start-up route preloading (about 2.3 s).

- On a started server, both pages are usable in about **0.5 s (medicines)** and **0.65 s
  (counter)**, cold browser cache or warm, on both the parent of ed23e6695 and develop
  (local, synthetic data, not staging).
- Only the **first request after `next start`** is slow: about 3.3 s for medicines and
  5.4–5.6 s for the counter here, on both commits. The issue's 3.2 s for medicines is close to
  the medicines figure; its 3.8 s for the counter is not reproduced (5.4–5.6 s cold, 0.6–0.7 s
  on a started server). Most of the cold time is the Next.js server preloading every route
  module at start-up (about 2.3 s), then one-off runtime warm-up, not these pages' queries.
- develop and the parent of ed23e6695 differ by tens of milliseconds, not seconds. On a
  started server, develop's medicines page is usable 24–36 ms later (it ships about
  80 KiB more JavaScript, mainly the catalogue approval queue that (a) did not have), and the
  counter about 40–50 ms earlier (ranges overlap). ed23e6695's parallel path only applies when
  the URL already names branch, source and batch; with 25-row pages and local latency its
  saving does not show.
- **No slow query or waterfall was proven**, so no product code changes. One candidate
  (server prefetch of the counter's branch list) was built and measured: no gain warm, and
  about 0.8 s added to the cold first request. It was reverted. Details below.

## Method

### Environment

| Item      | Value                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| Machine   | Ephemeral Linux container, 4 vCPU, 15 GB RAM (local, synthetic data, not staging)      |
| Database  | Private PostgreSQL 16.15 on 127.0.0.1:55676, same in-container host as the app         |
| Roles     | `gate_owner` (migrations) and `gate_runtime` (LOGIN NOSUPERUSER NOBYPASSRLS), as CI    |
| App       | `bun run build`, then `next start` (production), Node 22.23.5, bun 1.4.4               |
| Next.js   | 16.4.2 on the parent commit, 16.4.6 on develop (the server's own banner is checked)    |
| Browser   | Headless Chromium (Chrome for Testing 157.0.8103.78) through Playwright, 1280×720      |
| Commits   | (a) `dd75b2e4`, the parent of ed23e6695; (b) develop `064e8ba0`                        |
| Signed in | The seeded pharmacy E2E administrator (workspace `ADMIN`, the seed's pharmacy modules) |

Each commit had its own database, provisioned exactly as `.github/workflows/qa.yml` provisions
the pharmacy lane: `prisma/prepare-extensions.ts`, `prisma migrate deploy` with that commit's
migrations, runtime grants, `prisma db seed`, then `scripts/seed-pharmacy-e2e.ts` (guarded by
`scripts/pharmacy-e2e-environment.ts`).

### Synthetic data

`scripts/dev503-synthetic-medicines.ts` adds, to the seeded workspace:

- 19,000 catalogue medicines (`Synthmed 00001 10 mg Capsule` …), so the catalogue holds 19,003;
- one 19,000-row staged migration batch, profiled and persisted through the same
  `recordSource → profileTable → persistProfile` path an upload takes, with generated gaps
  (1,117 missing batch, 826 missing expiry, 655 missing MRP: 2,598 open exceptions).

All names, codes and prices are generated. No real customer or product data is used. Both
DEV-503 scripts run only against a disposable database on this machine
(`scripts/dev503-local-database.ts`): they refuse staging-demo mode (`STAGING_DEMO_SEED` or
`DEPLOY_ENV` set), require `PHARMACY_E2E=1`, a loopback host and the pharmacy E2E guard's
disposable name and isolated port, and require `DATABASE_URL` to equal the guarded URL. Both databases received
byte-identical source content (same content hash); the headers are ones both commits' profilers
recognise.

### What is measured

`scripts/dev503-measure-page-loads.ts` loads three URLs:

| URL key         | URL                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `medicines`     | `/pharmacy/medicines` (default selection: first branch, newest batch)   |
| `medicines p.2` | `/pharmacy/medicines?branchId=…&sourceId=…&batchId=…&page=2` (explicit) |
| `counter`       | `/pharmacy/counter`                                                     |

Metrics, in milliseconds from navigation start, from the browser's own timing APIs:

- **TTFB**: `PerformanceNavigationTiming.responseStart`.
- **LCP**: the last `largest-contentful-paint` entry.
- **Usable**: the first animation frame in which the page's first control is on screen,
  enabled and hydrated by React (it carries React's props). Medicines: the first staged-row
  link. Counter: the opening-cash field, the first step on a counter device with no open
  drawer (each fresh browser context is a new counter device).

Three modes, **median of 7 loads** per URL and mode:

- **Cold (server and browser)**: a new `next start` process and an empty browser cache for
  every load; the first request after the server reports ready.
- **Cold browser**: one server, started, idle for 10 s and primed by two loads of each URL in
  another context; every measured load uses a new browser context (empty HTTP cache).
- **Warm**: one server and one browser context, primed by two loads of each URL.

Session cookies come from one real sign-in and are reused, so no load includes sign-in.

## Before / after

Median of 7 runs, with [min–max]. Local, synthetic data, not staging. (a) = `dd75b2e4`, parent
of ed23e6695; (b) = develop `064e8ba0`.

### Cold: first request after `next start`, empty browser cache

| Page          | Commit | TTFB (ms)        | LCP (ms)         | Usable (ms)      |
| ------------- | ------ | ---------------- | ---------------- | ---------------- |
| medicines     | (a)    | 2827 [2679–3229] | 3280 [3104–3656] | 3339 [3088–3642] |
| medicines     | (b)    | 2888 [2728–3475] | 3296 [3204–3904] | 3316 [3226–3935] |
| medicines p.2 | (a)    | 2761 [2722–3511] | 3208 [3180–3940] | 3198 [3160–3940] |
| medicines p.2 | (b)    | 2914 [2809–3098] | 3388 [3256–3564] | 3436 [3275–3572] |
| counter       | (a)    | 2787 [2622–2885] | 5272 [5160–5616] | 5408 [5260–5766] |
| counter       | (b)    | 2928 [2768–3216] | 5480 [5120–5856] | 5634 [5265–6026] |

### Cold browser: started server, empty browser cache

| Page          | Commit | TTFB (ms)  | LCP (ms)      | Usable (ms)   |
| ------------- | ------ | ---------- | ------------- | ------------- |
| medicines     | (a)    | 46 [41–58] | 468 [448–484] | 449 [443–466] |
| medicines     | (b)    | 39 [35–48] | 464 [440–472] | 482 [463–507] |
| medicines p.2 | (a)    | 51 [41–67] | 476 [456–500] | 460 [428–466] |
| medicines p.2 | (b)    | 49 [43–53] | 452 [432–520] | 484 [459–523] |
| counter       | (a)    | 35 [30–41] | 640 [576–756] | 714 [661–816] |
| counter       | (b)    | 44 [34–51] | 588 [556–684] | 670 [636–761] |

### Warm: same server and browser context

| Page          | Commit | TTFB (ms)  | LCP (ms)      | Usable (ms)   |
| ------------- | ------ | ---------- | ------------- | ------------- |
| medicines     | (a)    | 47 [37–57] | 472 [448–500] | 450 [439–463] |
| medicines     | (b)    | 49 [36–52] | 452 [420–476] | 486 [470–505] |
| medicines p.2 | (a)    | 47 [38–64] | 480 [432–528] | 453 [421–516] |
| medicines p.2 | (b)    | 50 [47–64] | 452 [196–480] | 482 [467–495] |
| counter       | (a)    | 34 [30–38] | 620 [564–664] | 664 [598–732] |
| counter       | (b)    | 38 [31–50] | 532 [496–588] | 614 [554–678] |

Medicines' usable time can be a little earlier than its LCP: the row link is usable before a
later, larger paint lands.

Transferred bytes (median, cold browser): medicines 608 KiB on (a), 688 KiB on (b); counter
754 KiB on (a), 765 KiB on (b). Develop's medicines page also renders the catalogue approval
queue, which (a) did not have.

Raw samples: `docs/qa/dev-503/results/base-dd75b2e4.json`,
`docs/qa/dev-503/results/develop-064e8ba0.json` and
`docs/qa/dev-503/results/experiment-counter-prefetch.json`, in the shape
`scripts/dev503-measure-page-loads.ts` writes (`label`, `note`, `next`, `runs`, `summary`,
`results`). They were recorded with an earlier, uncommitted draft of that harness using the
same method. A one-run check of the committed harness on develop fell inside every recorded
range except one cold reading, which was 2 ms above its range.

## Profiling notes (develop)

### 1. Cold first request: start-up preload, not page code

A request sent as soon as `next start` reports ready waited about 3 s whatever it asked for:
`/favicon.ico` 2.4 s, `/login` 3.0 s, `/pharmacy/medicines` 3.0 s, `/pharmacy/counter` 3.1 s.
The next request was fast (`/pharmacy/medicines` second load 78 ms to first byte).

A `--cpu-prof` profile of that first request (3.7 s of samples) spent 2.3 s inside `require`,
1.5 s of it V8 compiling CommonJS (`wrapSafe`). A `Module._load` timing hook showed what was
loading in the 2.3 s after "Ready": route modules unrelated to the request, such as
`api-docs`, `dashboard`, `api/assistant`, `api/pharmacy/print`, `api/pharmacy/sop/evidence`
and `platform/(console)/settings`, plus 13 MB server chunks. This is Next.js
`experimental.preloadEntriesOnStart`, which defaults to `true`: the server loads every route at
start, and a request that arrives during that work queues behind it.

With the request sent 8 s after "Ready" instead, the same first loads took 1.04 s (medicines)
and 0.79 s (counter) to first byte. A profile of that request showed one-off runtime warm-up:
Turbopack module instantiation about 240 ms, Prisma's WASM query compiler and first query
about 170 ms, the first Auth.js JWT decode about 125 ms. After that, the first visit to another
route cost 0.1–0.2 s.

Conclusion: the cold figure is a per-process start-up cost shared by every route. It is paid
once per server start (deploy, scale-out, restart), not by these pages. Setting
`preloadEntriesOnStart: false` would move part of it to the first visit of each route instead;
that is an app-wide deployment trade-off for the owner, not a DEV-503 page fix, so it is not
changed here.

### 2. Medicines: server work about 125 ms, SQL about 19 ms

PostgreSQL statement logging (`log_min_duration_statement = 0`) on one warm load of the default
URL: 58 statements, 19.1 ms of execution in total, all inside about 125 ms of server work.
The HTML, including the streamed catalogue, finished at 154 ms (`responseEnd`).

| Statement (staged catalogue)                                        | Time          |
| ------------------------------------------------------------------- | ------------- |
| 25-row page of `pharmacy_migration_rows` (`ORDER BY rowNumber, id`) | 12.1 ms       |
| `COUNT` of matching rows (twice: filtered total, candidate total)   | 1.35 ms each  |
| `GROUP BY bucket` of open exceptions                                | 0.69 ms       |
| Exceptions for the 25 rows                                          | 0.60 ms       |
| Branch, batch and source look-ups                                   | < 0.1 ms each |

`EXPLAIN ANALYZE` as the runtime role, under RLS: the page read is a sequential scan of the
batch's 19,000 rows with a top-N heapsort (15 ms for page 1; 28 ms for the last page, where the
sort spills 5 MB to disk). The counts use the
`(organizationId, batchId, targetModelKey)` index (index-only scan, 4 ms under `EXPLAIN`).

The page's `ctx.db` is `createTenantDb`: every statement is its own short tenant transaction
(`BEGIN`, `set_config`, query, `COMMIT`) on a pool connection. After the batch check,
`listStagedMedicines` runs four independent reads one after another (filtered count, page read
with its exceptions, candidate count, exception groups): 29 ms from the first `BEGIN` to the
last `COMMIT` in the log. Run concurrently they would be bounded by the page read, so the most
they could save is about 15 ms, which is below the 20–40 ms spread of the page-level medians
and was therefore not changed. The whole query sequence is about 2–3 % of the 0.45–0.5 s
usable time; the rest is the browser downloading, parsing and hydrating JavaScript (about
690 KiB on an empty cache). An index on
`(organizationId, batchId, targetModelKey, rowNumber, id)` would turn the page read into an
index range scan; at 12–28 ms it is not worth a migration now, but it is the first thing to
add if staged batches grow well past 19,000 rows.

### 3. Counter: client-side reads, one branch-keyed round trip

The counter page is a client component; its server render is the shell (TTFB 35–45 ms). The
browser's resource timing on a warm load showed this chain of batched tRPC requests:

| Start–end (ms) | Batch                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| 283–363        | Shell: notifications, navigation, access checks                                           |
| 380–495        | Counter mount: approving pharmacists, navigation, `counterBranches`, settlement access, … |
| 577–683        | Branch-keyed: refund access, receipt format, open bills, trading day, `drawerStatus`, …   |
| 704–748        | `drawerCashiers`                                                                          |

The opening-cash field is enabled once `drawerStatus` answers, and `drawerStatus` needs the
branch from `counterBranches`, so one round trip sits on the critical path.

**Experiment (reverted).** The counter page prefetched `pharmacySales.counterBranches` on the
server with `createSSRHelpers` and hydrated it (`HydrationBoundary`), so the branch-keyed
reads could join the first client batch. Measured with the same harness (median of 7, local,
synthetic data, not staging):

| Counter              | develop (ms) | develop + prefetch (ms) |
| -------------------- | ------------ | ----------------------- |
| Warm, usable         | 614          | 646                     |
| Cold browser, usable | 670          | 656                     |
| Cold, TTFB           | 2928         | 3716                    |
| Cold, usable         | 5634         | 5491                    |

No gain warm or with a cold browser (inside the spread), and the cold first byte got about
0.8 s slower. `src/lib/trpc-server.ts` imports the full `appRouter` and resolves the tenant
actor a second time, which is the likely cause (not profiled further). The change was not
kept. On a slower network the saved round trip would be worth more; that needs
staging timings, which wait for the infrastructure hold.

## Acceptance criteria status

| Criterion (issue #1276)                           | Status                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiling notes identifying the main costs        | This document: start-up route preload (cold), client JavaScript and hydration (warm), small serial SQL on medicines, one branch-keyed round trip on the counter                                                                                            |
| Medicines catalogue is paginated                  | On develop (25 rows per page, ed23e6695 and earlier)                                                                                                                                                                                                       |
| Counter shell renders before secondary data loads | On develop: `counter/loading.tsx` renders `CounterSkeleton` of the real layout (DEV-514)                                                                                                                                                                   |
| Measurable improvement vs. 3.2 s / 3.8 s          | Not shown for ed23e6695: on a started server both commits are usable at about 0.5 s / 0.65 s (local, synthetic data, not staging). Cold, medicines is about 3.3 s (issue: 3.2 s) and the counter 5.4–5.6 s (issue: 3.8 s, not reproduced), on both commits |

## Reproduce

```bash
# 1. Private PostgreSQL 16 on an isolated port, roles and databases as qa.yml provisions them.
# 2. Seed the pharmacy E2E workspace, then the synthetic medicines:
export PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=postgresql://gate_runtime:…@127.0.0.1:55676/pharmacy_e2e_x
export DATABASE_URL=$PHARMACY_E2E_DATABASE_URL TEST_DATABASE_URL=$PHARMACY_E2E_DATABASE_URL
export PHARMACY_E2E_ADMIN_EMAIL=pharmacy-admin@pharmacy-e2e.test PHARMACY_E2E_ADMIN_PASSWORD=<local value>
bunx tsx scripts/seed-pharmacy-e2e.ts
bunx tsx --conditions=react-server scripts/dev503-synthetic-medicines.ts
# 3. Build the checkout to measure, then (nothing else running on the machine):
AUTH_SECRET=<local value> bunx tsx scripts/dev503-measure-page-loads.ts develop . 4400 7 out.json
```
