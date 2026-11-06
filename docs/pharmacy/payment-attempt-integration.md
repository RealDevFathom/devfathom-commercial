# Durable payment preparation, settlement and recovery

Counter v2 phase 3 now commits a scoped payment attempt before exposing manual
collection instructions or dispatching a certified provider. Keep the payment
PRs draft: no real certified adapter or provider-status reconciler is configured,
and historical offline fiscal commands still have a separate recovery boundary.

## Preparation and collection

`beginManualCollection` authenticates current stored membership, counter grants,
branch assignment and tenant before preparing a sale. The server validates the
open day, prescription permission, current stock, method configuration, remaining
balance and bill revision. Preparation owns a separate committed transaction;
never call it from a transaction already holding the sale lock.

The immutable identity includes organization, branch, sale, actor, device/request
key, method, currency, amount and bill revision. Exact request retries recover the
same attempt; changed payloads cannot reuse the key. Concurrent new collections
serialize on the sale. One unresolved precollection attempt is enforced by a
partial unique index. Historical uncertainty reports are retained individually,
even when they overlap or exceed a stale balance; they never create money.

Preparation commits `PREPARED`, then commits `EXPOSED` before returning a one-use
secret and the current merchant instructions. Wallet instructions are bound to
the settings revision and content hash; stale settings prevent ordinary
completion. The counter stores request identity, never the secret. Replay,
reload, malformed acknowledgement or lost preparation acknowledgement leads to
recovery, never another collection.

Normal completion uses that token once to commit `UNKNOWN`, then records the
tender and result atomically. A rollback cannot erase the claim. A cashier cannot
retry an uncertain collection or confirm/release it. Exact completed historical
idempotency results retain their existing replay behavior.

JazzCash, Easypaisa and Raast retain validated payer/reference capture and
configured skip policy. Bank transfer is amount-only. Card and online wallet use
only the internal certified, online adapter path; no public endpoint accepts an
adapter, approval or manual card receipt. No new real adapter is introduced.
The existing admitted local sandbox remains nonfinancial and development-only.

The provider path commits its claim before dispatch, then retains existing batch
locks across dispatch and financial settlement. Its stable operation reference is
the attempt ID. A real approval followed by rollback is saved separately as
`CONFIRMED`; recovery finishes without another provider call. A missing adapter
acknowledgement remains `UNKNOWN` and cannot dispatch again. No status query or
manual card override is fabricated.

## Resolution and historical reports

Resolution reads actual active stored membership and approved system
Owner/Manager roles using the same role keys and deny precedence as day-close
eligibility (#1413). Non-admin staff require an active branch assignment. Missing,
unknown/custom roles, explicit denials and a cashier alone fail closed. An
organization ADMIN without an assigned organization role retains the existing
Owner fallback; an explicitly assigned unsupported role does not.

An authorized resolver supplies an audit reason and, for supported manual
methods, verifies funds or releases an unrecorded claim. Confirmation commits
`CONFIRMED` before financial completion. A later failure retains confirmed
funds and permits authorized recording retry, not release. Release never deletes
evidence. State changes and retries are audited by immutable tenant-scoped rows.

Older clients with no prepared token may explicitly report uncertain external
funds. The report is persisted as `LEGACY_CAPTURE/UNKNOWN`; it is never a new
tender or authorization to collect. Historical card/wallet reports also lock the
bill but cannot be resolved manually. Late funds reported after a released claim
create another stable uncertainty record and relock the bill. Multiple genuine
claims, stale overpayment, disabled methods or a closed original business day
remain locked if ordinary settlement cannot safely complete. No refund,
compensation, business-date change or lost-money assumption is invented.

## Offline holds

New manual-wallet commands are pending holds, not offline completed sales. They
consume no fiscal receipt number, produce no receipt and store no local payment
confirmation. The existing signed device/snapshot and branch checks still apply.
Online replay creates or recovers an OPEN server sale, reserved stock and a
`PREPARED/OFFLINE_HOLD` attempt atomically, then acknowledges the held command.
Only the separately authorized online resolution path can record funds.

The local hold remains available for recovery; read-only status checks never
cache financial confirmation. Historical accepted commands replay their known
outcome. Unresolved older leased manual-sale commands are paused, not silently
finalized, discarded or renumbered. Their recovery intersects #954, whose active
ownership is unverified; that PR is not edited here.

## Shared contract for phases 2 and 4

`pharmacy_assert_no_payment_attempt(organizationId, branchId, saleId)` locks the
scoped sale and refuses every unresolved attempt. Call it in the same transaction
before edits, cancellation, refund or stock reversal, retaining the sale lock
until commit. Database line, allocation, sale-status and linked stock-reversal
triggers provide the same fail-closed boundary. Tender writes use the exact
matching settlement claim and nonce; any other unresolved claim blocks them.
A missing tender alone is never proof that a bill is unpaid.

Preserve existing tender, sale-status, prescription, branch and stock checks.
Relevant changes increment paymentRevision. A future soft removal must preserve
original allocation evidence, pass this gate and existing paid-sale checks, then
update the active-line predicate, totals, revision and reversal atomically.
Preparation and settlement must use the same active-line predicate. This branch
has no soft-removed line field; it must not independently exclude rows.

## Verification boundary

Database tests require a new disposable `wha1364_*` PostgreSQL database and assert
NOSUPERUSER/NOBYPASSRLS. They cover rollback, lost acknowledgement, approval
recovery, idempotency, races, partial balances, merchant changes, batch locks,
restricted roles, tenant/branch isolation, immutable audit, late reports and
receipt-free offline holds. Unit/component tests cover persisted identity,
malformed acknowledgements, preparation, uncertain recovery and local-store
financial-data restrictions. No production data or real provider is exercised.
