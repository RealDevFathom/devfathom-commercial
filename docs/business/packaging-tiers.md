# Packaging and tiers

## Implemented entitlement mechanics

- **IMPLEMENTED** — Active catalog, package defaults, live contracts, organization overrides, limits, seats, dates, and lifecycle state produce effective entitlements. Precedence is organization override, live contract, package default, then disabled. Evidence: [`docs/admin-platform/entitlements.md`](../admin-platform/entitlements.md), [`src/lib/module-catalog.ts`](../../src/lib/module-catalog.ts), [`tests/production-bootstrap.test.ts`](../../tests/production-bootstrap.test.ts).
- **IMPLEMENTED** — Restaurant catalog contains provisional package/module metadata and vertical compatibility guards. Metadata does not prove approved commercial packaging. Evidence: [`src/lib/vertical-catalog.ts`](../../src/lib/vertical-catalog.ts), [`tests/vertical-foundation.test.ts`](../../tests/vertical-foundation.test.ts).

## Proposed normal versus enterprise mapping

| Entitlement area | Normal offer | Enterprise offer | Decision state |
| --- | --- | --- | --- |
| Restaurant core and selected operational modules | Package defaults plus contracted modules | Contracted modules plus organization exceptions | **PLANNED OWNER APPROVAL (WHA-243 owner decision)** |
| Seats and usage limits | Shared standard limits | Negotiated limits | **PLANNED OWNER APPROVAL (WHA-243 owner decision)** |
| Environment | Shared tenant topology | Dedicated environment option | **PLANNED; DELIVERY GATED (WHA-243 owner decision)** |
| Identity/domain | Standard tenant access | SSO/SCIM/custom domain option | **PLANNED COMMERCIAL MAPPING (WHA-243 owner decision); implementation is partial/deployment-specific** |
| Support/SLA | Standard support policy | Named support/SLA schedule | **PLANNED OWNER APPROVAL (WHA-243 owner decision)** |
| Data retention/export | Standard policy | Contract schedule | **PLANNED OWNER/LEGAL APPROVAL (WHA-243 owner decision)** |

No tier names, module bundles, limits, prices, response times, or enterprise promises are approved here.
