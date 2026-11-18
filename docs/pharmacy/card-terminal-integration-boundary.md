# Pharmacy card-terminal integration boundary (DEV-743)

Status: provider-neutral seam, durable record, router, counter states, day-close gate and recovery
sweep shipped. **No provider, SDK or device is bound.**
The production admission list is empty, so every integrated terminal path refuses with
`UNCERTIFIED_PROVIDER`. Only a fake test terminal exists.

## What this is, and what it is not

|                           | Integrated terminal (this seam)            | Manual Card / Wallet (DEV-713, PR 1451)                |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Who talks to the terminal | DevFathom, through a `CardTerminalAdapter` | Nobody: the cashier types the slip details             |
| Provider on the tender    | The admitted adapter name                  | `MANUAL_TERMINAL` / `MANUAL_MERCHANT`                  |
| Durable attempt record    | `pharmacy_card_terminal_attempts`          | None (unchanged)                                       |
| Code                      | `src/lib/pharmacy/card-terminal/`          | `src/lib/pharmacy/manual-payments.ts`, `settlement.ts` |

The manual Card and Wallet tenders are unchanged and never touch the attempt table. The
attempt table's provider check refuses the manual, sandbox, prepaid and mock provider names, so
a terminal tender can always be told apart from a manual one.

## One durable payment-attempt record

Before this change, the integrated adapter path in `applyPharmacyTender` asked a provider to move
money inside the settlement transaction, with nothing committed first. A crash, timeout or lost
response could leave a real charge with no trace. Now a terminal charge always goes through one
row in `pharmacy_card_terminal_attempts`:

```
begin     guards pass ──► CREATED (committed)
dispatch  CREATED ──claim──► SENT ──► terminal.startCharge(operationRef = attempt id)
            approved ──► APPROVED ──► one CARD tender ──► SETTLED   (same transaction)
            declined, or refused before any card prompt ──► DECLINED
            timeout / error / pending ──► UNKNOWN      (never retried as a new charge)
recover   UNKNOWN or stale SENT ──► terminal.queryStatus(same operationRef)
            approved ──► APPROVED ──► SETTLED
            declined ──► DECLINED
            NOT_FOUND ──► DECLINED only after a grace of at least 2x the timeout
            still unknown after N checks ──► MANUAL_REVIEW
          APPROVED (settlement failed transiently) ──► retry settlement, never the charge
          stale CREATED ──► ABANDONED                (never sent late)
review    MANUAL_REVIEW ──► DECLINED (no charge evidence) | REVERSED (who resolved it)
```

### Guarantees, and where each one is enforced

| Guarantee                           | Application                                                                                                                              | Database                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Committed before any charge         | `beginCardTerminalCharge` commits before `dispatch` runs                                                                                 | Insert must be `CREATED`, unsent, with no evidence                                                                         |
| Same tender guards as a real tender | `preflightTerminalCharge` runs `applyPharmacyTender` up to the provider call inside a savepoint, then rolls back                         | —                                                                                                                          |
| One charge per attempt              | Only the `CREATED → SENT` compare-and-set winner calls the terminal                                                                      | Allowed-lifecycle trigger                                                                                                  |
| Replay never charges twice          | Same `attemptKey` returns the stored attempt; a different payload is `IDEMPOTENCY_CONFLICT`                                              | Unique `(organizationId, attemptKey)`                                                                                      |
| One open money operation per sale   | `ATTEMPT_IN_PROGRESS`                                                                                                                    | Partial unique index on open states; tender trigger refuses any other tender on the sale while one is open                 |
| One approval is one tender          | Settlement uses a replay adapter that returns the stored approval and never reaches a terminal; the tender and `SETTLED` commit together | Unique provider ref and tender link; `SETTLED` must match a CARD tender with the same provider, reference, sale and amount |
| Unknown is never "not charged"      | Timeouts and errors are `UNKNOWN`; `NOT_FOUND` counts only after the grace period                                                        | An attempt with charge evidence can never become `DECLINED`                                                                |
| No card data                        | Key and value guard on every terminal answer; logs redacted                                                                              | No 13+ digit run in any stored text; last four is exactly 4 digits                                                         |
| PKR only                            | `beginCardTerminalCharge` refuses any other currency; settlement refuses a non-PKR attempt                                               | Currency check `= 'PKR'` (tenders post to the journal in PKR with no conversion)                                           |
| Tenant isolation                    | Every read and write is scoped by organization and branch                                                                                | Forced RLS (organization and branch)                                                                                       |

An approval the sale can no longer take (for example `OVER_TENDER` or `SALE_NOT_OPEN`) moves
to `MANUAL_REVIEW` with its evidence kept, because the customer was charged and a person must
reverse it. A transient settlement failure leaves the attempt `APPROVED`, and recovery settles it.

## Provider contract

`src/lib/pharmacy/card-terminal/contract.ts`:

- `startCharge({ operationRef, terminalId, amountMinor, currency }, signal)` and
  `queryStatus({ operationRef, terminalId }, signal)`. The provider must treat `operationRef`
  (the attempt id) as its idempotency key.
- Answers: `APPROVED` (opaque reference, amount, optional approval code, brand, last four),
  `DECLINED`, `PENDING`, `NOT_FOUND` (status only), or `ERROR` with `reachedTerminal: false`
  only when the provider positively knows no card prompt happened.
- Admission: `terminalAdmissionRefusal`. A production process always uses the built-in empty
  list. Reserved names and simulated adapters are refused there.

## Router, counter states, day close and recovery

Built on the attempt record, with the fake terminal only. In production nothing resolves a
terminal, so all of this stays dormant.

- **Registry** (`registry.ts`): resolves the terminal paired with a counter. It returns nothing for
  every branch until a provider is bound. The browser never names the provider, terminal or
  currency.
- **Router** (`src/server/routers/pharmacy-card-terminal.ts`, `pharmacyCardTerminal.*`), with the
  same counter access as any tender:
  - `availability` is false unless an admitted terminal serves this counter.
  - `charge` commits the attempt, then dispatches one PKR charge for the balance due.
  - `checkStatus` asks the terminal about the same operation again (never a new charge).
  - `attempt` reads the sale's newest attempt, so a reloaded counter shows where it stands.
  - Every attempt step commits in its own tenant transaction, not in the request's. Each tRPC
    request runs inside one transaction, and a nested `$transaction` would reuse it, leaving
    CREATED and SENT uncommitted while the terminal charges.
  - The counter waits 45 seconds for the terminal, inside the 60-second request transaction.
- **Counter states** (`counter-card-terminal-panel.tsx`, shown in the payment overlay only when
  `availability` is true):

  | State    | Shown when                                                                   |
  | -------- | ---------------------------------------------------------------------------- |
  | Sending  | CREATED                                                                      |
  | Waiting  | SENT, or while the charge request is out                                     |
  | Unknown  | UNKNOWN. The panel offers **Check status**                                   |
  | Approved | APPROVED, while the tender is recorded                                       |
  | Paid     | SETTLED                                                                      |
  | Declined | DECLINED                                                                     |
  | Not sent | ABANDONED                                                                    |
  | Review   | MANUAL_REVIEW. There is no counter action: a manager or owner must review it |

  The view carries no provider reference and no terminal id: only the brand and the last four
  digits.

- **Day close**: `cutPharmacyDailyClose` (both the Z report and the counted close) refuses with
  `CARD_TERMINAL_PAYMENT_OPEN` while any attempt on that business day is open. It checks under the
  day lock. The attempt is committed under that same lock: `create` takes it again after the
  preflight savepoint, because rolling a savepoint back releases the locks taken inside it. The
  trigger `pharmacy_daily_closes_card_terminal_guard` refuses the close row itself.
- **Recovery sweep** (`sweep.ts`, run by `/api/platform/jobs/process` every 5 minutes): finds
  attempts untouched for 2 minutes in CREATED, SENT, UNKNOWN or APPROVED, across tenants, and
  recovers each one as its own cashier with the counter's status check. Manual review is not
  swept.
- **One approval, one tender**: the unique index `pharmacy_tenders_terminal_provider_ref_key`
  covers terminal CARD tenders on (organization, provider, provider reference). Manual, sandbox,
  prepaid and mock providers are outside it, because their slip references may repeat.

## Deferred, by the owner's decision

Provider and device selection wait for a named proposal and a real-device test. Until then this
change does not include:

- Any provider SDK, credentials, network access or real device.
- Resolving a manual review (to DECLINED with no charge evidence, or REVERSED) from a screen. It
  must use the refund rule: manager or owner PIN, with solo-owner self-approval and an audit
  record. Until it lands, a review case holds its sale and its business day open.
- Terminal void and refund of a settled terminal tender. Both are provider capabilities. They
  will use the same attempt record.

Binding a provider means two things in its own reviewed change, with the certification evidence
and the real-device test linked:

- returning its adapter from `resolvePharmacyCardTerminal`;
- adding its name to `PRODUCTION_TERMINAL_ADMISSION`.

## Tests

- `src/lib/pharmacy/card-terminal/service.test.ts`: mocked end to end with the fake terminal and
  an in-memory store that enforces the migration's rules.
- `src/lib/pharmacy/card-terminal/store.test.ts`: the Prisma store's lock order, preflight
  savepoint, settlement replay and compare-and-set.
- `src/lib/pharmacy/card-terminal/contract.test.ts`: admission and the cardholder-data guard.
- `tests/pharmacy-card-terminal-attempts-migration.test.ts`: migration contract.
- `tests/pharmacy-card-terminal-attempts.db.test.ts`: RLS, lifecycle, evidence and tender guards
  on PostgreSQL (skipped without a disposable database).
- `src/server/routers/pharmacy-card-terminal.test.ts`: the router mocked end to end with the fake
  terminal, covering availability, dispatch, unknown with a status check, manual review, access
  and server-chosen currency.
- `src/components/pharmacy/counter/counter-card-terminal-panel.test.tsx`: the counter states.
- `src/lib/pharmacy/card-terminal/sweep.test.ts` and `day-close-gate.test.ts`.
- `src/lib/pharmacy/card-terminal/counter.db.test.ts`: on PostgreSQL as the restricted runtime
  role, through the real store, settlement, close and sweep:
  - two racing dispatches send exactly one charge;
  - two racing charges for one sale commit one attempt;
  - the day close is refused while an attempt is open, then succeeds once it is recovered;
  - the sweep settles a stale attempt;
  - a terminal approval cannot become a second tender.
