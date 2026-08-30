# POS & terminal PRD

Operator workflow: [Restaurant administrator guide](restaurant-administrator-guide.md#opening-and-daily-service).

## Problem

Restaurant operators need a branch-bound terminal that can take an order through settlement without losing work during connectivity failures. The implemented order lifecycle is open → add/hold/fire → prepare/serve → close, with exceptional void, cancel, remake, table-move and table-merge commands; the acceptance test is `opens, adds, fires, prepares, serves, closes, and keeps ledger/outbox after each step` in `tests/restaurant-m4-acceptance.test.ts`.

## Users and roles

- Cashiers and servers operate the terminal under an active staff profile; kitchen and bar staff participate in downstream fulfillment. The role capability mapping is in `src/lib/vertical-catalog.ts` and is tested by `grants order-taking to owner (via *), GM, cashier, server, and bar` in `src/lib/vertical-catalog.test.ts`.
- A restaurant-admin provisions devices, staff credentials, and restaurant permissions. A platform-admin controls organization/module availability but is not a restaurant operator; the two authorization planes are implemented separately in `src/lib/platform/auth.ts` and `src/lib/restaurant/terminal-auth.ts`.
- Unlock and operator switching accept only staff eligible for the authenticated device branch; see `enforces the authenticated device branch for unlock and operator switch` in `src/lib/restaurant/terminal-flow.db.test.ts`.

## Current behaviour

- Terminal sessions establish, unlock, switch operator, and lock, with durable credential lockout after five failed unlocks; see `establishes, unlocks, switches operator, and locks (C6 state machine)` and `locks an operator credential after five failed unlocks and honours the durable lock (C4)` in `src/lib/restaurant/terminal-flow.db.test.ts`.
- Cash tender requires an open drawer, calculates change, records the net cash-sale movement, and emits a receipt; card tender uses the payment adapter and supports tips. See `settles a bill with cash: change, a net CASH_SALE movement, and a receipt` and `settles with a card SALE through the MOCK adapter and records a tip` in `src/lib/restaurant/tenders.test.ts`.
- Offline drafts persist a stable idempotency key per command, replay FIFO after reload, survive session expiry, and quarantine permanent/409 conflicts for operator review. See `keeps the same keys across a persistence round trip (a reload)`, `replays the same key after a reload and produces exactly one server result`, and `sends a 409 to operator review, never to a silent retry` in `src/lib/restaurant/pos-command-queue.test.ts`.
- A versioned catalog cache is saved on unlock and refreshed on unlock, reconnect, online, visibility, or manual request. Stale drafts surface removed/86'd items, price changes, and closed channels before submission; see `stores the catalog on unlock and restores it after a reload`, `always refreshes on unlock, reconnect, online, visibility and manual`, and `flags an 86d item, a removed item, a changed price and a closed channel` in `src/lib/restaurant/pos-client-store.test.ts` and `src/lib/restaurant/pos-command-queue.test.ts`.

## Data model

Terminal device/session/operator credential, order/item/event, bill/tender/payment/refund, drawer movement, receipt number, and idempotency records are defined in `prisma/schema.prisma`. Order item price/menu snapshots remain authoritative after catalog edits, verified by `keeps item snapshots after catalog, menu-name, and price edits` in `tests/restaurant-m4-acceptance.test.ts`.

## API surface

Terminal state routes live under `src/app/api/restaurant/terminal/`; order commands under `src/app/api/restaurant/orders/`; checkout/tender/refund under `src/app/api/restaurant/checkout/`; drawer/day-close under `src/app/api/restaurant/cash/`. Offline replay deliberately targets the existing M4 routes, verified by `targets the existing M4 routes and satisfies their strict schemas` in `src/lib/restaurant/pos-command-queue.test.ts`.

## Edge cases and failure modes

- Revoked devices are rejected during a live session and purge device-bound offline work; see `rejects mid-session when the device is revoked (403, no trust cache)` in `src/lib/restaurant/terminal-auth.test.ts` and `purges device-bound work on confirmed revocation, reports the count, and submits nothing later` in `src/lib/restaurant/pos-command-queue.test.ts`.
- Insufficient cash or a missing open drawer rejects cash settlement; provider/card failures use the adapter boundary. See `rejects insufficient cash` and `rejects a cash tender when the register has no open drawer` in `src/lib/restaurant/tenders.test.ts`, and `src/lib/restaurant/payment-adapter.ts`.
- Queue capacity is visibly capped at 50 drafts and work cannot replay on another device; see `refuses the 51st draft visibly and accepts again after a discard` and `refuses to queue or replay work bound to a different device` in `src/lib/restaurant/pos-command-queue.test.ts`.

## Gaps

- Production card acquiring, certification, settlement, and chargeback integration: **NOT IMPLEMENTED**; the verified card path uses a MOCK adapter in `src/lib/restaurant/tenders.test.ts`.
- Guaranteed offline card authorization: **NOT IMPLEMENTED**; the persisted offline command allowlist and denial rules are in `src/lib/restaurant/pos-command-queue.ts`.
