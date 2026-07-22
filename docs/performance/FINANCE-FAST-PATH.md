# Finance fast path

## Scope

This change replaces Finance's five-dataset startup barrier with an ADMIN-only bootstrap request. The bootstrap contains only the financial summary, the first 100 transactions, and the outstanding invoice totals/counts already represented in the summary. It does not include invoice rows, client choices, or recurring expenses.

`GET /api/finance/bootstrap` uses one FastAPI `AsyncConnection` and one SQL statement. The statement combines a bounded transaction page with transaction and invoice aggregates through CTEs. The initial page fetches at most 101 transaction rows so it can expose a cursor without loading another dataset.

## Request lifecycle

| Finance state | Requests | Freshness behavior |
| --- | --- | --- |
| Initial transactions | `/api/finance/bootstrap` | SSR payload is reused during hydration |
| Invoices opened | `/api/finance/invoices`, `/api/finance/client-choices` | Cached for 60 seconds in the current Nuxt browser session |
| P&L opened | Reuses bootstrap summary/transactions | Fetches paged 12-month transaction range only when bootstrap reports more rows |
| Recurring opened | `/api/finance/recurring-expenses` | Cached for 60 seconds in the current Nuxt browser session |
| Previously loaded tab reopened | None while fresh | Immediate in-memory render |

Nuxt's keyed `useAsyncData` owns the bootstrap. It renders on the server and checks the Nuxt payload while hydrating, preventing the old client-side replay.

## Mutation refresh boundaries

| Mutation family | Refreshed resources |
| --- | --- |
| Invoice create/edit/status/payment/overdue check | Invoice rows and summary |
| Transaction create/edit/delete | One bootstrap refresh for transactions and summary |
| Recurring create/delete | Recurring rows only |
| Post due recurring cycles | Recurring rows plus one bootstrap refresh because transactions were created |

The previous five-request full reload is not used by any Finance mutation.

## Connected benchmark

Measured on 2026-07-22 against the same configured PostgreSQL database and authenticated ADMIN account. Both exact-base and optimized local FastAPI processes used a one-connection/no-overflow pool so the test measured the route's connection and query behavior consistently. The frontend ran through Nuxt development mode in headless Chrome at 1440 × 900; the cold number therefore includes first-time Vite route compilation.

| Metric | Exact base `8c8ae539` | Finance fast path |
| --- | ---: | ---: |
| Initial Finance server reads | 5 | 1 |
| Hydration duplicate GETs | 5 | 0 |
| Cold development first visible | 21,861 ms | 5,228 ms |
| Warm authenticated reload | n/a | 842 ms |
| Bootstrap SQL round trips | n/a | 1 |
| Direct connected bootstrap SQL | n/a | 1,144.90 ms |
| Browser console/hydration errors | 0 | 0 |

The optimized cold development visit remains below the 10-second navigation timeout. The warmed result, which excludes one-time Vite compilation, is below the 2,500 ms target.

Raw benchmark results and screenshots:

- `/Users/Saad/.codex/visualizations/2026/07/22/019f891a-ec74-7d30-9737-98903584c92a/baseline-finance-benchmark.json`
- `/Users/Saad/.codex/visualizations/2026/07/22/019f891a-ec74-7d30-9737-98903584c92a/optimized-finance-benchmark.json`
- `/Users/Saad/.codex/visualizations/2026/07/22/019f891a-ec74-7d30-9737-98903584c92a/optimized-finance-desktop-1440x900.png`
- `/Users/Saad/.codex/visualizations/2026/07/22/019f891a-ec74-7d30-9737-98903584c92a/optimized-finance-mobile-390x844.png`

## Regression coverage

- ADMIN success and forbidden-role bootstrap access.
- One SQL round trip for bootstrap, with bounded transaction parameters.
- Bootstrap response excludes lazy invoice/client/recurring datasets.
- Every existing Finance CRUD route remains registered.
- Connected rollback-only coverage for transaction create/edit/delete; recurring create/post/delete; invoice create/edit/status; payment add/delete; overdue marking; and all Finance reads.
- Invoice, transaction, recurring, and post-due mutation refresh boundaries.
- Lazy tab caching, concurrent request deduplication, failure retry, and short-window expiry.
- P&L range pagination only after the P&L loader is requested.
- SSR bootstrap configuration and hydration payload reuse.
