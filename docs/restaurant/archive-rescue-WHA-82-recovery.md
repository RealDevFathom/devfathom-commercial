# Recovery of `archive/rescue/WHA-82` (issue #460)

Issue #460 asks what to do with the work preserved at tag `archive/rescue/WHA-82` (`1c4c1cbe`) when branch `rescue/WHA-82` was deleted on 22 Oct 2026. This note records, for every archived commit, whether it was **recovered**, is **already in main**, or was **dropped**, and why.

- Compared against `main` at `6e4253809b0e` (22 Oct 2026).
- The archive branched from main at `1de9c6b6` on 20 Aug 2026. It holds three commits that are not in main.

## Verdict

Nothing needs to be cherry-picked:

- The feature commit is already in main as a re-implementation that does more than the archive.
- The test and documentation commits describe the archived API, which main never adopted.

Keep the tag, since it is the only copy of the original lane, and close #460.

| Archived commit                                                                                 | Disposition                          | Reason                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d4d28461` feat(m7-l5): notifications — channel matrix, in-app REAL, external stubs, fan-out    | **Already in main** (re-implemented) | Main landed the same feature in `fcd91c73` (20 Aug 2026, "feat(restaurant): add notification fanout"). `3a824005` (30 Aug, signed SOP webhooks) and `db0a801a` (5 Sep, reset-safe demo jobs and notifications) extended it. Every behaviour in the archive is present; see the next section. |
| `4e6032b7` test(m7-l5): notifications unit batteries — core, fan-out, router                    | **Dropped** (superseded)             | The 36 archived tests call functions main does not export. Main has its own tests for the same behaviours; see "Tests".                                                                                                                                                                      |
| `1c4c1cbe` docs(m7-l5): BUILD-ASSUMPTIONS — notifications matrix/in-app/stubs/fan-out decisions | **Dropped** (would be inaccurate)    | The paragraph documents the archived implementation, and it contradicts main in four places (see "Documentation"). Restoring it would describe behaviour main does not have.                                                                                                                 |

## `d4d28461`: where each archived behaviour lives in main

| Archived behaviour (from its BUILD-ASSUMPTIONS paragraph)                   | Main                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Channel enum                                                                | The archive used `IN_APP`, `EMAIL`, `SMS` and `WEBHOOK`. Main has `IN_APP`, `WEBHOOK`, `EMAIL`, `SMS`, `PUSH` and `WHATSAPP` (`src/lib/restaurant/notifications.ts:8-15`).                                                                                                                                                                       |
| In-app delivery is real; external channels are stubbed                      | Main records `DELIVERED_IN_APP` for `IN_APP` and `STUBBED` for `EMAIL`, `SMS`, `PUSH` and `WHATSAPP` (`notifications.ts:126-133`). `WEBHOOK` goes further than the archive's stub: it is a real, signed delivery through the outbox (`notifications.ts:143-161`, `src/lib/restaurant/notification-webhook.ts`).                                  |
| Matrix: branch override, then organization default, then enabled by default | `resolveNotificationMatrix` resolves `branch?.enabled ?? org?.enabled ?? true` (`notifications.ts:65-93`, line 89).                                                                                                                                                                                                                              |
| A channel that is off in the matrix gets no delivery row                    | Only enabled channels get delivery rows (`notifications.ts:108-133`). Demo organizations deliver `IN_APP` only (`notifications.ts:106-109`).                                                                                                                                                                                                     |
| The inbox shows only notifications delivered in-app                         | Every inbox query filters on an `IN_APP` / `DELIVERED_IN_APP` delivery (`src/server/routers/restaurant-notifications.ts:40-42`).                                                                                                                                                                                                                 |
| Retries are idempotent                                                      | Deterministic primary keys (`notifications.ts:48-56`) and `createMany({ skipDuplicates: true })` (`notifications.ts:136-161`). Main does this for every request, not only entity-anchored ones.                                                                                                                                                  |
| Fan-out uses both durable seams (the scheduler job and the outbox consumer) | The job `notification.fanout` is handled by `notificationFanoutHandler` (`src/lib/restaurant/notification-fanout.ts:20,74`) and registered in `src/lib/restaurant/job-handlers-core.ts:77`. The outbox consumer is registered at `notification-fanout.ts:83`. The producer helper `appendNotificationRequest` is at `notification-fanout.ts:30`. |
| Inbox router: list, unread count, mark one read, mark all read              | `restaurant-notifications.ts:48` (`list`), `:90` (`unreadCount`), `:98` (`markRead`), `:117` (`markAllRead`).                                                                                                                                                                                                                                    |
| Channel-matrix admin                                                        | `getMatrix` and `updateMatrix` at `restaurant-notifications.ts:127,141`.                                                                                                                                                                                                                                                                         |
| Router registration                                                         | `src/server/routers/_app.ts:47,116`.                                                                                                                                                                                                                                                                                                             |

These archived choices were deliberately not carried into main:

- **Permissions.** The archive added the capabilities `notification:read` (any active member) and `notification:manage`. In main:
  - the inbox is bound to the caller's own active staff profile (`restaurant-notifications.ts:26-38`) and fails closed without one;
  - matrix and webhook administration require `staff:manage` (`restaurant-notifications.ts:44-45`).
- **Recipient.** The archive took `recipientStaffProfileId` as router input. Main derives it from the session, which the archive itself listed as the change to make when D21 closes.
- **Module gate.** The archive gated on `restaurant-sop`. Main gates on `restaurant-core` (`src/lib/module-catalog.ts:209`), so notifications work without the SOP add-on.
- **All channels off.** The archive wrote nothing at all. Main still writes the notification row but no delivery row, so it never appears in the inbox (the filter above), and the attempt stays auditable.

## Tests

The archived suites test `listInAppNotifications`, `markNotificationRead`, `markAllNotificationsRead`, `listChannelSettings`, `upsertChannelSetting`, `deliverViaStub`, `fanOutNotification` and `createNotificationOutboxConsumer`. None of these exist in main, so the suites cannot be applied.

Main covers the same behaviours in these files:

- `src/lib/restaurant/notifications.test.ts`: strict input; matrix precedence; one row per recipient, with delivery rows only for enabled channels; idempotency; the demo sink.
- `src/lib/restaurant/notification-fanout.test.ts`: consumer registration; deterministic outbox row; one idempotent scheduler job across outbox retries; strict payload.
- `src/server/routers/restaurant-notifications.test.ts`: the inbox scoped to the session's staff profile; unread count; mark one and mark all read; fails closed without a staff profile; matrix defaults and branch override through `staff:manage`; webhook configuration.
- `src/server/routers/restaurant-notifications.db.test.ts`: the runtime role is `NOSUPERUSER NOBYPASSRLS`; concurrent retries.
- `src/lib/restaurant/notification-webhook.test.ts`: signing, the SSRF guards, deadlines, retries and the demo sink.

Three archived scenarios have no direct counterpart in main, by design:

- suppressing everything when all channels are off (see above);
- skipping idempotency when a request has no entity (main is always idempotent);
- `NOT_FOUND` for a recipient passed as input (main never takes the recipient as input).

## Documentation

The archived paragraph for `industry-specific-docs/restaurants/BUILD-ASSUMPTIONS.md` says four things that are false on main:

- `WEBHOOK` is stubbed. On main it is a real, signed delivery.
- Access is controlled by `notification:*` capabilities. Main uses session binding and `staff:manage`.
- The module gate is `restaurant-sop`. Main uses `restaurant-core`.
- The recipient is router input. Main takes it from the session.

Main's D21 paragraph in the same file (lines 954-967) records the notification defaults. The real webhook channel is documented in `docs/product/restaurant-notification-webhooks.md`.

## Restoring the archive, if ever needed

```
git fetch origin tag archive/rescue/WHA-82
git push origin archive/rescue/WHA-82:refs/heads/rescue/WHA-82
```
