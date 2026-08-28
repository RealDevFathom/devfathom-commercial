# Catalog, menus, and publications

## Requirement

- **IMPLEMENTED** — Users manage products, variants, modifiers, ingredients, recipe versions, effective-dated prices, menus, branch publications, availability, and overrides. Evidence: [`src/server/routers/restaurant-catalog.ts`](../../../src/server/routers/restaurant-catalog.ts), [`src/server/routers/restaurant-menus.ts`](../../../src/server/routers/restaurant-menus.ts), [`prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql`](../../../prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql).

## Acceptance and boundary

- Published effective menus resolve by branch/date without crossing tenant ownership. Evidence: [`tests/restaurant-m3-acceptance.test.ts`](../../../tests/restaurant-m3-acceptance.test.ts), [`tests/restaurant-m3-governance.test.ts`](../../../tests/restaurant-m3-governance.test.ts).
- **IMPLEMENTED** — OCR-assisted upload, extraction, review, and draft catalog import are documented canonically in [menu import and OCR PRD](../menu-import-ocr.md).
