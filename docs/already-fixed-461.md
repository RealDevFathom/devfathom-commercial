# GitHub issue #461 — already fixed

Issue #461 asks us to recover `feat(restaurant): add notifications center` from archived commit
`16d8f703` (`archive/rescue/WHA-86`). The current `main` snapshot already contains a more complete,
tenant-scoped implementation, so no archive code was ported.

## Current-code evidence

- The restaurant route is explicitly entitlement-gated by `restaurant-core`
  (`src/lib/module-catalog.ts:364-368`).
- The page renders a **Notifications center** with an unread count and a mark-all-read action
  (`src/app/(app)/restaurant/notifications/page.tsx:300-320`), and loads its inbox, count, routing
  matrix, and webhook status through the restaurant notifications router
  (`src/app/(app)/restaurant/notifications/page.tsx:889-925`).
- Inbox reads and read-state mutations are limited to the active user's restaurant staff profile;
  every list, count, mark-one, and mark-all predicate includes `recipientStaffProfileId`
  (`src/server/routers/restaurant-notifications.ts:26-37`,
  `src/server/routers/restaurant-notifications.ts:47-125`). This preserves tenant and recipient
  isolation through the scoped database client rather than accepting a caller-supplied tenant.
- Routing-matrix administration requires `staff:manage`, and branch overrides are checked against
  the current organization before any write (`src/server/routers/restaurant-notifications.ts:44-45`,
  `src/server/routers/restaurant-notifications.ts:127-175`).
- Notifications, per-channel settings, encrypted webhook configuration, and append-only delivery
  attempts are all represented as organization-scoped records
  (`prisma/schema.prisma:9010-9102`).
- Delivery is retry-safe through deterministic IDs and duplicate-safe inserts, while non-webhook
  channels other than in-app remain recorded as `STUBBED`
  (`src/lib/restaurant/notifications.ts:48-55`, `src/lib/restaurant/notifications.ts:95-164`).
- The live-send boundary remains explicit: the UI says WhatsApp is unavailable and is not sent
  (`src/app/(app)/restaurant/notifications/page.tsx:488-496`), the schema documents WhatsApp as a
  stub (`prisma/schema.prisma:8379-8397`), and delivery code assigns it `STUBBED` rather than invoking
  a provider (`src/lib/restaurant/notifications.ts:124-133`).

## Archive recovery decision

The one archived commit was **not cherry-picked**. Its valuable outcome—the restaurant notifications
center—is already present on `main`, together with recipient-scoped access, read state, channel
routing, signed-webhook operations, durable models, and the required live WhatsApp-send block.

Skipped from the archived work:

- **The archived page/UI and API implementation:** obsolete because the current route and router
  already provide the feature with stricter recipient and organization scoping.
- **Any archived persistence changes:** obsolete because the current organization-scoped models and
  delivery ledger cover the domain; replaying older schema work risks duplicate or weaker tables.
- **Any archived channel-send behavior:** not ported because current policy deliberately keeps
  WhatsApp (as well as email, SMS, and push here) stubbed and never sent.

This is therefore an already-fixed close, not a branch restoration or re-opened PR.
