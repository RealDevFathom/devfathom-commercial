# Hotel MVP implementation specification

**Status:** proposed implementation contract  
**Vertical:** `HOSPITALITY`  
**Scope:** one-property hotel operations: reservations, arrivals/departures, room inventory and
status, folios and charges, payment settlement, night audit, and one deterministic demo hotel  
**Out of scope:** public booking engine, channel manager/OTA synchronization, group blocks,
banquets, loyalty, housekeeping task assignment, maintenance work orders, accounting/GL export,
multi-currency, fiscal-device integration, and multi-property central reservations

## 1. Outcome and repository baseline

The MVP must let a receptionist take a direct reservation, assign a room, check the guest in,
post room and incidental charges, collect/refund payment, check the guest out, and let a night
auditor close one business date. It must also ship a repeatable one-hotel demo whose operational
states make every primary screen useful on first launch.

This is an additive plan, not a request to replace the hospitality foundation already present:

- `OrganizationVertical.HOSPITALITY`, the `hotel-*` modules/packages/limits, nineteen `hotel:*`
  capabilities, departments, and fifteen role templates already live in
  `src/lib/vertical-catalog.ts`.
- `HotelProperty` uses `branchId` as the property/location identity. Property access is narrowed by
  `HotelPropertyAssignment`; every new record below therefore carries `organizationId` and
  `branchId` and is resolved through `requireHotelPropertyScope`.
- `HotelRoomType`, `HotelRoom`, `HotelBed`, `HotelRoomStatusEvent`, and `HotelRoomBlock` already own
  physical inventory and status history. Reservations reference them; they do not duplicate them.
- `hotelProperty` (property/access/extras/inventory/function spaces/journey templates) and
  `hotelRates` (meal plans) are already mounted in `src/server/routers/_app.ts`. New routers follow
  the same `router`/`capabilityProcedure` pattern, module entitlement checks, audit logging,
  property selection, tenant predicates, optimistic writes, stable tRPC errors, and transaction
  boundaries.
- All UI must use the DevFathom Studio shell, semantic tokens, `PageHeader`, `SectionCard`, `Button`,
  `Stat`, `StatusPill`, bounded tables, and `PageTransition`; loading, empty, error,
  permission-denied, disabled, and destructive-confirmation states are required.

The source of truth remains server-side. A client may suggest price, balance, business date, room
status, or reservation status for concurrency detection, but may not author the accepted value.
Money is an integer number of minor currency units in the property's single configured currency.
Dates are hotel-local `YYYY-MM-DD` values; instants are UTC `DateTime`s and are interpreted using
`HotelProperty.timezone`.

## 2. MVP domain contract

### 2.1 Reservation lifecycle

`HOLD -> CONFIRMED -> CHECKED_IN -> CHECKED_OUT` is the normal lifecycle. `HOLD` and `CONFIRMED`
may become `CANCELLED` or `NO_SHOW`; terminal states never reopen. A reservation has one primary
guest and one or more stay units. MVP UI creates one stay unit, while the schema supports multiple
units so a later group-booking feature does not require replacing the financial identity.

Availability is calculated per hotel-local stay date over `[arrivalDate, departureDate)`.
Confirmed/checked-in stay units consume inventory; active `HotelRoomBlock` overlap removes rooms
from supply. A room assignment is optional before arrival and mandatory at check-in. Inventory
checks and writes lock the relevant property/date and room rows in one transaction, so concurrent
booking or assignment attempts cannot oversell a room or double-occupy a room-night.

Each reservation has a property-scoped human confirmation number allocated from a locked sequence.
Create/confirm/cancel/check-in/check-out/payment mutations also use a property-scoped idempotency
key bound to the canonical request hash. Exact replay returns the stored result; key reuse with a
different request fails without writes.

### 2.2 Check-in and check-out

Check-in validates a confirmed reservation, arrival/departure dates, a clean unblocked room of the
booked inventory kind, recorded primary guest identity/contact, and any property-required deposit.
It atomically creates/activates the room assignment, appends a reservation event, changes the room
to `OCCUPIED`, and opens the primary folio if it is not already open.

Check-out first refreshes all postings and payments. A non-zero balance blocks checkout unless the
actor has `hotel:folio-adjust` and posts an explicit balancing adjustment or approved transfer.
Checkout atomically changes the reservation to `CHECKED_OUT`, closes the active assignment, changes
the room to `VACANT_DIRTY`, closes the folio, and appends both reservation and room-status events.
No route directly marks an occupied room clean.

### 2.3 Folio, charges, payments, and settlement

Every reservation owns one folio in MVP. The folio is a ledger, not a mutable total:

`balanceMinor = sum(posted charges and debit adjustments) - sum(credits and credit adjustments) -
sum(settled payments) + sum(settled refunds)`.

Room charges, extras, tax, discounts/allowances, and manual adjustments are immutable postings.
Corrections append a full or partial reversal linked to the original posting. Posted rows snapshot
their description, service date, quantity, unit amount, tax amount, total, currency, source kind,
and source reference so future catalog or rate changes cannot reinterpret the folio.

Cash and external card are the MVP tenders. Card support records an external reference and a
normalized result; it does not claim to implement a card processor. A payment attempt is distinct
from a settled `HotelFolioPayment`. Successful collection/refund, folio balance impact, receipt
number allocation, and payment event commit atomically. A failed attempt has no folio impact.
Refunds are append-only, reference the original settled payment, and cumulatively cannot exceed
its refundable amount. Sensitive card data, track data, PINs, and CVVs are never accepted or stored.

### 2.4 Night audit

The property owns one current business date. Night audit is a resumable, exclusive run for that
date with durable steps:

1. **PRECHECK:** refuse unresolved in-house room/assignment inconsistencies, invalid folio
   currencies, or a second active run.
2. **NO_SHOWS:** mark eligible unarrived confirmed reservations `NO_SHOW` according to the
   property's cutoff; release assignments without inventing a fee.
3. **ROOM_POSTINGS:** post exactly one room charge (and its snapshotted tax) for each eligible
   occupied stay unit and service date.
4. **BALANCES:** snapshot arrivals, departures, occupancy, charges, payments, refunds, receivables,
   cash, and card totals; flag but do not erase unsettled guest balances.
5. **ADVANCE_DATE:** atomically close the run and advance the property business date by one day.

Each step is idempotent and has a unique business key. A retry resumes after the last completed
step; it never duplicates a charge or advances twice. Only one `RUNNING` run may exist per property,
and a closed business date is immutable. Operational corrections after close use the current
business date and retain the original service date plus an explicit reason.

## 3. Concrete Prisma design

All new models use `String @id @default(cuid())`, `createdAt @default(now())`, and `updatedAt
@updatedAt` where the row is mutable. Every foreign key includes `organizationId`; property-bound
foreign keys include `(organizationId, branchId, ...)`. Add tenant/property/date indexes for every
operational list and PostgreSQL RLS policies matching the current hotel migrations. Financial and
event tables deny update/delete to the runtime role. Migration SQL supplies the exclusion/partial
unique constraints Prisma cannot express.

### 3.1 Amend existing models

| Model           | Concrete additions                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HotelProperty` | `businessDate DateTime @db.Date`; relations to guests, reservations, folios, payment attempts, night-audit runs, number sequences, and idempotency keys. Provision it as the property's local calendar date. |
| `HotelRoomType` | `reservationStayUnits HotelReservationStayUnit[]`; the existing capacity, inventory kind, and active flag remain canonical.                                                                                  |
| `HotelRoom`     | relations to `HotelRoomAssignment[]`; existing `status`, blocks, and `HotelRoomStatusEvent` remain canonical.                                                                                                |
| `HotelBed`      | optional relation to assignments for bed-mode properties; HOTEL-mode MVP assigns rooms only.                                                                                                                 |

### 3.2 Guest and reservation models

| Prisma model                      | Required fields and constraints                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HotelGuest`                      | `organizationId`, `branchId`, `firstName`, `lastName`, normalized optional `email`/`phone`, optional `countryCode`, `notes`, timestamps; unique `(organizationId, id)` and indexed normalized contact fields. Identity-document storage is excluded from MVP.                                                                                                                                                                                                 |
| `HotelReservation`                | `organizationId`, `branchId`, `confirmationNumber`, `status HotelReservationStatus`, `source HotelReservationSource`, `primaryGuestId`, hotel-local `arrivalDate`/`departureDate` (`@db.Date`), `adults`, `children`, optional `specialRequests`, `currency`, `bookedAt`, optional `cancelledAt`/`checkedInAt`/`checkedOutAt`/`noShowAt`, `version Int`; unique `(organizationId, branchId, confirmationNumber)`, check departure > arrival and party counts. |
| `HotelReservationStayUnit`        | reservation/property keys, `roomTypeId`, optional `mealPlanId`, `quantity` (MVP requires `1`), `adults`, `children`, snapshotted `nightlyRateMinor`, `taxMinorPerNight`, `currency`, `arrivalDate`, `departureDate`; unique `(organizationId, id)`, dates constrained to reservation range. This is the availability-consuming row.                                                                                                                           |
| `HotelRoomAssignment`             | stay-unit/property keys, `roomId`, optional `bedId`, `startDate`, `endDate`, `status HotelRoomAssignmentStatus`, `assignedAt`, `assignedById`, optional `releasedAt`/`releaseReason`; PostgreSQL exclusion constraints prevent overlapping active assignments for a room or bed over `[startDate,endDate)`.                                                                                                                                                   |
| `HotelReservationEvent`           | reservation/property keys, `kind HotelReservationEventKind`, `fromStatus`, `toStatus`, `actorId`, `occurredAt`, `reason`, `metadata Json`; append-only, indexed by reservation and occurrence time.                                                                                                                                                                                                                                                           |
| `HotelConfirmationNumberSequence` | property key, `nextNumber`; exactly one row per `(organizationId, branchId)`, locked during allocation. Format is `RSV-YYYY-NNNNNN` using property business year.                                                                                                                                                                                                                                                                                             |
| `HotelOperationIdempotencyKey`    | property key, `scope`, `key`, `requestHash`, optional `resultType`/`resultId`/`response Json`, `createdAt`; unique `(organizationId, branchId, scope, key)`.                                                                                                                                                                                                                                                                                                  |

Required enums:

- `HotelReservationStatus`: `HOLD`, `CONFIRMED`, `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED`,
  `NO_SHOW`.
- `HotelReservationSource`: `WALK_IN`, `PHONE`, `EMAIL`, `DIRECT` (OTA/channel sources wait for
  the channels phase).
- `HotelRoomAssignmentStatus`: `HELD`, `ACTIVE`, `RELEASED`.
- `HotelReservationEventKind`: `CREATED`, `CONFIRMED`, `ROOM_ASSIGNED`, `ROOM_CHANGED`,
  `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED`, `NO_SHOW`, `NOTE_ADDED`.

### 3.3 Folio and payment models

| Prisma model                 | Required fields and constraints                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HotelFolio`                 | property/reservation keys, `folioNumber`, `status HotelFolioStatus`, `guestId`, `currency`, `openedAt`, optional `closedAt`, `version`; one MVP folio per reservation, unique property folio number. Stored balance is deliberately omitted or treated only as a transactionally maintained cache verified against the ledger.                                                                                                                         |
| `HotelFolioPosting`          | property/folio keys, `kind HotelFolioPostingKind`, `sourceKind HotelFolioSourceKind`, optional `sourceId`, optional `reversesPostingId`, hotel-local `serviceDate`, snapshotted `description`, `quantity`, `unitAmountMinor`, `netMinor`, `taxMinor`, `totalMinor`, `currency`, `postedAt`, `postedById`, `reason`; append-only. Unique source business key prevents duplicate room-night/extras posting; reversal totals may not exceed the original. |
| `HotelPaymentAttempt`        | property/folio keys, `tenderType HotelTenderType`, `direction HotelPaymentDirection`, `status HotelPaymentAttemptStatus`, `amountMinor`, `currency`, optional sanitized `provider`/`externalReference`, `idempotencyKeyId`, `requestedById`, timestamps, optional failure code/message; no PAN-like fields.                                                                                                                                            |
| `HotelFolioPayment`          | property/folio/attempt keys, `receiptNumber`, `tenderType`, `direction`, `amountMinor`, `currency`, optional `refundsPaymentId`, `settledAt`, `settledById`; append-only; one settlement per successful attempt and unique property receipt number. Refund cumulative sum is DB- and service-guarded.                                                                                                                                                  |
| `HotelPaymentEvent`          | payment-attempt keys, `kind HotelPaymentEventKind`, `occurredAt`, sanitized `providerReference`, `metadata Json`; append-only and unique provider event identity when present.                                                                                                                                                                                                                                                                         |
| `HotelReceiptNumberSequence` | property key and `nextNumber`; locked allocation, exactly one per property. Format `HRC-YYYY-NNNNNN`.                                                                                                                                                                                                                                                                                                                                                  |

Required enums:

- `HotelFolioStatus`: `OPEN`, `CLOSED`, `VOID`.
- `HotelFolioPostingKind`: `ROOM`, `EXTRA`, `TAX`, `DISCOUNT`, `ADJUSTMENT`, `REVERSAL`.
- `HotelFolioSourceKind`: `NIGHT_AUDIT`, `HOTEL_EXTRA`, `MANUAL`, `REVERSAL`.
- `HotelTenderType`: `CASH`, `CARD`.
- `HotelPaymentDirection`: `COLLECTION`, `REFUND`.
- `HotelPaymentAttemptStatus`: `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.
- `HotelPaymentEventKind`: `REQUESTED`, `AUTHORIZED`, `SETTLED`, `FAILED`, `CANCELLED`,
  `REFUNDED`.

### 3.4 Night-audit models

| Prisma model             | Required fields and constraints                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HotelNightAuditRun`     | property key, `businessDate @db.Date`, `status HotelNightAuditStatus`, `currentStep HotelNightAuditStep`, `startedAt`, `startedById`, optional `completedAt`/`failedAt`/`failureCode`/`failureMessage`, `summary Json`, `version`; unique property/business date; SQL partial unique index for one `RUNNING` run per property. |
| `HotelNightAuditStepRun` | audit-run/property keys, `step`, `status HotelNightAuditStepStatus`, `attempt`, `startedAt`, optional `completedAt`, `result Json`, optional error fields; unique `(auditRunId, step)` so retry updates execution metadata instead of repeating effects.                                                                       |
| `HotelDailySnapshot`     | audit/property keys, `businessDate`, integer counts and money columns for rooms available/occupied/out-of-order, arrivals, departures, no-shows, room revenue, extras, tax, adjustments, payments/refunds by tender, closing receivable, `currency`, `createdAt`; unique property/business date and immutable after creation.  |

Required enums:

- `HotelNightAuditStatus`: `RUNNING`, `COMPLETED`, `FAILED`.
- `HotelNightAuditStep`: `PRECHECK`, `NO_SHOWS`, `ROOM_POSTINGS`, `BALANCES`, `ADVANCE_DATE`.
- `HotelNightAuditStepStatus`: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`.

## 4. tRPC surface

Mount focused routers in `src/server/routers/_app.ts`; do not grow `hotelProperty` into an
operations monolith. Every input includes the existing property selector (`branchId`, or the
session-selected property), every query is tenant/property constrained, and every mutation writes
an audit event with actor and reason where applicable.

### 4.1 `hotelReservations` — module `hotel-reservations`

| Route          | Kind     | Capability           | Contract                                                                                                               |
| -------------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `search`       | query    | `hotel:reservations` | Paginated search by date, confirmation, guest, and status.                                                             |
| `availability` | query    | `hotel:reservations` | Server-computed room-type supply/demand and assignable rooms for `[arrival, departure)`.                               |
| `get`          | query    | `hotel:reservations` | Reservation, guest, stay unit, assignment, event timeline, and folio summary.                                          |
| `create`       | mutation | `hotel:reservations` | Create/update guest as explicit input, reserve one stay unit, allocate confirmation number, and open folio atomically. |
| `confirm`      | mutation | `hotel:reservations` | Transition `HOLD` to `CONFIRMED` after locked availability recheck.                                                    |
| `updateStay`   | mutation | `hotel:reservations` | Optimistic date/party/type/rate change with locked availability recheck and event.                                     |
| `assignRoom`   | mutation | `hotel:front-desk`   | Create/change a non-overlapping assignment; enforce room type/kind and blocks.                                         |
| `cancel`       | mutation | `hotel:reservations` | Cancel pre-arrival reservation, release held assignment, retain folio/history.                                         |
| `markNoShow`   | mutation | `hotel:front-desk`   | Manual no-show after cutoff; night audit uses the same command internally.                                             |

### 4.2 `hotelFrontDesk` — module `hotel-front-desk`

| Route             | Kind     | Capability         | Contract                                                                                            |
| ----------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `board`           | query    | `hotel:front-desk` | Business-date arrivals, in-house guests, due-outs, unassigned bookings, and actionable room states. |
| `checkInPreview`  | query    | `hotel:front-desk` | Return blockers, deposit/balance, room candidates, and the server version to submit.                |
| `checkIn`         | mutation | `hotel:front-desk` | Execute the atomic check-in contract in §2.2.                                                       |
| `roomMovePreview` | query    | `hotel:front-desk` | Validate target room and show rate/assignment effect.                                               |
| `moveRoom`        | mutation | `hotel:front-desk` | End old assignment, start new one, update both room statuses, and append one event atomically.      |
| `checkOutPreview` | query    | `hotel:front-desk` | Refresh folio, expose blockers and exact balance.                                                   |
| `checkOut`        | mutation | `hotel:front-desk` | Execute the atomic checkout contract in §2.2.                                                       |

### 4.3 `hotelInventory` — mounted as `hotelProperty.inventory`, modules `hotel-core` / `hotel-front-desk`

Keep the existing `roomTypes.list/create`, `rooms.list/create/setStatus/history`, `beds.list/setStatus`,
and `blocks.list/create/release` routes. Add only operational reads that avoid duplicating booking
logic:

| Route                  | Kind  | Capability                                 | Contract                                                                                                                                                 |
| ---------------------- | ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statusBoard`          | query | `hotel:front-desk` or `hotel:housekeeping` | Rooms/beds with current status, active block, occupant/next arrival summary, and allowed transitions; each audience receives only its authorized fields. |
| `availabilityCalendar` | query | `hotel:reservations`                       | Date-by-room-type totals derived through the same availability service as `hotelReservations.availability`.                                              |

Existing administrative inventory mutations remain `hotel:property-admin`; operational clean/dirty
transitions require `hotel:housekeeping`, while occupancy transitions are callable only from the
front-desk command transaction, not as a generic status mutation.

### 4.4 `hotelFolios` — module `hotel-folio`

| Route              | Kind     | Capability           | Contract                                                                                          |
| ------------------ | -------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `get`              | query    | `hotel:folio`        | Folio identity, immutable posting/payment timeline, tender totals, and server-calculated balance. |
| `postExtra`        | mutation | `hotel:folio`        | Snapshot an active `HotelExtra` and append its posting with idempotency.                          |
| `postManualCharge` | mutation | `hotel:folio-adjust` | Append a reasoned manual charge/credit; never edit a prior row.                                   |
| `reversePosting`   | mutation | `hotel:folio-adjust` | Full/partial linked reversal under folio lock and remaining-value validation.                     |
| `statement`        | query    | `hotel:folio`        | Stable printable statement DTO; no browser-only recalculation.                                    |

### 4.5 `hotelPayments` — module `hotel-payments`

| Route               | Kind     | Capability                | Contract                                                                                       |
| ------------------- | -------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `quote`             | query    | `hotel:payments`          | Current balance, refundable payments, tender rules, and version/hash.                          |
| `collectCash`       | mutation | `hotel:payments`          | Validate amount/change, create successful attempt and settlement, allocate receipt atomically. |
| `recordCardResult`  | mutation | `hotel:payments`          | Record sanitized external result; only success creates settlement.                             |
| `refund`            | mutation | `hotel:refunds`           | Append linked refund within remaining refundable amount and allocate receipt.                  |
| `receipt`           | query    | `hotel:payments`          | Historical receipt DTO from frozen settlement/posting evidence.                                |
| `settlementSummary` | query    | `hotel:reports-financial` | Business-date cash/card collection, refund, and net totals for audit/reconciliation.           |

### 4.6 `hotelNightAudit` — module `hotel-night-audit`

| Route      | Kind     | Capability                                       | Contract                                                                                   |
| ---------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `status`   | query    | `hotel:night-audit`                              | Property business date, latest/current run, completed steps, blockers, and preview totals. |
| `start`    | mutation | `hotel:night-audit`                              | Take property advisory lock, create/resume the unique run, execute resumable steps.        |
| `retry`    | mutation | `hotel:night-audit`                              | Resume a failed run from its first incomplete step.                                        |
| `history`  | query    | `hotel:night-audit`                              | Paginated closed/failed runs by business date.                                             |
| `snapshot` | query    | `hotel:night-audit` or `hotel:reports-financial` | Immutable daily snapshot and drill-down references.                                        |

## 5. Capabilities and role templates

No new capability strings are required for MVP. Keep the canonical nineteen capabilities and map
the MVP as follows:

| Capability                | MVP authority                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `hotel:reservations`      | Search/create/confirm/update/cancel reservations and view availability.               |
| `hotel:front-desk`        | Assign/move rooms, check in/out, mark no-show, view operational room board.           |
| `hotel:folio`             | Read folios/statements and post catalog extras.                                       |
| `hotel:folio-adjust`      | Manual debit/credit and posting reversals; never direct ledger edits.                 |
| `hotel:payments`          | Collect cash and record card results; read receipts.                                  |
| `hotel:refunds`           | Refund a settled payment within its remaining value.                                  |
| `hotel:housekeeping`      | Read housekeeping board and make allowed clean/dirty/inspection transitions.          |
| `hotel:night-audit`       | Preview/start/retry audit and read audit history.                                     |
| `hotel:reports-financial` | Read settlement summaries and immutable daily snapshots.                              |
| `hotel:property-admin`    | Configure property/inventory/extras and demo reset, never implied financial mutation. |

The existing templates remain the seed source. The acceptance matrix for the roles involved in MVP
is concrete:

| Role template           | MVP grants                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                   | `*`.                                                                                                                                                                                     |
| General Manager         | All canonical hospitality capabilities.                                                                                                                                                  |
| Front Office Manager    | Reservations, front desk, folio, adjustments, payments, refunds, rates, availability override, night audit, guest identity, and channels (existing template; channels have no MVP page). |
| Front Desk Agent        | Reservations, front desk, folio, payments, and guest identity; no adjustments/refunds/night audit.                                                                                       |
| Reservations Agent      | Reservations only.                                                                                                                                                                       |
| Night Auditor           | Front desk, folio, adjustments, payments, night audit, and financial reports.                                                                                                            |
| Housekeeping Supervisor | Folio plus housekeeping (catalog extra postings only under the procedure restriction).                                                                                                   |
| Housekeeper             | Housekeeping only.                                                                                                                                                                       |
| Accounts / AR           | Folio, payments, refunds, and financial reports.                                                                                                                                         |
| Read-only Auditor       | Remains default-deny until a separate read-only capability/read-model design; do not over-grant.                                                                                         |

Authorization requires all four checks: authenticated organization member, enabled commercial
module, capability grant, and active property assignment. `*` does not bypass organization,
entitlement, or property scope. List results and relationship existence errors must not disclose a
different tenant or unassigned property.

## 6. UI information architecture

Use the existing hotel navigation and tenant shell. Desktop and mobile navigation expose a page
only when its module is enabled and the actor has a relevant capability; direct navigation remains
server-authorized.

| URL                                   | Page and primary content                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/hotel`                              | **Hotel dashboard:** business date, occupancy/arrival/departure/balance stats, arrivals queue, in-house queue, due-outs, room-status exceptions, and night-audit callout.      |
| `/hotel/reservations`                 | **Reservations registry:** date/status/source filters, guest or confirmation search, bounded results table, availability entry point, and “New reservation.”                   |
| `/hotel/reservations/new`             | **New reservation:** stay dates/party, live room-type availability, guest/contact, rate/meal plan, review, then one idempotent create action.                                  |
| `/hotel/reservations/[reservationId]` | **Reservation workspace:** identity/status header; stay, guest, room assignment, event timeline, folio balance; contextual confirm/cancel/check-in/check-out actions.          |
| `/hotel/front-desk`                   | **Front desk board:** business-date arrivals, in-house, due-outs, unassigned, and blockers; keyboard-accessible list/table views rather than drag-only interactions.           |
| `/hotel/rooms`                        | **Room board:** room/type/status/occupant/next-arrival/block, status filters, bounded responsive table or accessible grouped cards; authorized housekeeping transition dialog. |
| `/hotel/availability`                 | **Availability calendar:** room-type rows and hotel-local dates, available/sold/blocked counts, clear legend plus text labels, and reservation shortcut.                       |
| `/hotel/folios/[folioId]`             | **Folio:** tabular posting/payment ledger, tabular-number summary, post-extra/adjust/reverse/collect/refund actions according to capabilities, printable statement.            |
| `/hotel/payments`                     | **Settlement register:** business-date tender totals, payment/refund list, external references, receipt links, and reconciliation exceptions.                                  |
| `/hotel/night-audit`                  | **Night audit:** current business date, preflight blockers, five-step progress, preview totals, guarded Start/Retry action, and completion summary.                            |
| `/hotel/night-audit/[runId]`          | **Audit detail:** immutable step results, daily snapshot, failures/retry history, and referenced reservations/folios.                                                          |
| `/hotel/settings/property`            | Existing property settings; add read-only current business date and explicit audit-time explanation.                                                                           |
| `/hotel/settings/rooms`               | Existing room types/rooms/beds/blocks administration; keep separate from the operational room board.                                                                           |

UI behavior requirements:

- Use hotel-local dates/time labels and display the property currency; all money uses tabular
  numbers. Never infer a date from the browser timezone.
- Status uses `StatusPill` with text/icon/dot; color is never the sole signal. Financial debits and
  credits also include signs and labels.
- Mutation dialogs name the reservation/room/amount, show server preview data, require reasons for
  adjustment/reversal/refund/manual status actions, disable during submission, and recover entered
  values after validation failures.
- Tables scroll inside bounded containers at narrow widths; primary actions wrap below headings.
  The front-desk and night-audit workflows remain keyboard complete at 375 px, 768 px, 1024 px,
  and 1440 px, in light/dark and reduced-motion modes.
- Print routes use server DTOs and accessible HTML; PDF generation and custom receipt hardware are
  not MVP requirements.

## 7. Demo hotel seed

Add a dedicated idempotent hotel demo seed (called by the existing seed/demo orchestration rather
than hidden in a UI route). Use fixed semantic keys and deterministic relative hotel-local dates so
reruns upsert configuration and rebuild only the named demo tenant's operational data.

**Property:** “Harbour Light Hotel”, code `HLH`, slug `harbour-light-demo`, mode `HOTEL`, timezone
`Asia/Karachi`, currency `PKR`, check-in `14:00`, check-out `11:00`, audit `02:00`, business date
equal to the seeded local “today”. Assign every demo persona to this property using the existing
hospitality role templates.

**Inventory:**

- `STD` Standard Queen: six rooms `101`–`106`, capacity 2, base demo rate PKR 18,000/night.
- `DLX` Deluxe Twin: three rooms `201`–`203`, capacity 3, base demo rate PKR 25,000/night.
- `STE` Harbour Suite: one room `301`, capacity 4, base demo rate PKR 42,000/night.
- Room `106` is `OUT_OF_ORDER` with an active maintenance block; `105` is `VACANT_DIRTY`; `104`
  is `INSPECTED`; all other unoccupied rooms are `VACANT_CLEAN`.
- Existing meal plans: `RO` and `BB`. Existing extras: breakfast, airport transfer, laundry, and
  minibar, with synthetic clearly labelled demo prices/taxes.

**Personas:** owner, front-office manager, front-desk agent, reservations agent, night auditor,
housekeeper, and accounts/AR. Demo authentication uses the repository's existing fixture pattern;
the seed must not embed shared production passwords or secrets.

**Operational scenarios relative to business date `D`:**

1. `HLH-DEMO-ARRIVAL`: confirmed arrival on `D`, room `101` assigned, open zero-balance folio.
2. `HLH-DEMO-UNASSIGNED`: confirmed arrival on `D`, Standard Queen, no room assigned.
3. `HLH-DEMO-INHOUSE`: checked in `D-1` through `D+1` in `201`, room charge plus breakfast posted,
   partial cash payment recorded, non-zero remaining balance.
4. `HLH-DEMO-DUEOUT`: checked in through `D` in `202`, fully paid folio, ready to check out.
5. `HLH-DEMO-NOSHOW`: confirmed arrival `D-1`, unarrived and eligible for audit no-show.
6. `HLH-DEMO-FUTURE`: confirmed arrival `D+3` through `D+5` in the Suite.
7. One cancelled historical reservation and one checked-out historical reservation with closed,
   balanced folio, card settlement, receipt, room-status history, and reservation events.
8. One completed audit snapshot for `D-1`; no run for `D`, so the demo can execute night audit.

Seed assertions must reconcile every folio, avoid overlapping assignments/blocks, make physical
room statuses agree with active assignments, respect package limits, and remain identical after a
second run except for deliberately regenerated IDs/timestamps. Synthetic tax and price data must
be marked non-legal demo content.

## 8. Stable errors and observability

Return stable domain codes in the tRPC error cause/metadata while using appropriate tRPC status:

`HOTEL_PROPERTY_REQUIRED`, `HOTEL_MODULE_DISABLED`, `HOTEL_PROPERTY_FORBIDDEN`,
`HOTEL_RESERVATION_NOT_FOUND`, `HOTEL_RESERVATION_TRANSITION_INVALID`,
`HOTEL_AVAILABILITY_CHANGED`, `HOTEL_ROOM_UNAVAILABLE`, `HOTEL_ROOM_STATUS_INVALID`,
`HOTEL_CHECK_IN_BLOCKED`, `HOTEL_CHECK_OUT_BALANCE_DUE`, `HOTEL_FOLIO_CLOSED`,
`HOTEL_FOLIO_VERSION_CONFLICT`, `HOTEL_PAYMENT_AMOUNT_INVALID`, `HOTEL_PAYMENT_FAILED`,
`HOTEL_REFUND_EXCEEDS_PAYMENT`, `HOTEL_IDEMPOTENCY_CONFLICT`, `HOTEL_AUDIT_ALREADY_RUNNING`,
`HOTEL_AUDIT_PRECHECK_FAILED`, and `HOTEL_BUSINESS_DATE_CONFLICT`.

Expected concurrency conflicts are warnings/metrics, not exception traces. Emit structured metrics
for reservation creation/transition, availability conflict, check-in/out, folio posting/reversal,
payment attempt/outcome/refund, audit duration/failure/step retry, and business-date advancement;
labels may include tenant/property IDs and enumerated outcome, never guest PII or free-text reasons.
Audit logs sanitize guest notes and payment provider metadata.

## 9. Phased implementation tasks

Each checkbox is one independently reviewable task. A task includes focused unit tests, database
acceptance where it touches persistence/RLS/concurrency, authorization tests, and documentation of
any stable error it introduces.

### Phase 0 — contracts and persistence

- [ ] **H-MVP-001:** Record the reservation/status/date/money/idempotency decisions in the hotel domain constants and pure transition tests.
- [ ] **H-MVP-002:** Add guest and reservation enums/models, relations, indexes, checks, RLS, and migration acceptance tests.
- [ ] **H-MVP-003:** Add stay-unit and room-assignment persistence, overlap exclusion constraints, RLS, and two-connection concurrency tests.
- [ ] **H-MVP-004:** Add confirmation and operation-idempotency sequences/models with exact-replay and payload-conflict tests.
- [ ] **H-MVP-005:** Add folio/posting enums/models, immutable runtime grants, RLS, reversal constraints, and ledger-reconciliation tests.
- [ ] **H-MVP-006:** Add payment-attempt/payment-event/settlement/refund and receipt-sequence persistence with redaction, RLS, and over-refund tests.
- [ ] **H-MVP-007:** Add property business date and night-audit run/step/snapshot persistence with one-run and immutable-close tests.

### Phase 1 — reservation and inventory services

- [ ] **H-MVP-008:** Implement the shared hotel-local date-range and availability calculator over rooms, stay units, assignments, and blocks.
- [ ] **H-MVP-009:** Implement locked reservation create/confirm/update/cancel commands with sequence allocation, idempotency, and append-only events.
- [ ] **H-MVP-010:** Implement locked room assign/change/release commands with room-type/kind/status checks and overlap-safe writes.
- [ ] **H-MVP-011:** Add the `hotelReservations` router and mount it with module, capability, tenant, and property-scope contract tests.
- [ ] **H-MVP-012:** Add `hotelProperty.inventory.statusBoard` and `availabilityCalendar` read models without duplicating availability rules.
- [ ] **H-MVP-013:** Split operational occupancy transitions from administrative/housekeeping status mutation and test the allowed transition matrix.

### Phase 2 — front desk

- [ ] **H-MVP-014:** Implement check-in preview/command, deposit hook, folio opening, assignment activation, room occupancy, and rollback-injection tests.
- [ ] **H-MVP-015:** Implement room-move preview/command with atomic old/new room status and assignment/event history.
- [ ] **H-MVP-016:** Implement checkout preview/command with exact-balance gate, folio closure, assignment release, dirty-room transition, and rollback tests.
- [ ] **H-MVP-017:** Add and mount `hotelFrontDesk` with board/check-in/move/check-out/no-show routes and role/property authorization tests.
- [ ] **H-MVP-018:** Build `/hotel/reservations` registry with filters, pagination, loading/empty/error/denied states, and responsive acceptance tests.
- [ ] **H-MVP-019:** Build `/hotel/reservations/new` with server availability, accessible validation, review, idempotent submit, and stale-availability recovery.
- [ ] **H-MVP-020:** Build `/hotel/reservations/[reservationId]` with timeline, assignment, folio summary, and capability-shaped actions.
- [ ] **H-MVP-021:** Build `/hotel/front-desk` board and check-in/move/check-out dialogs with keyboard/mobile/theme/reduced-motion QA.
- [ ] **H-MVP-022:** Build `/hotel/rooms` operational status board with audience-safe fields and housekeeping transitions.
- [ ] **H-MVP-023:** Build `/hotel/availability` calendar with bounded overflow, non-color legend, and reservation handoff.

### Phase 3 — folio and settlement

- [ ] **H-MVP-024:** Implement the pure folio ledger calculator and invariants for charges, credits, reversals, payments, refunds, and currency equality.
- [ ] **H-MVP-025:** Implement atomic open/post-extra/manual-adjust/reverse folio commands with snapshots, idempotency, locks, and audit records.
- [ ] **H-MVP-026:** Add and mount `hotelFolios` with get/post/reverse/statement routes and capability-boundary tests.
- [ ] **H-MVP-027:** Implement cash collection and sanitized external-card attempt/result commands with receipt allocation and failure rollback tests.
- [ ] **H-MVP-028:** Implement linked refunds with cumulative cap, concurrent-refund serialization, idempotency, and receipt evidence.
- [ ] **H-MVP-029:** Add and mount `hotelPayments` with quote/collect/card/refund/receipt/settlement-summary routes and redaction tests.
- [ ] **H-MVP-030:** Build `/hotel/folios/[folioId]` ledger, statement, posting/adjustment/reversal actions, and exact balance display.
- [ ] **H-MVP-031:** Build folio payment/refund/receipt interactions with preview hashes, pending/failed states, and accessible confirmations.
- [ ] **H-MVP-032:** Build `/hotel/payments` settlement register with tender totals, reconciliation exceptions, pagination, and financial-report authorization.

### Phase 4 — night audit

- [ ] **H-MVP-033:** Implement audit PRECHECK and exclusive property-run locking with deterministic blocker output.
- [ ] **H-MVP-034:** Implement idempotent NO_SHOWS and ROOM_POSTINGS steps using unique reservation/service-date source keys.
- [ ] **H-MVP-035:** Implement BALANCES snapshot/reconciliation and ADVANCE_DATE atomic close, including failure injection at every boundary.
- [ ] **H-MVP-036:** Implement failed-run resume/retry without duplicate charges, events, snapshots, or business-date advancement.
- [ ] **H-MVP-037:** Add and mount `hotelNightAudit` status/start/retry/history/snapshot routes with auditor/manager authorization and concurrency tests.
- [ ] **H-MVP-038:** Build `/hotel/night-audit` preflight/progress/retry/completion workflow with destructive guard and all required UI states.
- [ ] **H-MVP-039:** Build `/hotel/night-audit/[runId]` immutable detail/snapshot view with authorized drill-downs.

### Phase 5 — dashboard, demo, and release

- [ ] **H-MVP-040:** Replace hotel dashboard placeholders with business-date KPIs and actionable arrivals/in-house/due-out/room/audit queues.
- [ ] **H-MVP-041:** Implement the Harbour Light configuration/inventory/persona seed with fixed semantic keys and package-limit validation.
- [ ] **H-MVP-042:** Implement the eight deterministic operational seed scenarios, ledger/status reconciliation assertions, and safe named-tenant reset.
- [ ] **H-MVP-043:** Add a seed idempotency test proving a second run has no duplicates, overlaps, balance drift, or cross-tenant effects.
- [ ] **H-MVP-044:** Add end-to-end receptionist coverage: create, confirm, assign, check in, post extra, collect payment, check out.
- [ ] **H-MVP-045:** Add end-to-end night-auditor coverage: preflight failure, correction, retry, postings, snapshot, and one-day advancement.
- [ ] **H-MVP-046:** Add two-session race coverage for last-room booking, room assignment, final payment/refund, checkout, and night-audit start.
- [ ] **H-MVP-047:** Complete Studio visual QA at 375/768/1024/1440, light/dark, normal/reduced motion, keyboard, zoom/reflow, and no document overflow.
- [ ] **H-MVP-048:** Run migration/RLS suites, unit/integration/e2e tests, typecheck, lint, and production build; record release evidence and rollback rehearsal.

## 10. Acceptance and rollout gates

1. **Isolation:** restricted runtime-role tests prove tenant and property isolation for every new
   table and route, including non-disclosing not-found behavior.
2. **Inventory integrity:** two concurrent sessions cannot oversell the last unit or overlap active
   room/bed assignments; reservations and active blocks are both counted.
3. **Lifecycle atomicity:** injected failure at every check-in, move, and checkout write boundary
   leaves reservation, assignment, room, folio, and events mutually consistent.
4. **Money integrity:** every folio reconciles from append-only evidence; exact replay adds nothing;
   failed payments add no settlement; concurrent refunds cannot exceed the original.
5. **Audit integrity:** a property has one business date and one run for it; retry produces one
   room posting per stay/service date, one snapshot, and exactly one date advance.
6. **Authorization:** the role matrix in §5 is tested positively and negatively; module disablement
   removes navigation and fails direct API calls without treating capability as entitlement.
7. **Demo integrity:** all §7 scenarios render, reconcile, and support the complete receptionist and
   auditor journeys immediately after a clean seed and after a second seed.
8. **UI quality:** every page meets the DevFathom Studio component, accessibility, responsive,
   theme, motion, and state requirements listed in §6.

Roll out behind the existing hospitality module entitlements, one property at a time. Before
enablement, migrate/provision `businessDate` and sequences and validate inventory consistency.
Rollback disables new operational mutations and navigation but does not delete or reinterpret
reservations, events, folio postings, payments, receipts, or audit snapshots. An audit already in
progress must either resume on the same version or be operationally held; it must never be replaced
by manually advancing the business date.

## 2.5 Security design (mandatory Phase 0/1 contract)

Security is enforced at DTO, service, query, and database layers. Folio data is deny-by-default and every router, service, report, export, background job, and AI tool must obtain a fresh property-scoped `hotel:folio` grant and use the shared folio-free projection otherwise. Reservation inputs identify configuration and never author rates, taxes, totals, balances, or payments; the server resolves and snapshots the locked property's rate and tax configuration. Recorded rate snapshots, postings, and settled payments are append-only evidence, with corrections represented only by linked reversing entries. Every write carries `organizationId`, `branchId`, and its record identifier in its predicate, and forced PostgreSQL RLS independently enforces both session scopes.
