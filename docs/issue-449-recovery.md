# Issue #449 — `archive/improve/ai-growth` recovery

The archived work was reviewed commit by commit against the current tree. The old branch should
not be reopened wholesale: the current growth, loyalty, and pharmacy implementations have moved
on substantially, while two narrowly useful pharmacy corrections were still missing.

## Ported

- `10706a9a` — substitute savings now use the latest received lot for the requested medicine and
  presentation in the active organization and branch, with the lot ID breaking equal-time ties.
  The public router and counter no longer accept or submit a client-selected reference price
  (`src/lib/pharmacy/substitute-finder.ts`; focused regression test in
  `src/lib/pharmacy/substitute-finder.test.ts`).
- The Karachi-day portion of `dedce1b7` — counter expiry warnings compare `Asia/Karachi` calendar
  dates rather than elapsed UTC 24-hour periods (`src/components/pharmacy/counter/counter-cart.tsx`;
  boundary coverage in `src/components/pharmacy/counter/counter-cart.test.tsx`).

## Skipped

- `dedce1b7` substitution recording: the current implementation has a newer explicit unfulfilled
  demand lifecycle, including a tenant-and-branch-scoped close with `SUBSTITUTE_DECLINED` in
  `src/lib/pharmacy/substitute-finder.ts`. Reintroducing the archived record shape would create a
  second source of truth.
- `bb32b10d`: current code already provides exact-equivalence, in-stock, unexpired substitute
  proposals and named expiry-advisor classifications in `src/lib/pharmacy/substitute-finder.ts`
  and `src/lib/pharmacy/expiry-advisor.ts`. The archived UI/model is obsolete.
- `59d1f039`: current campaign planning rejects regulated outreach unless explicitly approved in
  `src/lib/pharmacy/marketing.ts`. WhatsApp credentials are deployment configuration rather than
  database content, and `src/lib/pharmacy/whatsapp/provider.ts` retains the mandatory code-level
  live-send block; restoring archived encrypted-key storage would weaken that design.
- `d3e8cdad`: the current connected restaurant checkout already reads and displays the guest's
  live loyalty balance and redemption state in `src/components/restaurant/pos/checkout-panel.tsx`.
  That mutable balance must not be added to historical receipts: the settled-bill receipt query in
  `src/lib/restaurant/checkout-routes.ts` has no settlement-time loyalty-balance snapshot, so
  recomputing it later would misstate the original receipt. A receipt wallet should only be added
  with a separately designed, atomically frozen settlement fact.
- `afc587fe` and `7b81f39e`: the current restaurant growth surface has persisted generation,
  listing, detail review, permission-denied states, and evidence links in
  `src/app/(app)/restaurant/growth/page.tsx` and `src/components/restaurant/growth/`. The archived
  skeleton/inbox is superseded.
- Merge commits `eb6517a7`, `28ccce48`, and `ecfc2f76` contain no independent change to port beyond
  their reviewed children.

No archived migration was restored, so no migration timestamp was required. Tenant predicates,
exact-equivalence safety filters, and the live WhatsApp send block remain intact.
