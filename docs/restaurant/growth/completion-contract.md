# Restaurant Growth count-only completion

The production generation path uses the unchanged shared Growth generator and provider gateway.
The admitted fact is `catering_confirmed_count`, with `CATERING_REVIEW` / `REVIEW_CATERING`.
It counts the full recorded set whose **current status is CONFIRMED**, selected by the existing
catering report's **eventDate** windows. It is not historical confirmation throughput, fulfilled
bookings, revenue, capacity, outreach eligibility or a causal result.

Each period is independently withheld unless every counted booking has a same-tenant,
non-anonymized customer and matching confirmed quote, approval, revision and confirmation event.
The privacy denominator is distinct stored customer IDs, at least ten; the value is distinct
booking IDs. Repeated bookings do not inflate the denominator. A null, anonymous, inconsistent,
or overflowing period is withheld in full. The existing interactive limit is 200, read as limit+1;
COMPLETE means the complete matching recorded booking set. A qualifying current period may be
used without a comparison fact; unknown comparison is never zero-filled. Adjacent equal windows
remain at most 45 calendar dates, with exclusive UTC-midnight date labels.

Generation, source reads and reviews preserve the current tenant/branch/Core/POS/financial
capability guards and additionally require `catering:read`. No Finance close or money comparison
is required to admit this operational count. USD/PKR is current organization context, not a
historically pinned currency or a monetary fact. Other metrics remain unsupported by this reader.

The persisted snapshot is the prepared shared input at the root plus `_restaurant` metadata:
`version: restaurant-growth-v2`, actor/request fingerprint, private provenance, sourceHash and
failureReason. Root actions preserve the existing Restaurant draft SQL contract. Shared schema
version remains 1. No migration or shared contract change is needed. Old unavailable records
remain readable/replayable; legacy READY without this provenance cannot become reviewable.
Only the extracted strict shared input reaches the model; private identifiers and source history
do not. Model output supplies only validated tokens/references. Numbers and facts remain server-owned.

The private projection includes policy, tenant/branch, exact periods, currency, booking/customer
membership, persisted customer/order updates, confirmed quote hash/revision, approval and latest
source/transition event identity. Its canonical hash excludes observation time. `freshAt` is the
latest contributing persisted change watermark, never the read clock or a universal age guarantee.
Authorized rereads compare both exact private source hash and canonical shared input hash.
Generation checks replay under an actor/request lock before model work; READY is withheld if
source changes while the model runs. Before final persistence/review, the existing catering branch
lock, contributing order advisory locks in ID order, and customer row locks serialize transitions, delivery-event edits and anonymization.

Consent is not an admission filter for this inert operational review. A consent withdrawal does
not redefine the full confirmed-booking count or authorize outreach. Existing loyalty sandbox
consent/STOP, caps, quiet hours, idempotency and unknown-no-resend controls remain unchanged and
separately tested. Finance close corrections remain governed by the existing Finance readers;
no close data is presented as catering model evidence.

APPROVE appends exactly one existing `restaurant_growth_drafts` DRAFT plus its linked final review.
EDIT/REJECT stay append-only. No published promotion, audience, payment or message is created.
The diagnostic fixture uses real restricted PostgreSQL and production generation/read/binding/
review/draft code, with only provider configuration/transport replaced inside Vitest. Its provider
is `TEST_DOUBLE`, model `DETERMINISTIC_CATERING_TOKENS`; the ordinary app displays a diagnostic
notice. There is no client flag, environment switch, alternate app, or model fallback.
A passing diagnostic does not prove a configured application provider.
