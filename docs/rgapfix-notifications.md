# Restaurant notification gap fixes — 2026-10-22

## Verification and issue exclusion

The three highest-impact High/Medium findings in
`docs/rgap-restaurant-notifications-20261022.md` were verified against the current branch before
making changes:

1. **Disabled webhook claims were incorrectly successful.** The job handler returned without an
   HTTP request when its configuration was absent or disabled, allowing the scheduler to mark the
   claimed job `SUCCEEDED`. This was not already fixed.
2. **Dead letters disappeared behind the 20-row recent-delivery limit.** `webhookStatus` returned
   only the newest 20 webhook jobs and exposed no independent dead-letter collection. This was not
   already fixed.
3. **Webhook deletion was absent.** The router and notifications page had configure, test, and
   retry operations, but no endpoint deletion operation. This was not already fixed.

No finding was skipped. The checkout has no configured Git remote, `gh issue list --state open
--repo WhatTheStack1/devfathom-commercial` could not authenticate, and public web searches for the
repository plus each finding returned no matching issue. Consequently, no matching open issue was
discoverable from the available environment; private issue metadata could not be verified.

## Changes

- `src/lib/restaurant/notification-webhook.ts:251-260` — disabled or missing configuration now
  fails the claimed attempt instead of returning success, preserving the scheduler's retry and
  dead-letter recovery path.
- `src/server/routers/restaurant-notifications.ts` (`webhookStatus`) — status now returns retained
  dead letters independently from the bounded 20-item recent-delivery list, as a keyset-paginated
  page (`deadLetterCursor`, default 25 rows, `deadLetterNextCursor` for older rows). Each dead letter
  carries its `retryWebhook` successor (`id`, `status`), resolved from the deterministic retry
  idempotency key, so recovered or in-flight retries are not reported as open failures.
- `src/server/routers/restaurant-notifications.ts:280-306` — added the `staff:manage`-gated,
  audited webhook deletion mutation; queued deliveries become recoverable dead letters in the same
  tenant-scoped transaction that deletes the secret-bearing configuration.
- `src/app/(app)/restaurant/notifications/page.tsx:422-489` — added a confirmed destructive removal
  action and a dedicated dead-letter recovery section whose retry actions remain available after a
  new endpoint is enabled. Only dead letters without a retry successor show a Retry action;
  recovered, in-progress, and failed retries are labelled as history. Dead letters page with
  Newest/Older links (`?deadLetters=<cursor>`), and the empty recent-delivery copy no longer claims
  nothing was queued when dead letters exist.
- `src/app/(app)/restaurant/notifications/page.tsx:912-919` — connected the removal form to the
  server action and reports how many queued deliveries were preserved as dead letters.
- `src/lib/restaurant/notification-webhook.test.ts:279-287` — updated the behavioral handler test
  to require disabled claims to fail rather than silently complete.
- `src/server/routers/restaurant-notifications.test.ts:268-325` — added behavioral coverage for the
  independent dead-letter query and atomic, audited deletion flow.

No schema migration was required.
