# Restaurant sales demo operations

`/demo/restaurants` is the shared Restaurant sales demo. Demo reset work uses the existing
restaurant job queue, but only the authenticated demo cron may claim or recover `demo-reset` jobs.
The ordinary `restaurant:jobs` worker excludes that type from both claims and stale recovery.

## Presenting several perspectives

Entry reuses the Studio form and the existing login-intent flow. Choose one of seven real staff
accounts: Owner, Manager (the default), Cashier, Waiter / Server, Kitchen, Inventory / Purchasing,
or Finance. This selection requests a new authenticated session; it does not impersonate a role
or replace server permission checks with browser filtering.

Use **separate browser profiles with the same seat and branch** for a team demonstration. Those
profiles share the restaurant's orders, stock, and reset. Tabs in one browser profile share login
cookies: signing in as another perspective replaces the current role across those tabs. Different
seats remain independent. Agree with everyone sharing a seat before its owner or manager resets it.

| Perspective            | Landing                 | Guided work                                                                  |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Owner                  | `/dashboard`            | Branch overview and operational reports; discuss exceptions with the team.   |
| Manager                | `/dashboard`            | All ten original tour stops, targets, and preparations.                      |
| Cashier                | `/pos`                  | Find the handed-over order, review bill splits, and record demo settlement.  |
| Waiter / Server        | `/pos`                  | Capture table, items and modifiers; send the order to kitchen.               |
| Kitchen                | `/kds`                  | Find the same order in the station queue and progress permitted item states. |
| Inventory / Purchasing | `/restaurant/inventory` | Review shortages, movements, purchase orders, receipts and discrepancies.    |
| Finance                | `/restaurant/money`     | Review daily-close history and reports for the presented branch and date.    |

The manager's ten stops remain: overview, POS modifiers, kitchen, floor, bill settlement, daily
close, low stock, recipe units, purchasing receipt, and reports. Other guides use a subset of
these real surfaces. Waiter and kitchen guides do not prepare manager editors or settlement;
cashier may open the existing payment dialog; finance may open the daily-close review tab. Tour
preparation does not submit a tender, advance a kitchen item, post stock, or create a close.

For the connected service story:

1. Waiter opens an order on the presented branch, selects the available table/menu/modifiers,
   sends it, and shares its order number.
2. Kitchen finds that number on the authorized branch/station queue and prepares the items using
   the available transitions. If absent, check branch, station, and whether the order was sent.
3. After service, cashier locates the same order, closes it when appropriate, opens Collect payment,
   and records the demo tender. The existing payment-pending sample is a separate fallback story;
   do not claim it is the waiter's new order.
4. Manager and finance review the recorded order and relevant business-date reports. Seeded history
   is distinct from today's activity; normal reporting projections may need to refresh.
5. Inventory connects ingredient shortages and movement reasons to supplier orders and recorded
   receipts; owner reviews the resulting operational picture. Restricted approvals stay with an
   authorized manager.

Card processing, receipt printers, fiscal devices, and external integrations are simulated or
unverified. A browser workflow or recorded demo tender is not live hardware, payment-processing,
physical-stocktake, or fiscal acceptance evidence.

### UI/backend integration contract

- Canonical metadata comes from `src/lib/demo/personas.ts`: `DEMO_PERSONA_KEYS`, `DEMO_PERSONAS`,
  `DemoPersona`, and `demoPersonaForUser`. UI workflow copy is in `sales-script.ts`.
- The seat API's per-persona `ready` flags disable unavailable accounts. Legacy seat responses
  without persona readiness enable only manager. A seat change cannot submit an unavailable
  perspective; seats that are still preparing offer a readiness refresh.
- Entry sends `POST /demo/restaurants/access` with `{ code, seat, persona }`. It requires a nonempty
  `organizationId` and the selected persona's exact canonical `callbackUrl`; external URLs, queries,
  and another persona's landing route are rejected. The response must echo `persona`; only the
  original manager response remains compatible without that field.
- Entry calls `signIn('login-intent', { organizationId, redirect: false, callbackUrl })`. When
  canonical `deviceKind` is present, it then posts `{ kind: deviceKind }` to
  `/demo/restaurants/device-session` and requires `{ ready: true }`. Finance and inventory skip
  terminal preparation. Navigation and router refresh follow successful preparation.
- The toolbar resolves the canonical persona from the authenticated session's organization, user
  ID, and email. Loading, revoked, missing, or unknown sessions receive no tour/reset controls.
  Changing the account remounts the guide. Progress is scoped to organization and user, so a
  kitchen profile cannot resume a saved manager preparation.
- Toolbar filtering chooses relevant narration only. Backend authentication, terminal capabilities,
  and permission enforcement remain authoritative for every page and mutation.

### UI verification, 2026-09-10

Run from `/Users/Saad/Developer/paperclip-worktrees/devfathom/demo-restaurants`:

```sh
bunx vitest run src/app/demo/restaurants/demo-entry-client.test.tsx src/lib/demo/toolbar.test.tsx src/lib/demo/tour.test.ts
bunx eslint src/app/demo/restaurants/demo-entry-client.tsx src/app/demo/restaurants/demo-entry-client.test.tsx src/lib/demo/toolbar.tsx src/lib/demo/toolbar.test.tsx src/lib/demo/tour.ts src/lib/demo/tour.test.ts src/lib/demo/sales-script.ts src/app/demo/restaurants/page.tsx
bunx prettier --check src/app/demo/restaurants/demo-entry-client.tsx src/app/demo/restaurants/demo-entry-client.test.tsx src/lib/demo/toolbar.tsx src/lib/demo/toolbar.test.tsx src/lib/demo/tour.ts src/lib/demo/tour.test.ts src/lib/demo/sales-script.ts src/app/demo/restaurants/page.tsx docs/demo-restaurants.md
git diff --check -- src/app/demo/restaurants/demo-entry-client.tsx src/app/demo/restaurants/demo-entry-client.test.tsx src/lib/demo/toolbar.tsx src/lib/demo/toolbar.test.tsx src/lib/demo/tour.ts src/lib/demo/tour.test.ts src/lib/demo/sales-script.ts src/app/demo/restaurants/page.tsx docs/demo-restaurants.md
```

The focused unit run passed **53/53 tests across three files**, exit `0`, in `2.50s`. ESLint,
Prettier, and the owned-file diff check passed with exit `0`. Coverage includes all seven login requests and terminal kinds, bounded
landing paths, mismatched identities, unavailable personas, legacy manager entry, failed sign-in
and device preparation, rate limiting, account-scoped progress, keyboard Escape/focus, and the
unchanged ten manager routes/targets/preparations.

No application server was listening during this UI lane. An isolated Playwright fixture renders
the owned React components with current semantic CSS and installed fonts, synthetic session/seat
responses, and no application server or database connection. Its local commands and artifacts are:

```sh
bun /tmp/restaurant-persona-ui-qa/build.ts
node /tmp/restaurant-persona-ui-qa/check.cjs
# Results: /tmp/restaurant-persona-ui-qa/results.json
# Screenshots: /tmp/restaurant-persona-ui-qa/screenshots/
```

Both fixture commands exited `0`. The final **83 browser cases passed**, with zero document
horizontal overflow, zero Axe WCAG A/AA violations, and zero unexpected console/page errors.
Coverage: 375/768/1024/1440px; light/dark; normal/reduced motion; entry, kitchen tour and guide,
manager's complete ten-stop guide and reset confirmation; loading, empty, and error entry states.
Native radio arrow keys, visible focus rings, guide Escape/focus restoration, and dialog Tab/Escape
behavior passed. These are isolated component results, not live authentication or route acceptance.

Initial checks exposed low-contrast entry/guide text and a client use of server-only seat-count
configuration (`process is not defined`); both were corrected within UI ownership. Axe reported
`color-contrast` for muted text on sunken surfaces and the existing reset-button treatment (4.26:1);
semantic body/strong text corrected those failures without changing shared tokens. The first Prettier check exited `1` for
the added Markdown table and was corrected. Fixture setup separately encountered unresolved
React/alias imports (`Could not resolve: "react-dom/client"`, then `File not found` for extensionless
aliases), an inline `</script>` delimiter (radio wait timed out), and Axe's `Please use browser.newContext()`
requirement; those fixture-only failures were corrected without adding dependencies. A dialog-focus
assertion initially sampled before focus restoration; the fixture now waits for that handoff. The deliberate
HTTP `500` error-state fixture records the expected resource error separately from unexpected
browser errors.

Live seven-account authentication, same-seat cross-profile service handoff, database permissions,
real route hydration, and hardware/integration acceptance remain backend/integration gates. This
UI lane did not run a production build, seed/reset a database, start/change an application server,
or perform Git/release mutations. Existing backend edits and prior runbook evidence were preserved.

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

## KDS business-date rollover

KDS reads the current branch business date first. Only for an authenticated demo organization,
when no explicit `businessDate` was supplied and that current queue has no open tickets, it reads
the bound station's most recent earlier business date containing an item that is not `SERVED` or
`VOIDED`. The response is a full polling snapshot for that actual date and identifies it in
`businessDate`; current-date tickets always win, while explicit dates and non-demo organizations
remain unchanged.

## Verified local seed evidence

Attempt 7 completed all five seats in `540.998s` with exit `0`; seats 1 through 5 were each
independently confirmed `ACTIVE`. Each seat committed this exact count line:

```text
branches=3, floors=7, tables=52, modifierGroups=7, modifierOptions=20, products=40, ingredients=60, recipes=40, recipeLines=227, suppliers=6, purchaseOrders=21, purchaseReceipts=20, stockBalances=180, stockMovements=305, stockCounts=3, stockCountLines=180, lowStockRules=12, triggeredLowStockRules=3, historicalBusinessDates=90, historicalOrders=1743, historicalOrderLines=3819, bills=1744, settlements=1845, splitTenderOrders=102, refunds=15, dailyCloses=277, dailyCloseCorrections=7, liveOrders=2, kdsTickets=3101, loyaltyCustomers=200, promotions=1, staff=30, rosterShifts=210, sopTemplates=3, sopSteps=12, sopOccurrences=9, sopEvidence=9, notifications=12
```

The independent read-only check found these counts for every seat: 3 branches; 1,745 total orders
(1,743 historical + 2 live); 40 recipes; 200 loyalty customers; 9 SOP evidence rows; 15 refunds;
and 1,743 taxed bills. The `540.998s` figure is the complete seed-run duration, not a reset
duration. Two local reset commands completed in `410.012s` and `466.029s`; these are command wall
times, not database transaction durations. Production reset duration remains unmeasured.

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
allows five seconds of transport overhead. Local reset commands completed in `410.012s` and
`466.029s`; these are command wall times, not database transaction durations, and production reset
duration remains unmeasured. The external scheduler's total execution deadline must accommodate up
to `DEMO_SEATS` sequential requests; verify that provider limit before enabling the schedule. Keep
`maxJobs` at `1`. A single request with `maxJobs: DEMO_SEATS` is an alternative only after
production timing proves it fits the hosting request deadline; it is not the default safety claim.

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

The observed local reset command wall times are `410.012s` and `466.029s`, not database transaction
durations. No production reset duration or result has been established by this runbook.
