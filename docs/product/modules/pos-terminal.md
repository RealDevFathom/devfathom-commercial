# POS & terminal module PRD

Operator workflow: [Restaurant administrator guide](../restaurant-administrator-guide.md#opening-and-daily-service).

Exact candidate `fee1686e16f532cb6ffad61f4c1320fd29909e7d` passed the serialized automated
gate (1139 files / 4046 tests, zero failed or skipped). Browser completion, the Linux/amd64 image
gate, and release authorization remain pending.

## Status vocabulary

- **IMPLEMENTED** — behavior is present at the cited repository path and has a cited test or source contract.
- **PLANNED** — product behavior or follow-up is in scope, but this evidence commit does not prove an implementation.
- **MOCKED** — a callable seam exists for demos/tests, but it is not a live external integration.
- **NOT BUILT** — no implementation evidence exists at this commit; it must not be presented as available.

## Product boundary

The POS & terminal module is the seller-operated register surface for a restaurant branch: a registered POS device establishes a terminal session, an operator signs in with a staff credential, and terminal commands create and progress orders through preparation, service, settlement, and close. The terminal transport is REST route handlers and is deliberately separate from a web-login session ([`src/lib/restaurant/terminal-auth.ts:37-55`](../../../src/lib/restaurant/terminal-auth.ts#L37-L55)). The licensed module key is `restaurant-pos`; entitlement is checked on every device- and session-authenticated request ([`src/lib/restaurant/terminal-auth.ts:161-181`](../../../src/lib/restaurant/terminal-auth.ts#L161-L181)).

This PRD covers POS/register, terminal identity and session, order entry, kitchen handoff, checkout/tender, cash drawer and day close, and the branch/tenant controls around them. It does not redefine catalog, inventory, SOP, or platform administration; those are adjacent capabilities consumed by the terminal.

## Personas

| Persona                  | Need                                                                                                                         | Evidence/status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cashier / server         | Open and edit an order, fire courses, mark items served, settle a bill, and close the order from a bound terminal.           | **IMPLEMENTED** — terminal order route schemas and command transport ([`src/lib/restaurant/terminal-orders.ts:33-52`](../../../src/lib/restaurant/terminal-orders.ts#L33-L52), [`src/lib/restaurant/terminal-orders.ts:71-128`](../../../src/lib/restaurant/terminal-orders.ts#L71-L128)); end-to-end flow ([`tests/restaurant-m4-acceptance.test.ts:440-510`](../../../tests/restaurant-m4-acceptance.test.ts#L440-L510)).                                                                                                                                                                                                                                                    |
| Manager / approver       | Authorize sensitive comp, re-cut, refund, post-preparation void, and day-close correction actions with their own credential. | **IMPLEMENTED** — strict approver payload and capability gates ([`src/lib/restaurant/checkout-routes.ts:91-100`](../../../src/lib/restaurant/checkout-routes.ts#L91-L100), [`src/lib/restaurant/checkout-routes.ts:186-275`](../../../src/lib/restaurant/checkout-routes.ts#L186-L275)); terminal void/co-authorization coverage ([`tests/restaurant-m4-acceptance.test.ts:598-672`](../../../tests/restaurant-m4-acceptance.test.ts#L598-L672)).                                                                                                                                                                                                                              |
| Branch operator          | Use only devices, menu publications, orders, bills, and cash records for the assigned branch.                                | **IMPLEMENTED** — device branch ownership and branch-scoped reads ([`src/lib/restaurant/checkout-routes.ts:466-504`](../../../src/lib/restaurant/checkout-routes.ts#L466-L504)); cross-tenant/terminal isolation acceptance ([`tests/restaurant-m4-acceptance.test.ts:762-790`](../../../tests/restaurant-m4-acceptance.test.ts#L762-L790)).                                                                                                                                                                                                                                                                                                                                   |
| Owner / product operator | Enable or disable the POS entitlement and manage branch/device/staff setup.                                                  | **IMPLEMENTED** — terminal entitlement enforcement plus `/restaurant/settings/branches`, `/restaurant/staff`, and `/restaurant/devices` administration are present ([`src/lib/restaurant/terminal-auth.ts:161-181`](../../../src/lib/restaurant/terminal-auth.ts#L161-L181), [`src/components/restaurant/restaurant-branches-console.tsx`](../../../src/components/restaurant/restaurant-branches-console.tsx), [`src/components/restaurant/restaurant-staff-console.tsx`](../../../src/components/restaurant/restaurant-staff-console.tsx), [`src/components/restaurant/restaurant-devices-console.tsx`](../../../src/components/restaurant/restaurant-devices-console.tsx)). |

## Workflows

### 1. Establish, unlock, operate, lock

1. An administrator uses `/restaurant/devices` on the intended browser, selects its branch and POS/KDS kind (plus station for KDS), and confirms **Enroll this browser**. Enrollment ends the administrator session and stores the device credential in an HTTP-only browser cookie; `/pos` or `/kds` then establishes the terminal automatically ([`src/components/restaurant/restaurant-devices-console.tsx`](../../../src/components/restaurant/restaurant-devices-console.tsx), [`src/app/api/restaurant/devices/browser-enroll/route.ts`](../../../src/app/api/restaurant/devices/browser-enroll/route.ts)).
2. The operator establishes/unlocks with a PIN or badge credential. Operator credentials are terminal-only and cannot become web-login sessions (**IMPLEMENTED**, [`tests/restaurant-m2-terminal-threats.test.ts:335-379`](../../../tests/restaurant-m2-terminal-threats.test.ts#L335-L379)).
3. The session is revalidated fresh on each call; revocation or expiry forces rejection, and failed operator attempts produce durable lockout evidence (**IMPLEMENTED**, [`tests/restaurant-m2-terminal-threats.test.ts:382-432`](../../../tests/restaurant-m2-terminal-threats.test.ts#L382-L432)).
4. Lock, heartbeat, switch operator, and co-authorize are terminal session operations (**IMPLEMENTED** route surface, [`src/app/api/restaurant/terminal`](../../../src/app/api/restaurant/terminal)).

### 2. Build and fulfil an order

The operator opens `DINE_IN`, `TAKEAWAY`, or connected-only `DELIVERY` orders and sends work to the kitchen. Delivery requires a customer, saved address, active same-branch zone, and a menu publication that includes `DELIVERY`; attachment freezes the zone fee, address, and promise snapshots. Kitchen handoff supports PREPAID and COD dispatch followed by delivery completion. The delivery fee remains a separate non-taxable checkout and receipt amount. Offline delivery creation is rejected and customer delivery details are not cached on the terminal.

The terminal effective-menu read composes the same menu resolution primitives as the back office, and exposes a version/ETag seam for refreshes (**IMPLEMENTED**, [`src/lib/restaurant/terminal-orders.ts:538-735`](../../../src/lib/restaurant/terminal-orders.ts#L538-L735)).

### 3. Bill, tender, receipt, and close

The operator cuts a bill with no split, by item, by seat, or fractionally; applies a comp only with manager co-authorization; accepts cash, card, or other tender; and can refund only with manager co-authorization. Exact decimal money, over-tender/insufficient-cash/refund-cap validation, tips, change, and remaining due are part of the route contract ([`src/lib/restaurant/checkout-routes.ts:75-184`](../../../src/lib/restaurant/checkout-routes.ts#L75-L184), [`src/lib/restaurant/checkout-routes.ts:591-627`](../../../src/lib/restaurant/checkout-routes.ts#L591-L627)). Settled bills expose display-only receipt data, including receipt number, lines, totals, tender type, tip, and change; PAN/CVV/track data is never surfaced ([`src/lib/restaurant/checkout-routes.ts:498-588`](../../../src/lib/restaurant/checkout-routes.ts#L498-L588)).

Card tender is **MOCKED**, not an online payment gateway: the schema's only payment provider is `MOCK`, and the adapter-side provider reference is a stored reference rather than proof of live processor connectivity ([`prisma/schema.prisma:4015-4044`](../../../prisma/schema.prisma#L4015-L4044), [`prisma/schema.prisma:4230-4244`](../../../prisma/schema.prisma#L4230-L4244)). Operator-confirmed card tender must therefore be described as a local/mock tender confirmation, not gateway authorization.

Cash drawer open, paid-in/paid-out/drop, counted close, day-close preview, day close, and manager-corrected close are **IMPLEMENTED** route contracts ([`src/app/api/restaurant/cash`](../../../src/app/api/restaurant/cash), [`src/lib/restaurant/checkout-routes.ts:629-697`](../../../src/lib/restaurant/checkout-routes.ts#L629-L697)). Receipt numbering is separate from order numbering and is covered for concurrent settlement ([`tests/restaurant-m5-acceptance.test.ts:587-667`](../../../tests/restaurant-m5-acceptance.test.ts#L587-L667)).

A durable simulated print bridge is **IMPLEMENTED**: branch/station routes select a simulated printer, ESC/POS bytes are rendered, jobs persist for retry, and organization/branch/idempotency-key replay returns the prior result without duplicate delivery ([`src/lib/restaurant/printing/service.ts`](../../../src/lib/restaurant/printing/service.ts), [`src/lib/restaurant/printing/esc-pos.ts`](../../../src/lib/restaurant/printing/esc-pos.ts)). Physical/network/operating-system printer transport and printer fleet discovery remain **NOT BUILT**; a simulated `PRINTED` result is not evidence that paper was produced.

## Permissions and boundaries

- **Module boundary — IMPLEMENTED:** disabled effective `restaurant-pos` entitlement returns 403 at the terminal transport, independent of client navigation ([`src/lib/restaurant/terminal-auth.ts:161-181`](../../../src/lib/restaurant/terminal-auth.ts#L161-L181)).
- **Device/session boundary — IMPLEMENTED:** bearer device secret plus live terminal session; device/session are fresh-checked each call, and revocation is not trusted from client state ([`src/lib/restaurant/terminal-auth.ts:271-280`](../../../src/lib/restaurant/terminal-auth.ts#L271-L280), [`tests/restaurant-m2-terminal-threats.test.ts:382-405`](../../../tests/restaurant-m2-terminal-threats.test.ts#L382-L405)).
- **Branch boundary — IMPLEMENTED:** a device belongs to one branch; terminal reads require the device branch, and cross-branch/cross-tenant identifiers behave as not found ([`src/lib/restaurant/checkout-routes.ts:466-477`](../../../src/lib/restaurant/checkout-routes.ts#L466-L477), [`prisma/schema.prisma:2578-2605`](../../../prisma/schema.prisma#L2578-L2605)).
- **Operator capability boundary — IMPLEMENTED:** money capabilities are default-deny; user permission overrides take precedence, explicit deny beats allow, and no linked user is denied ([`src/lib/restaurant/checkout-routes.ts:186-245`](../../../src/lib/restaurant/checkout-routes.ts#L186-L245)).
- **Tenant/RLS boundary — IMPLEMENTED:** the M5 RLS probe pins forced RLS on 12 money tables ([`tests/restaurant-m5-rls.test.ts:207-269`](../../../tests/restaurant-m5-rls.test.ts#L207-L269)); the broader M3 probe pins the 28-table allowlist ([`tests/restaurant-m3-rls.test.ts:161-228`](../../../tests/restaurant-m3-rls.test.ts#L161-L228)).
- **Mutation integrity — IMPLEMENTED:** terminal mutations require a header idempotency key, strict input bodies reject unknown fields, and failed command errors escape the owning transaction for rollback ([`src/lib/restaurant/terminal-orders.ts:33-52`](../../../src/lib/restaurant/terminal-orders.ts#L33-L52), [`src/lib/restaurant/terminal-orders.ts:130-160`](../../../src/lib/restaurant/terminal-orders.ts#L130-L160), [`src/lib/restaurant/terminal-auth.ts:81-102`](../../../src/lib/restaurant/terminal-auth.ts#L81-L102)).

## Non-goals

- **IMPLEMENTED / MOCKED:** durable print routing, queue/retry, idempotency, and ESC/POS rendering use a simulation adapter; physical/network/OS printer transport and printer fleet management are **NOT BUILT**.
- **NOT BUILT / outside this PRD:** live card processor, acquiring-bank authorization, tokenization, PAN/CVV handling, or gateway settlement. The current card path is **MOCKED**.
- **PLANNED:** native mobile apps; current evidence is for terminal/web surfaces and responsive web, not a mobile app.
- This module does not replace back-office menu authoring, inventory purchasing, SOP scheduling, platform entitlements, or tenant administration.
- Offline queueing is limited to new non-delivery order drafts composed from cached catalog data: open order, add item (including chosen modifiers), and fire. Tenders, card capture, refunds, drawers/day close, customer/loyalty, delivery, and controlled or sensitive changes to server-owned orders remain connected-only. Replay uses stable idempotency keys and pauses for re-authentication or operator review; it is not an authorization bypass ([`src/lib/restaurant/pos-command-queue.ts`](../../../src/lib/restaurant/pos-command-queue.ts), [`src/lib/restaurant/pos-client-store.ts`](../../../src/lib/restaurant/pos-client-store.ts)).

## User stories

1. As a cashier, I can sign into a registered branch terminal and see only the branch's effective menu and open orders.
2. As a server, I can create dine-in, takeaway, or connected direct-delivery orders, hold/fire courses, and send work to the kitchen.
3. As a manager, I can co-authorize sensitive corrections with my own credential and leave attributable evidence.
4. As a cashier, I can split a bill, confirm cash/card/other tender, see change and remaining due, and view the settled receipt data.
5. As a cash owner, I can open/count/close a drawer and preview or correct a business-day close.
6. As a security owner, I can revoke a device or session and have the next request rejected.
7. As a product owner, I can distinguish implemented simulated printing from unbuilt physical printer transport and mock payment behavior.

## Checkable acceptance criteria

| ID    | Criterion                                                                                                                                           | Evidence/status                                                                                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | A terminal request without a valid device credential, with a revoked device, or with a disabled `restaurant-pos` entitlement is rejected.           | **IMPLEMENTED** — [`src/lib/restaurant/terminal-auth.ts:208-269`](../../../src/lib/restaurant/terminal-auth.ts#L208-L269).                                                                                                                |
| AC-02 | Operator credentials stay terminal-only; five failures lock out the operator and revocation defeats an existing session.                            | **IMPLEMENTED** — [`tests/restaurant-m2-terminal-threats.test.ts:335-432`](../../../tests/restaurant-m2-terminal-threats.test.ts#L335-L432).                                                                                              |
| AC-03 | A terminal can execute open/add/hold/fire/serve/close order flows, while invalid prepared-item closure/cancellation requires the stated safeguards. | **IMPLEMENTED** — [`tests/restaurant-m4-acceptance.test.ts:440-672`](../../../tests/restaurant-m4-acceptance.test.ts#L440-L672).                                                                                                          |
| AC-04 | Cross-tenant and cross-branch order/KDS probes cannot expose another scope's data.                                                                  | **IMPLEMENTED** — [`tests/restaurant-m4-acceptance.test.ts:762-790`](../../../tests/restaurant-m4-acceptance.test.ts#L762-L790), [`tests/restaurant-m5-rls.test.ts:207-269`](../../../tests/restaurant-m5-rls.test.ts#L207-L269).         |
| AC-05 | Bills support the declared split types; tenders use exact decimal amounts; settled receipts contain display data only.                              | **IMPLEMENTED** — [`src/lib/restaurant/checkout-routes.ts:75-184`](../../../src/lib/restaurant/checkout-routes.ts#L75-L184), [`src/lib/restaurant/checkout-routes.ts:498-588`](../../../src/lib/restaurant/checkout-routes.ts#L498-L588). |
| AC-06 | Card tender is labeled operator-confirmed/mock and never described as a live online gateway.                                                        | **MOCKED** — [`prisma/schema.prisma:4080-4087`](../../../prisma/schema.prisma#L4080-L4087), [`prisma/schema.prisma:4230-4244`](../../../prisma/schema.prisma#L4230-L4244).                                                                |
| AC-07 | Simulated print jobs are durable, retryable, idempotent, and ESC/POS-rendered without claiming physical transport.                                  | **IMPLEMENTED / MOCKED** — [`src/lib/restaurant/printing/service.ts`](../../../src/lib/restaurant/printing/service.ts), [`src/lib/restaurant/printing/printing.db.test.ts`](../../../src/lib/restaurant/printing/printing.db.test.ts).    |
| AC-08 | The document's relative links resolve, cited paths exist, and the changed Markdown passes repository formatting and whitespace checks.              | **PLANNED verification for this change** — run the commands in the completion report; a failed/not-run check is not a pass.                                                                                                               |

## Open decisions

- **PLANNED:** choose and document a real payment-provider adapter, its compliance boundary, and its authorization/refund semantics before changing the current **MOCKED** label.
- **PLANNED:** integrate and accept a physical/network/OS printer transport before claiming physical printing.
- **IMPLEMENTED:** `/restaurant/devices` supports admin-assisted enrollment of the current browser,
  branch/kind/station selection, automatic terminal establishment, listing, rotation, and
  co-authorized revocation. Manual secret display remains a recovery/rotation surface, not the
  ordinary operator launch sequence.

## Terminal webhook security rollout (SEC-006)

Provision one signing key per business and provider configuration. The receiver checks the signed
configuration identifier, a five-minute timestamp window and the exact body bytes. A stable event
ID preserves idempotency on retries. See the [terminal webhook contract](../restaurant-terminal-webhooks.md)
for provisioning, sender headers, key rotation and the bounded shared-key changeover.
