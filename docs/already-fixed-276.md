# GitHub issue #276: already fixed

Issue #276 reports that the draft check total is calculated for cash but displayed without a
tender label. The current code already satisfies the requested outcome:

- `quoteDraftCheckBreakdown` passes `proposedTenderType: 'CASH'` to the tax quote, so the draft
  amount is explicitly calculated using the cash tax treatment
  ([`src/lib/restaurant/draft-check-total.ts:55-61`](../src/lib/restaurant/draft-check-total.ts#L55-L61)).
- The order pad renders the caption **Cash total** immediately above that calculated amount
  ([`src/components/restaurant/pos/order-pad.tsx:462-474`](../src/components/restaurant/pos/order-pad.tsx#L462-L474)).
- The focused order-pad test asserts both the cash label and the displayed quoted amount
  ([`src/components/restaurant/pos/order-pad.test.tsx:1166-1186`](../src/components/restaurant/pos/order-pad.test.tsx#L1166-L1186)).

No implementation change is needed for this issue.
