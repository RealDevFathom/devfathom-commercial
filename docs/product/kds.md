# KDS PRD

Operator workflow: [Restaurant administrator guide](restaurant-administrator-guide.md#7-open-the-terminal-drawer-and-kds).

## Problem

Kitchen teams need fired items routed to the correct station, displayed safely, and recoverable after disconnects without corrupting fulfillment state. The full terminal-to-kitchen path is exercised by `tests/restaurant-m4-kitchen-flow.test.ts`.

## Users and roles

- Kitchen and bar operators can operate KDS; GM/owner retain broader authority. Capability grants are tested by `grants kitchen operation to owner (via *), GM, kitchen, and bar` in `src/lib/vertical-catalog.test.ts`.
- A restaurant-admin configures stations/routing and devices. A platform-admin controls the organization/module envelope but does not acknowledge or bump tickets; boundaries are in `src/lib/platform/auth.ts` and `src/lib/restaurant/terminal-auth.ts`.

## Current behaviour

- Routing uses most-specific precedence from product to category to course/default station; see `resolveStation — most-specific-wins precedence` in `src/lib/restaurant/station-routing.test.ts` and `src/lib/restaurant/station-routing.ts`.
- KDS exposes queue, acknowledge, bump, and recall transitions. Route integration is covered by `src/lib/restaurant/terminal-kds-routes.db.test.ts` and the UI state by `src/components/restaurant/kds/kds-board.test.tsx`.
- Cursor-based queue recovery tolerates an offline display crossing the business-date cutoff; see the recovery scenario in `src/lib/restaurant/kds.test.ts` and queue route `src/app/api/restaurant/kds/queue/route.ts`.
- Display content is rendered through React text nodes and the board tests include hostile ticket content; see `src/components/restaurant/kds/kds-board.tsx` and `src/components/restaurant/kds/kds-board.test.tsx`.

## Data model

Kitchen stations, routing rules, order-item snapshots, and fulfillment events are defined in `prisma/schema.prisma`. Fired items retain catalog-derived snapshots rather than depending on live mutable product names; see `keeps item snapshots after catalog, menu-name, and price edits` in `tests/restaurant-m4-acceptance.test.ts`.

## API surface

The device-authenticated surface is the GET route at `src/app/api/restaurant/kds/queue/route.ts` plus POST routes at `src/app/api/restaurant/kds/ack/route.ts`, `src/app/api/restaurant/kds/bump/route.ts`, and `src/app/api/restaurant/kds/recall/route.ts`. Domain behavior is in `src/lib/restaurant/kds.ts` and station selection in `src/lib/restaurant/station-routing.ts`.

## Edge cases and failure modes

- Missing or cross-tenant orders are concealed from both terminal and KDS probes; see `hides an order from cross-tenant terminal and KDS route probes` in `tests/restaurant-m4-acceptance.test.ts`.
- Repeated/out-of-order transitions are domain-validated rather than accepted as aggregate status edits; see `rejects a client-authored aggregate status edit` in `tests/restaurant-m4-acceptance.test.ts` and `src/lib/restaurant/kds.ts`.
- A reconnect uses the persisted cursor to recover missed queue activity; behavior lives in `src/lib/restaurant/kds.ts`. Multi-region cursor continuity: **NOT IMPLEMENTED**.

## Gaps

- Dedicated production display kiosk hardening (OS lockdown, remote wipe, burn-in controls): **NOT IMPLEMENTED**; current scope is the web board at `src/components/restaurant/kds/kds-board.tsx`.
- Printer fallback, kitchen audio hardware certification, and cross-region failover: **NOT IMPLEMENTED**.
