# DEV-80 verification evidence

Ticket: https://linear.app/devfathom/issue/DEV-80

Acceptance: https://github.com/RealDevFathom/devfathom-commercial/issues/736

Reference only: https://github.com/RealDevFathom/devfathom-commercial/pull/1690

Fetched develop baseline: `37afe6d570527a893aabae8e4460751603999db8`.
The baseline records lost demand and has purchasing approval, but has no lost-demand
trigger engine, advice reader, or advice actions. This change adds that missing scope.

## Acceptance map

| Requirement                       | Implementation                                                                                                                                                                                                                    | Regression evidence                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Per-branch configurable triggers  | `src/lib/pharmacy/lost-demand-advice.ts`: `lostDemandTriggerConfigSchema`, `evaluateLostDemandTriggers`; purchasing router settings procedures                                                                                    | `lost-demand-advice.test.ts`: default/custom values, request/loss windows, strict walk-out threshold                                |
| Suggested quantity                | `suggestedOrderQuantity`: lead-time forecast + safety stock - sellable on-hand - outstanding on-order; whole packs and bonus scheme                                                                                               | `lost-demand-advice.test.ts`: formula, zero need, exhaustive minimum-paid-pack checks                                               |
| Computed advice                   | `lost-demand-advice-reader.ts`: recorded prices, schemes, lead times, salt/strength alternates and donor surplus                                                                                                                  | Reader tests for actual facts, expired/quarantined/reserved stock, adjusted losses, distinct visits, bounded history, branch grants |
| Draft PO only                     | `pharmacy-purchasing.ts`: `createPurchaseOrder` validates advice terms before creating a DRAFT and logs the decision in its transaction                                                                                           | `pharmacy-purchasing.lost-demand.test.ts`: no approval/send write; altered quantities, price, conversion, discount and tax rejected |
| Draft transfer only               | `requestLostDemandTransfer`: source/destination authorization, server quantity, sellable FEFO lots, explicit DRAFT                                                                                                                | Router tests: no movement/approval, cold-chain/recall eligibility, source access                                                    |
| Transfer request approval         | `allocateRequestedTransfer`: a source-branch member turns the DRAFT into ALLOCATED (conditional flip); `approveTransfer` then needs a second person, or a solo owner's fresh PIN with a `pharmacy.transferSoloApproval` audit row | `pharmacy-inventory.transfer-request.test.ts`; `transfer-card.test.tsx`                                                             |
| Human approval and solo owner     | Existing `approvePurchaseOrder`, `verifyPurchaseApprover`, solo-owner policy and approval audit retained                                                                                                                          | Existing purchasing authorization, purchasing and purchase-approval suites                                                          |
| Configurable triggers in the UI   | Trigger settings form on the purchasing orders page (`saveLostDemandTriggers` → `setLostDemandTriggerSettings`, approval permission)                                                                                              | `lost-demand-advice.test.tsx`, `lost-demand-actions.test.ts`                                                                        |
| No auto-send or medicine outreach | Advice actions are draft/ignore only; no WhatsApp payload or sender introduced                                                                                                                                                    | Advice panel offers no approve/send control; existing message safeguards retained                                                   |
| Tenant settings and audit         | `20261117090600_pharmacy_lost_demand_advice`: transaction, idempotent DDL, ENABLE/FORCE RLS, value checks, append-only decisions                                                                                                  | Isolated in-memory PostgreSQL-compatible migration validation; repository migration ordering checks                                 |

## Negative controls

- Existing baseline: 4 focused files, 422 tests passed before implementation.
- New acceptance files on the baseline: all 4 fail collection because the required
  implementation modules are absent. This is an absence check, not a behavioral pass.
- With the historical reference implementation: 10 behavioral tests fail (six
  modified PO terms, distinct walk-out visits, adjusted loss, partial visits, donor
  branch restrictions). They pass with the current changes.

## Remaining gates

- A DRAFT transfer request continues only through people: a member at the source
  branch allocates it in Stock transfers, then a colleague approves it (or a solo owner
  approves their own allocation with a fresh PIN, audited) before dispatch. No advice
  action allocates, approves, dispatches or moves stock.
- Live authenticated visual QA at 375/768/1024/1440 widths, both themes, reduced motion,
  keyboard and loading/error states remains a release gate. Component render tests
  alone do not establish that matrix.
- Full PostgreSQL deployment/integration and hardware acceptance are not performed.
- This is automated verification, not human QA sign-off. No production services,
  deployment, customer data, or issue completion is involved.
