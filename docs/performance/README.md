# Performance verification harness

Run the complete local smoke benchmark with one command:

```sh
bun run perf:smoke
```

The default run starts a local FastAPI process, measures `/health`, starts the Nuxt development server, builds the optimized Nitro output, and then measures that preview. It does not change application or backend implementation.

## Prerequisites

Install the repository's existing dependencies and make Chrome or Chromium available:

```sh
bun install --frozen-lockfile
bun run api:install
```

The harness uses Chrome's DevTools protocol directly. It does not require Playwright, Puppeteer, or another browser dependency. Set `PERF_CHROME_PATH` only when Chrome is not in a standard macOS or Linux location.

## What is measured

Each run reports these surfaces separately:

- FastAPI `/health` TTFB and total response time.
- `/api/auth/login` TTFB and total response time when test credentials are present.
- Nuxt development startup and `/login` HTML TTFB.
- Optimized Nitro preview startup, build duration, and `/login` HTML TTFB.
- Dashboard first-visible-data, DOM content loaded, page load, total request count, API request count, per-API latency, and duplicate requests when test credentials are present.
- Browser console errors and hydration/mismatch errors.
- Whether `/api/dashboard/revenue-chart` completed before first visible dashboard data. `blocking` means first visible data was not observed until after that response completed; `not-blocking` means visible data preceded it; `not-requested` commonly means the test user is not an admin.

The first observation in a newly started process or browser lifecycle is `cold`. Subsequent observations in that same lifecycle are `warm`. The report keeps cold and warm data separate. p50 requires at least two samples and p95 requires at least five; the default is five warm samples.

Nuxt development results include Vite compilation, devtools, source maps, and other development-only work. Nitro preview results come from `.output/server/index.mjs` after `bun run build`. Do not treat those modes as interchangeable.

## Optional authenticated dashboard measurement

Authentication and dashboard checks skip successfully when either credential is absent. Supply a dedicated non-production test account through the environment, never source files or command arguments:

```sh
read -r PERF_TEST_EMAIL
export PERF_TEST_EMAIL
read -rs PERF_TEST_PASSWORD
export PERF_TEST_PASSWORD
bun run perf:smoke
unset PERF_TEST_EMAIL PERF_TEST_PASSWORD PERF_TEST_TOTP
```

For an account that requires two-factor authentication, also read and export `PERF_TEST_TOTP` without echo (`read -rs PERF_TEST_TOTP; export PERF_TEST_TOTP`). A normal TOTP is preferable to a one-use recovery code because the harness benchmarks both local frontend modes. The login endpoint is sampled six times by default, so use a test account and consider server-side rate limits when increasing `PERF_WARM_SAMPLES`.

Credentials, cookies, bearer tokens, database URLs, complete headers, request bodies, and URL query values are never written to output. Network traces contain only method, query-free URL, resource type, status, duration, and failure state.

## Output and controls

Reports, sanitized network traces, and optional screenshots are written below `.perf/`, which is ignored by Git. Temporary Chrome profiles are deleted after each browser run so session cookies are not retained. `.perf/latest.md` and `.perf/latest.json` point to the latest result.

Useful controls:

| Variable             | Purpose                                                       | Default           |
| -------------------- | ------------------------------------------------------------- | ----------------- |
| `PERF_WARM_SAMPLES`  | Warm observations per surface                                 | `5`               |
| `PERF_TIMEOUT_MS`    | Process and page timeout                                      | `60000`           |
| `PERF_API_URL`       | Use an already-running API instead of starting FastAPI        | local managed API |
| `PERF_SKIP_BUILD=1`  | Reuse an existing `.output/`                                  | rebuild           |
| `PERF_SCREENSHOTS=1` | Save a dashboard screenshot; it may contain test-account data | off               |
| `PERF_OUTPUT_DIR`    | Artifact root                                                 | `.perf`           |

## Localhost versus production

Run production as an explicitly labeled, separate lifecycle:

```sh
PERF_MODE=remote \
PERF_NITRO_URL=https://your-production-host.example \
PERF_API_URL=https://your-api-host.example \
bun run perf:smoke
```

Compare `remote-production` with local `optimized-nitro-preview`, not with `nuxt-development`. The remote result includes DNS, TLS, geographic distance, CDN behavior, and production infrastructure; the local Nitro result mostly isolates application/runtime overhead. Keep the same warm sample count and test account, record the client location, and run both several times before drawing conclusions.

If the deployed frontend and FastAPI share one origin, use that origin for both URLs. Do not put credentials, tokens, or secret-bearing query strings in either URL.
