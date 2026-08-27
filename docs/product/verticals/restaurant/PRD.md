# Restaurant vertical PRD

## User outcome

Restaurant operators manage menu-to-close workflows across branches while tenant isolation, permissions, terminal trust, and append-only operational evidence protect control points.

## Implemented scope and acceptance

- **IMPLEMENTED** — Vertical activation creates compatible restaurant branches, assignments, and role templates. Accept when activation preflight rejects incompatible setup and seeded roles remain organization-scoped. Evidence: [`prisma/migrations/20260818130000_organization_vertical_foundation/migration.sql`](../../../../prisma/migrations/20260818130000_organization_vertical_foundation/migration.sql), [`tests/vertical-foundation.test.ts`](../../../../tests/vertical-foundation.test.ts).
- **IMPLEMENTED** — M2–M8 provide staff/device trust, catalog/menu publishing, floor/order/KDS, checkout/cash, inventory/purchasing, SOP, and customers/loyalty/insights. Accept against milestone acceptance and governance suites. Evidence: [`docs/restaurant/architecture.md`](../../../restaurant/architecture.md), [`tests/restaurant-m4-acceptance.test.ts`](../../../../tests/restaurant-m4-acceptance.test.ts), [`tests/restaurant-m8-governance.test.ts`](../../../../tests/restaurant-m8-governance.test.ts).
- **IMPLEMENTED** — Back-office routes and terminal-specific POS/KDS routes are separate surfaces. Evidence: [`src/app/(app)/restaurant`](../../../../src/app/%28app%29/restaurant), [`src/app/(terminal)/pos/page.tsx`](../../../../src/app/%28terminal%29/pos/page.tsx), [`src/app/(terminal)/kds/page.tsx`](../../../../src/app/%28terminal%29/kds/page.tsx).

## Explicit product boundaries

- **IMPLEMENTED** — `CARD` means operator-confirmed tender recording, not acquirer confirmation. Receipt numbering/data exists; physical printing does not. Evidence: [`src/app/api/restaurant/checkout/tender/route.ts`](../../../../src/app/api/restaurant/checkout/tender/route.ts), [`tests/restaurant-m5-acceptance.test.ts`](../../../../tests/restaurant-m5-acceptance.test.ts).
- **PLANNED (Lane D)** — Broader Restaurant dashboard. Current insight reports do not satisfy it.
- **PLANNED** — OCR import remains unintegrated separate-commit work (`45c53177ec4946f8625160a8d5a70438eab17e4f`, `8dce5caf2dfa4f8fc7f2ff42996e1a04299cf6c9`).
- **PLANNED (WHA-212)** — Camera live feed/storage, named vendor presets, both-console wizard, manual ONVIF/RTSP fallback.
- **PLANNED (WHA-243 owner decision)** — Card-terminal adapter after owner acquirer choice; online gateways **DEFERRED**; print bridge; staff shifts; deeper SOP scoring/reports.
