# DevFathom canonical API surface

Reconciled at `343478dbc75d9ad6863955e23cd7280d5cf0513f` for WHA-243. This is the product-wide transport map; [Restaurant API surface](../restaurant/api-surface.md) preserves route-level vertical detail.

## Tenant transports

- **IMPLEMENTED** — `/api/trpc/[trpc]` serves agency and Restaurant routers from one tenant-aware application router. Context resolves tenant/support actor; procedure middleware enforces session, role/capability, and module entitlement. Evidence: [`src/app/api/trpc/[trpc]/route.ts`](../../src/app/api/trpc/%5Btrpc%5D/route.ts), [`src/server/routers/_app.ts`](../../src/server/routers/_app.ts), [`src/server/trpc.test.ts`](../../src/server/trpc.test.ts).
- **IMPLEMENTED** — `/api/v1` provides bearer-token REST for agency resources; authentication binds token, user, organization, lifecycle, scopes, rate limit, and module access. Evidence: [`src/app/api/v1`](../../src/app/api/v1), [`src/lib/api-auth.test.ts`](../../src/lib/api-auth.test.ts), [`src/app/api/v1/meetings/rest-bounds.test.ts`](../../src/app/api/v1/meetings/rest-bounds.test.ts).
- **IMPLEMENTED (Restaurant M2–M5/M7)** — Restaurant terminal REST covers terminal trust, POS/orders, KDS, checkout/cash, and webhook intake; back-office modules use tRPC through M8. Evidence: [`src/app/api/restaurant`](../../src/app/api/restaurant), [`docs/restaurant/api-surface.md`](../restaurant/api-surface.md), [`tests/restaurant-m4-acceptance.test.ts`](../../tests/restaurant-m4-acceptance.test.ts).
- **IMPLEMENTED** — Tenant-adjacent handlers include Auth.js, shared login, SSO, SCIM, files/uploads, assistant, Ably token, and support-session launch/end. Evidence: [`src/app/api`](../../src/app/api), [`src/app/api/login/route.test.ts`](../../src/app/api/login/route.test.ts), [`src/app/api/scim/v2/Users/route.test.ts`](../../src/app/api/scim/v2/Users/route.test.ts).

## Control-plane transports

- **IMPLEMENTED** — Platform operator session/MFA, typed control commands, audited support launch, and worker processing use `/api/platform/*`; interactive routes are admin-host and platform-session/capability bound. Evidence: [`src/app/api/platform`](../../src/app/api/platform), [`src/lib/platform/commands.ts`](../../src/lib/platform/commands.ts), [`src/lib/platform/security.test.ts`](../../src/lib/platform/security.test.ts).
- **IMPLEMENTED** — `/api/platform/jobs/process` uses a bearer worker secret rather than tenant or operator cookies. Evidence: [`src/app/api/platform/jobs/process/route.ts`](../../src/app/api/platform/jobs/process/route.ts), [`src/lib/platform/jobs.ts`](../../src/lib/platform/jobs.ts), [`tests/production-deployment-contract.test.ts`](../../tests/production-deployment-contract.test.ts).

## Capability boundaries

- **IMPLEMENTED (Restaurant M5; WHA-62)** — Checkout accepts operator-confirmed `CARD` tender records; it does not confirm with a payment provider. Evidence: [`src/app/api/restaurant/checkout/tender/route.ts`](../../src/app/api/restaurant/checkout/tender/route.ts), [`tests/restaurant-m5-acceptance.test.ts`](../../tests/restaurant-m5-acceptance.test.ts).
- **PLANNED (WHA-243 supervisor boundary)** — Provider-backed automatic card confirmation and online gateways are not API capabilities. OCR remains separate-lane, not integrated. Cameras, physical printing, staff shifts, deeper SOP integrations, and real external notification delivery have no implemented API claim.
- **PLANNED (WHA-243 Lane C)** — Platform-login/onboarding expansion remains separate from current platform session/control routes.
- **PLANNED (WHA-243 Lane D)** — Broader dashboard API work remains separate from current `dashboard` and `restaurantInsights` routers.
