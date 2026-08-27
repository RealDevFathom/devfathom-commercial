# Pricing inputs

## Repository-backed inputs

- **IMPLEMENTED** — Commercial records can store contract value, billing interval, currency, seats, module lines/limits, invoices, payments, balances, and renewals. This is an operator ledger, not automated collection or accounting. Evidence: [`docs/admin-platform/commercial-ledger.md`](../admin-platform/commercial-ledger.md), [`docs/admin-platform/data-model.md`](../admin-platform/data-model.md).
- **IMPLEMENTED** — Entitlement enforcement can consume package, contract, organization, seat, and explicit limit inputs. Evidence: [`docs/admin-platform/entitlements.md`](../admin-platform/entitlements.md).

## Decision model

- **PLANNED OWNER DECISION** — Price metric: branch, terminal, active user, module, transaction band, or hybrid.
- **PLANNED RESEARCH INPUT** — Willingness-to-pay by restaurant format/size, current software spend, payment hardware economics, support burden, onboarding effort, cloud/media/storage cost, local taxes, reseller/acquirer margin, churn risk, and discount policy.
- **PLANNED OWNER/FINANCE DECISION** — Currency, billing frequency, implementation fee, minimum contract, overages, annual discount, tax treatment, refund/cancellation terms, and enterprise custom pricing.

Do not publish numbers until source, assumptions, margin target, approval owner, and review date are recorded.
