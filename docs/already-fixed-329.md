# GitHub issue #329: already fixed in the current code

Issue #329 reports that the **Comp a bill line** dialog renders identical bill-line options
with identical visible labels. That report was made against PR #320 at `ddc5a4e6`; neither the
dialog nor a bill-line picker exists in the current branch, so the reported state cannot be
reproduced here and porting a label-only patch would create an unused parallel UI.

## Current-code evidence

- `src/components/restaurant/pos/checkout-panel.tsx:31-50` defines the complete checkout summary
  view model. A bill has totals and receipt state, but it does not contain bill lines or a selected
  bill-line value.
- `src/components/restaurant/pos/checkout-panel.tsx:715-780` renders each bill. An open bill renders
  `TenderPad` and `GuestLoyaltySection`; a settled bill renders `ReceiptView`. There is no comp
  dialog, picker, option label, or comp action in this surface.
- `src/lib/restaurant/checkout-routes.ts:641-673` constructs the server response consumed by that
  panel. It likewise returns bill-level settlement fields and no line collection from which the
  reported duplicate options could be built.
- `src/app/api/restaurant/checkout/comp/route.ts:10-31` retains the code-level comp command. It
  requires the caller to submit an exact `billLineId`, verifies the bill is in the authenticated
  device branch, and requires manager co-authorization. The command does not infer a target from a
  display label.

The current UI therefore has no ambiguous picker to change. If line comping is reintroduced into
the checkout UI later, it should be designed as a new, server-backed surface and its visible line
identity should be covered by a focused component test rather than reviving code from the PR #320
snapshot.
