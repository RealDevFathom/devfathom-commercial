# Pharmacy card-terminal integration boundary (DEV-743)

Status: provider-neutral seam, durable record, router, counter states, day-close gate, recovery
sweep, manual-review resolution, audit trail, one shared timeout and refund/void refusals shipped.
**No provider, SDK or device is bound.**
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
review    MANUAL_REVIEW ──► DECLINED (no charge evidence) | REVERSED (money taken)
            manager or owner PIN, reason and terminal-slip reference, exactly once
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
  - `resolveReview` resolves a manual review (see below). A cashier is refused.
  - The counter waits 45 seconds for the terminal, inside the 60-second request transaction.
    That is `CARD_TERMINAL_TIMEOUT_MS` (`timing.ts`), the one timeout the router, the recovery
    sweep and the service default all use, so a stale CREATED attempt, an unfinished SENT one and
    the NOT_FOUND grace (twice the timeout) are judged by the same clock everywhere.
- **Counter states** (`counter-card-terminal-panel.tsx`, shown in the payment overlay only when
  `availability` is true):

  | State       | Shown when                                                                 |
  | ----------- | -------------------------------------------------------------------------- |
  | Sending     | CREATED                                                                    |
  | Waiting     | SENT, or while the charge request is out                                   |
  | Unknown     | UNKNOWN. The panel offers **Check status**                                 |
  | Approved    | APPROVED, while the tender is recorded                                     |
  | Paid        | SETTLED                                                                    |
  | Declined    | DECLINED                                                                   |
  | Not sent    | ABANDONED                                                                  |
  | Review      | MANUAL_REVIEW. The only action is the manager review form (below)          |
  | Money taken | REVERSED: refund it through the card provider, then take the payment again |

  The view carries no provider reference and no terminal id: only the brand and the last four
  digits.

- **Day close**: `cutPharmacyDailyClose` (both the Z report and the counted close) refuses with
  `CARD_TERMINAL_PAYMENT_OPEN` while any attempt on that business day is open. It checks under the
  day lock. The attempt is committed under that same lock: `create` takes it again after the
  preflight savepoint, because rolling a savepoint back releases the locks taken inside it. The
  trigger `pharmacy_daily_closes_card_terminal_guard` refuses the close row itself.
- **Recovery sweep** (`sweep.ts`, run by `/api/platform/jobs/process` every 5 minutes): finds
  attempts untouched for 2 minutes in CREATED, SENT, UNKNOWN or APPROVED, across tenants, and
  recovers each one as its own cashier with the counter's status check and the counter's own
  timeout. Manual review is not swept.
- **One approval, one tender**: the unique index `pharmacy_tenders_terminal_provider_ref_key`
  covers terminal CARD tenders on (organization, provider, provider reference). Manual, sandbox,
  prepaid and mock providers are outside it, because their slip references may repeat.

## Resolving a manual review

`pharmacyCardTerminal.resolveReview` and the review form in the counter panel
(`counter-card-terminal-review.tsx`). The refund rule applies:

- Only a manager or owner (`pharmacy:manage`, the refund check `actorMayRefund`). A cashier is
  refused before any PIN is asked, and the counter shows a cashier no review form, only a line to
  call a manager or owner.
- A second person: nobody resolves a charge they took themselves (the attempt's `actorId`) while
  someone else could resolve it at this branch, now. Someone else counts
  (`otherCardTerminalReviewers`) only if all of these hold:
  - they could enter their own approval PIN. Candidates are built as `isSoleApprover` builds them:
    an unrevoked PIN not tied to a device, on an ACTIVE staff profile of an ACTIVE member. A member
    on leave, or without such a PIN, does not count. A temporarily locked-out PIN still counts, as
    in `isSoleApprover`: the lockout is that person's to clear, and it never silently turns the
    resolver into a self-approver;
  - they pass the counter's operator and branch gate for this branch (`counterOperatorDenial`, the
    gate the resolve procedure applies). A manager assigned only to another branch, or whose
    counter access is denied, does not count;
  - they hold `pharmacy:manage`.
  - If someone else could, the resolver is refused before any PIN is asked, with a message naming
    one of them: "Another manager or owner must resolve a payment you took. Ask <name> or another
    manager at this branch to resolve it." The counter shows that line instead of the form.
  - If nobody could (the solo rule), the owner resolves their own charge with their PIN, so a
    pharmacy with only cashiers can still close its day. The counter says they may resolve it
    themselves.
  - The rule is checked again inside the write's own transaction, with the attempt row locked, so a
    manager activated after the first check still blocks the self-resolution. That refusal uses the
    same sentence, and the request's audit row then records `selfApproved: false` and
    `soloOwner: false`.
- The signed-in manager or owner re-enters their own PIN (`authenticateRefundPin`, policy
  `PHARMACY_CARD_TERMINAL_REVIEW_MANAGER_PIN`). A refused PIN commits its lockout strike and a
  FAILURE audit row, and changes nothing. The audit entry records `initiatedById` (who took the
  charge), `approverId` (who resolved it), `selfApproved` and `soloOwner`.
- Two outcomes only, each with a reason (3 to 200 characters) and the provider reference printed
  on the terminal slip:
  - **DECLINED**, nothing was charged. Refused when the terminal reported a charge reference.
  - **REVERSED**, money was taken. It is recorded, not made into a tender, and the cashier refunds
    it through the card provider's own process. The slip reference must match the reference the
    terminal reported; if the terminal never answered, the slip's reference is recorded as it.
- Exactly one resolution wins (compare-and-set on MANUAL_REVIEW); a second, even at the same
  moment, is told the review is no longer open. Once resolved, the sale can take another tender
  and the business day can close.
- The database requires it too (migration `20261118124100`): leaving MANUAL_REVIEW needs the
  resolver, the resolution time, the reason and a well-formed slip reference; a reversal's provider
  reference equals its slip reference; the resolution fields are written once, only by that step,
  never on insert, and never hold a card number.

## Audit trail

Every committed attempt change writes one `audit_logs` row (`pharmacyCardTerminal.attempt.*`:
`created`, `dispatched`, `approved`, `declined`, `unknown`, `manualReview`, `abandoned`,
`settled`, `reviewResolved`) **in the same transaction as the change**, inside the store's own
tenant transaction. A request (or a batch sibling) that rolls back afterwards never loses the
entry of an attempt change that committed, and a change that rolled back leaves none. The counter's
entries name the signed-in user; the sweep's are `SYSTEM` entries that name the attempt's cashier
as `onBehalfOfUserId`. Entries carry the state, amount, provider, provider reference, tender,
reason and resolution, plus the PIN approval for a resolution. Never the card brand, last four
digits, approval code, terminal id, PIN or a secret, and every value passes the card-number mask.

## Refund and void of a terminal-paid sale

An authorized terminal-tender refund records the amount owed after the usual day, tender and returned-value checks. The refund row reserves that amount against the sale and tender. Once fully covered, an otherwise voidable bill can follow the existing void process. A cash fallback is refused.

A review marked REVERSED debits the card settlement account (BANK). A tender refund debits SALES_CLEARING because the sale return already reversed the revenue. Both credit **Card refunds payable (provider)**, the fixed current liability shown in Pharmacy settings. A provider settlement debits that liability and credits BANK on the supplied settlement date. The amount is recorded in minor units and may cover part or all of the remaining obligation.

In Pharmacy accounts, **Card provider refunds** lists branch obligations, their age, settlements and review decisions. The linked history includes the reason, reviewer, approvals, provider reference and journal entries. Changes use the shared `pharmacyAccountMutation` gate and the existing branch, card-review and approval controls. Repeating an identical command returns the original receipt.

A correction requires owner authority or the same or higher authority as the original reviewer. A reviewer correcting their own decision needs independent approval. A sole owner with no other eligible reviewer must declare self-approval, provide a reason and verify their own approval credential. The audit records the exception. A mistaken tender refund is cancelled with a linked reversing journal. Partially or fully settled refunds cannot be cancelled. A historical decision without a role snapshot requires owner authority for correction. A historical mismatch without a recorded approved amount requires verification against the provider statement.

## Deferred, by the owner's decision

Provider and device selection wait for a named proposal and a real-device test. Until then this
change does not include:

- Any provider SDK, credentials, network access or real device.
- Terminal void and refund of a settled terminal tender through the provider. They will use the
  same attempt record.

These must also exist before any provider is admitted:

- **The timeout must be checked against the real provider.** The shared 45-second timeout gives
  the sweep a 90-second NOT_FOUND grace (twice the timeout).

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
  - a terminal approval cannot become a second tender;
  - two racing review resolutions give exactly one, then the sale takes another attempt and the
    day closes;
  - a cashier, a wrong PIN and "not charged" for a reported charge change nothing;
  - every committed step keeps its audit entry when the request rolls back, and the refund of the
    terminal-paid tender refuses cash fallback;
  - the sweep's audit entries name the system.
- `tests/pharmacy-card-terminal-review-migration.test.ts`: the resolution migration keeps every
  earlier guard rule.
- `src/lib/pharmacy/settlement.card-terminal-refund.test.ts` and `sales.test.ts`: refund and void
  refusals.
