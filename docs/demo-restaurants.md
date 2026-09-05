# Restaurant sales demo operations

`/demo/restaurants` is the shared Restaurant sales demo. Demo reset work uses the existing
restaurant job queue, but only the authenticated demo cron may claim or recover `demo-reset` jobs.
The ordinary `restaurant:jobs` worker excludes that type from both claims and stale recovery.

## Release sequence

Run these steps in order through the existing release process. Do not seed before the target
migrations finish.

1. Confirm the target database service extension allow-list permits `btree_gist` and `pg_trgm`.
   Set `EXTENSION_ADMIN_DATABASE_URL` only in the privileged extension-preparation command
   environment, then run:

   ```sh
   bun prisma/prepare-extensions.ts
   ```

   This preparation must succeed before `prisma migrate deploy`. Do not print the URL or add it to
   the application environment.

2. Set these in the migration and seed command environment:

   - `DATABASE_URL` (used by migration, seed, and the application)
   - `AUTH_SECRET` (used during seed to derive the server-only demo approver PIN, and by the
     application)
   - `DEMO_SEATS` (set explicitly; use the same value for seed, application, and dispatcher)

   `DEMO_ACCESS_CODE` may remain unset so the public demo stays disabled. `CRON_SECRET` is not
   needed by migration or seed. Do not print any value.

3. Apply migrations to the target database:

   ```sh
   bunx prisma migrate deploy
   ```

4. Seed the demo seats:

   ```sh
   bun run demo:seed
   ```

   An unset `DEMO_SEATS` seeds `5`; setting it explicitly prevents seed/application drift.

5. Enable and deploy the application. Set:

   - `DATABASE_URL` (same target used by migration and seed)
   - `AUTH_SECRET` (same value used during seed)
   - `DEMO_ACCESS_CODE`
   - `DEMO_SEATS` (same explicit value used during seed)
   - `AUTH_URL` (or `NEXTAUTH_URL`) and `SHARED_APP_HOSTS` when the canonical demo fallback below
     is needed
   - `CRON_SECRET` (application and external dispatcher only)

   `DEMO_ACCESS_CODE` enables the demo route and reset dispatcher. When it is absent, the cron
   returns `404` without claiming jobs; queued resets remain available after re-enable.

6. After Saad binds and deploys the application on `www.devfathom.com`, run the nightly-dispatch
   verification and host/route checks below.

## Local environment names

Use only these variable names for local extension preparation, seed, application access, origin
resolution, and optional cron work; never record their values:

- `EXTENSION_ADMIN_DATABASE_URL`
- `DATABASE_URL`
- `AUTH_SECRET`
- `DEMO_ACCESS_CODE`
- `DEMO_SEATS`
- `AUTH_URL` (or `NEXTAUTH_URL`)
- `SHARED_APP_HOSTS`
- `CRON_SECRET` (cron verification/dispatch only)

## Shared demo origin

Ordinary shared-origin resolution is preferred. Only the canonical fallback for an organization
with `isDemo`, `RESTAURANT`, and `SHARED` applies otherwise. It reads `AUTH_URL` first, then
`NEXTAUTH_URL`, and accepts only a clean exact origin allow-listed by `SHARED_APP_HOSTS`: HTTP or
HTTPS, with no credentials, query, fragment, or path beyond `/`.

Explicit loopback ports are preserved. HTTP is allowed only for `localhost`, `127.0.0.1`, and
`[::1]`; every other host requires HTTPS.

## Verified local seed evidence

Attempt 7 completed all five seats in `540.998s` with exit `0`; seats 1 through 5 were each
independently confirmed `ACTIVE`. Each seat committed this exact count line:

```text
branches=3, floors=7, tables=52, modifierGroups=7, modifierOptions=20, products=40, ingredients=60, recipes=40, recipeLines=227, suppliers=6, purchaseOrders=21, purchaseReceipts=20, stockBalances=180, stockMovements=305, stockCounts=3, stockCountLines=180, lowStockRules=12, triggeredLowStockRules=3, historicalBusinessDates=90, historicalOrders=1743, historicalOrderLines=3819, bills=1744, settlements=1845, splitTenderOrders=102, refunds=15, dailyCloses=277, dailyCloseCorrections=7, liveOrders=2, kdsTickets=3101, loyaltyCustomers=200, promotions=1, staff=30, rosterShifts=210, sopTemplates=3, sopSteps=12, sopOccurrences=9, sopEvidence=9, notifications=12
```

The independent read-only check found these counts for every seat: 3 branches; 1,745 total orders
(1,743 historical + 2 live); 40 recipes; 200 loyalty customers; 9 SOP evidence rows; 15 refunds;
and 1,743 taxed bills. The `540.998s` figure is the complete seed-run duration, not a reset
duration; live reset timing remains unmeasured.

## Nightly reset trigger

Configure one external scheduler job with cron expression `0 22 * * *` (UTC). It starts nightly at
`22:00 UTC`, which is `03:00 Asia/Karachi`. Its runner needs Bash, Node.js, and `curl`; no
application worker or daemon is added. Set `DEMO_SEATS` as a non-secret dispatcher variable equal
to the seed and application value, and inject `CRON_SECRET` from the scheduler's secret store.

Run this exact command with shell tracing disabled. It makes at most `DEMO_SEATS` sequential HTTP
requests, each capped at one globally claimed reset, and prints counts only:

```sh
set -Eeuo pipefail
set +x

case "${DEMO_SEATS:-}" in
  ''|*[!0-9]*) echo 'DEMO_SEATS must be an integer from 1 to 25.' >&2; exit 1 ;;
esac
if [ "$DEMO_SEATS" -lt 1 ] || [ "$DEMO_SEATS" -gt 25 ]; then
  echo 'DEMO_SEATS must be an integer from 1 to 25.' >&2
  exit 1
fi
if [ -z "${CRON_SECRET:-}" ]; then
  echo 'CRON_SECRET is required.' >&2
  exit 1
fi

claimed_total=0
succeeded_total=0
recovered_total=0
error_total=0

for request_number in $(seq 1 "$DEMO_SEATS"); do
  response_file=$(mktemp)
  trap 'rm -f "$response_file"' EXIT
  if ! curl --silent --show-error --fail \
    --max-time 1805 \
    --output "$response_file" \
    --request POST \
    --header "Authorization: Bearer ${CRON_SECRET}" \
    --header 'Content-Type: application/json' \
    --data '{"maxJobs":1}' \
    https://www.devfathom.com/api/cron/demo-restaurants; then
    echo "Reset request ${request_number} failed; nightly dispatch incomplete." >&2
    exit 1
  fi

  if ! counts=$(node - "$response_file" <<'NODE'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = [
  result.jobs?.claimed,
  result.jobs?.succeeded,
  result.recovered,
  (result.jobs?.retried ?? 0) +
    (result.jobs?.dead ?? 0) +
    (result.jobs?.failed ?? 0) +
    (result.jobs?.released ?? 0),
];
if (!counts.every(Number.isSafeInteger) || counts.some((count) => count < 0)) process.exit(1);
process.stdout.write(counts.join(' '));
NODE
  ); then
    echo "Reset request ${request_number} returned invalid counts; nightly dispatch incomplete." >&2
    exit 1
  fi
  read -r claimed succeeded recovered errors <<<"$counts"
  if [ "$claimed" -gt 1 ] || [ "$succeeded" -gt 1 ]; then
    echo "Reset request ${request_number} exceeded the one-job limit." >&2
    exit 1
  fi
  claimed_total=$((claimed_total + claimed))
  succeeded_total=$((succeeded_total + succeeded))
  recovered_total=$((recovered_total + recovered))
  error_total=$((error_total + errors))
  rm -f "$response_file"
  trap - EXIT
done

printf 'requests=%s claimed=%s succeeded=%s recovered=%s errors=%s\n' \
  "$DEMO_SEATS" "$claimed_total" "$succeeded_total" "$recovered_total" "$error_total"

if [ "$claimed_total" -ne "$DEMO_SEATS" ] || \
   [ "$succeeded_total" -ne "$DEMO_SEATS" ] || \
   [ "$error_total" -ne 0 ]; then
  echo 'Nightly reset incomplete; alert operator and inspect the guarded demo-reset queue.' >&2
  exit 1
fi
```

The body may contain only optional integer `maxJobs`, from `1` through configured `DEMO_SEATS`;
the HTTP route defaults it to `1`. `maxJobs` is global across all demo organizations, not per
organization. A clean nightly run therefore passes only when aggregate `claimed` and `succeeded`
both equal `DEMO_SEATS`, with zero retried, dead, failed, or released jobs. Any HTTP, JSON, count,
or job failure exits nonzero so the scheduler must alert an operator; do not treat that run as a
complete reset.

Allow only one active nightly dispatcher run and alert on its first nonzero exit. Do not configure
an automatic whole-run retry: a partial run requires operator review of the guarded `demo-reset`
queue before another dispatch.

Processing is synchronous. Each request declares a 30-minute application maximum and the command
allows five seconds of transport overhead. Reset duration is not measured yet. The external
scheduler's total execution deadline must accommodate up to `DEMO_SEATS` sequential requests;
verify that provider limit before enabling the schedule. Keep `maxJobs` at `1`. A single request
with `maxJobs: DEMO_SEATS` is an alternative only after production timing proves it fits the
hosting request deadline; it is not the default safety claim.

Only configured demo seat IDs still flagged `isDemo`, `SHARED`, and `RESTAURANT` are visited.
Payload organization must match the claimed job organization. Reset and rescheduling run inside
the demo-specific tenant transaction; stale recovery uses the longer demo-specific lease.

## Host and route verification

Current verified host state is marketing content on both apex and `www`; no production app binding
or redirect is implied here. After the application is bound, TLS is valid, and the `www` demo route
is healthy:

1. Verify `https://www.devfathom.com/demo/restaurants` loads the application route and accepts the
   configured demo access flow.
2. Send one authenticated cron request with `maxJobs: 1`; confirm the returned counts and verify the
   same seat remains usable after reset. This is an operator smoke check, not proof that the full
   nightly multi-seat dispatch completed. Do not infer database success from HTTP status alone.

   ```sh
   set +x
   curl --silent --show-error --fail \
     --request POST \
     --header "Authorization: Bearer ${CRON_SECRET}" \
     --header 'Content-Type: application/json' \
     --data '{"maxJobs":1}' \
     https://www.devfathom.com/api/cron/demo-restaurants
   ```

3. Have the marketing/apex operator add a temporary HTTP `307` redirect for only
   `https://devfathom.com/demo/restaurants` to
   `https://www.devfathom.com/demo/restaurants`, preserving the complete query string.
4. Verify without following redirects:

   ```sh
   curl --silent --show-error --head \
     'https://devfathom.com/demo/restaurants?source=operator-check'
   ```

   Expect status `307` and a `Location` ending in
   `/demo/restaurants?source=operator-check`.

No live reset duration or production reset result has been established by this runbook.
