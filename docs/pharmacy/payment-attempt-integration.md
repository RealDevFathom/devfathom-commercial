# Durable payment attempts: foundation and integration boundary

This change is the storage and shared mutation gate for counter v2 phase 3. It
does **not** enable a new collection or resolution flow. The existing counter is
not yet calling preparation, and this is not a complete fix for every legacy
external-payment path. Keep the payment PR draft.

## Committed preparation

`prepareExternalPaymentAttempt` owns a separate `withTenantDb` transaction. Its
caller must first validate the active tenant member, current counter capability
and active branch assignment. The service is server-only and is not exposed as
an endpoint in this slice. Do not call it while an outer transaction holds the
sale lock, and do not dispatch a provider or show manual collection instructions
until its promise resolves after commit.

Preparation binds the organization, branch, sale, actor, device/request key,
method, server currency, amount and expected bill revision. An exact retry
returns the original record. A changed payload cannot reuse the key. One
unresolved attempt per sale is enforced in PostgreSQL, including concurrent
devices. The amount cannot exceed the remaining balance after partial tenders.

The row remains present when a later tender transaction rolls back. `PREPARED`
is evidence of uncertainty; it is not evidence that collection did or did not
happen. A missing tender or acknowledgement must never authorize collection
again. The existing tender outcome reader returns `UNKNOWN` when it finds an
unresolved preparation, including when the queried tender key is absent.

All state transitions and deletes are refused by database triggers in this
slice. Same-tenant database access and a supplied actor/role cannot release a
bill. Audited dispatch, settlement and authorized resolution will require a
follow-up migration; no current caller may update `state` directly.

## Contract for phases 2 and 4

`pharmacy_assert_no_payment_attempt(organizationId, branchId, saleId)` locks the
scoped sale row and refuses any unresolved attempt. Call it in the **same
transaction**, before bill edits or stock reversal, and keep the sale lock until
commit. The line, allocation, sale-status, tender/refund-insert and linked stock-reversal
triggers also enforce this boundary, so a forgotten application check rolls the
transaction back. Tender and refund settlement check it before a provider call.

An absent attempt alone is not proof of non-payment. Preserve existing tender,
sale-status, prescription, branch and stock checks. Historical tender records
remain authoritative and recoverable. The revision increases on line,
allocation, tender or relevant sale changes. A stale preparation is refused.

This branch has no soft-removed line field. A future removal must keep original
allocation evidence, pass the lock and existing paid-sale checks, then update
the active-line predicate, totals, stock reversal and revision atomically. Do
not exclude a line merely because no tender row is visible. The aggregate in
`pharmacy_payment_attempt_prepare_guard` must adopt the same active-line
predicate when that schema lands; do not activate soft removal with different
settlement and preparation totals. Prescription-only metadata changes are
conservatively blocked while an attempt is unresolved.

## Next implementation step

Add an authenticated preparation endpoint outside the tender transaction, then
connect the counter's persisted request identity to it **before** external
collection. Integrate an atomic, compare-and-set dispatch/settlement hand-off
and recovery lookup using that attempt identity. The committed attempt must
survive provider success followed by database failure, without a second charge
or an unsafe stock reversal. Retain exact historical idempotency replay.

Implement audited confirmation/release using the stored active assigned
Owner/Manager policy from #1413, its deny precedence and branch checks. A cashier,
missing role, unknown role or client-supplied role cannot resolve uncertainty.
The foundation deliberately allows nobody to resolve it yet.

Then replace new offline JazzCash/Easypaisa/Raast finalization with a durable
pending hold that creates or recovers a server sale online before completion.
Preserve signed historical queue recovery; do not silently discard or rewrite
old commands. Test storage upgrade, lost acknowledgements and online recovery.
Card and online wallet remain online certified-adapter paths only; no adapter
is added by this foundation. Bank transfer remains amount-only.

## Verification

Apply migrations only to a new disposable PostgreSQL database. The new
`payment-attempts.db.test.ts` uses the existing
`WHA1364_RECEIPT_TEST_DATABASE_URL` convention and refuses a database whose name
does not start with `wha1364_`. It asserts `NOSUPERUSER` and `NOBYPASSRLS` before
running. It covers a committed preparation followed by rollback, synthetic
external success/lost acknowledgement, exact and conflicting retries,
concurrent devices, edit races, partial balances, mutation/reversal refusal,
immutable identity, tenant/branch isolation and refusal of raw release.

No production database, real provider or deployed application is exercised.
These tests establish the foundation's invariants; they do not establish
end-to-end provider dispatch, Owner/Manager resolution or offline pending
recovery, which remain to be implemented above.
