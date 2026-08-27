# Customers, loyalty, and insights

## Requirement

- **IMPLEMENTED** — Customer identity, interactions, consent/privacy records, loyalty programs/accounts/append-only ledger, liability corrections, and operational insight reports have back-office surfaces. Evidence: [`src/server/routers/restaurant-customers.ts`](../../../src/server/routers/restaurant-customers.ts), [`src/server/routers/restaurant-loyalty.ts`](../../../src/server/routers/restaurant-loyalty.ts), [`src/server/routers/restaurant-insights.ts`](../../../src/server/routers/restaurant-insights.ts).

## Acceptance and boundary

- Replay does not duplicate material interaction/consent effects; loyalty liability corrections remain traceable; ordinary insights exclude labour/payroll fields. Evidence: [`tests/restaurant-m8-acceptance.test.ts`](../../../tests/restaurant-m8-acceptance.test.ts), [`tests/restaurant-m8-governance.test.ts`](../../../tests/restaurant-m8-governance.test.ts).
- **PLANNED (Lane D)** — Broader Restaurant dashboard. Current M8 operational insights are not that dashboard.
