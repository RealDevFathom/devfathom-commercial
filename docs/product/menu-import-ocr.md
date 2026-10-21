# Menu import/OCR PRD

Operator workflow: [Restaurant administrator guide](restaurant-administrator-guide.md#5-import-with-ocr-reviewcorrect-then-publish-manually).

## Problem

Restaurant teams need to upload an existing menu, extract structured candidates, review every uncertain value, and commit only approved rows into the canonical catalog. The database acceptance flow is `tests/restaurant-menu-import-acceptance.db.test.ts`.

## Users and roles

- A restaurant-admin with `menu:import` reviews and commits candidates; authorization denies by default and grants through an organization role, verified by `denies menu:import by default and grants it only through an organization role` in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- A platform-admin can grant the commercial restaurant-menu module but cannot review tenant menu content; entitlement gating is tested by `gates the import surface on the restaurant-menu module entitlement` in `tests/restaurant-menu-import-acceptance.db.test.ts`.

## Current behaviour

- Upload validates type, size, page count, deduplicates the same draft, stores the source, and queues asynchronous extraction. See `refuses an unsupported file, a mislabelled one, an empty one and an over-page PDF` and `resumes one draft when the same file is uploaded twice` in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- Extraction normalizes OCR/vision output into page-preserving candidates, flags ambiguous currency, duplicates, low legibility, and injection-like text, then creates no catalog rows before review. See `src/lib/restaurant/menu-extraction.ts`, `src/lib/restaurant/menu-extraction.test.ts`, and `extracts asynchronously into a review queue, creating no catalog rows` in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- The review console preserves extracted and corrected values and forces every row to accept/reject/merge before import. See `src/components/restaurant/menu-import/menu-import-console.tsx`, `keeps the extracted value alongside the reviewer’s correction`, and `refuses to import while any line is still undecided` in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- Commit transactionally creates catalog products, a DRAFT menu, and DRAFT price version or merges an existing product; replay creates nothing new. See `imports confirmed rows into catalog, a DRAFT menu and a DRAFT price version`, `merges into an existing product instead of duplicating it`, and `is idempotent on commit: a replay creates nothing and reports the same evidence` in `tests/restaurant-menu-import-acceptance.db.test.ts`.

### After import: review and publish

1. Open Restaurant → Catalog and inspect every imported product; complete categories, variants,
   modifier groups/options, allergens, ingredients, and recipe/BOM data as applicable.
2. Open Restaurant → Menus, select the imported draft, and complete its sections and items.
3. Create and activate the required price version, then preview the effective menu for the intended
   branch, channel, daypart, and date.
4. Create the branch publication and publish only after the preview is correct. This handoff
   requires `menu:price` and `menu:publish`; OCR commit itself never publishes.
5. If the preview is missing an item or price, return to Catalog/Menus and correct the draft or
   version. Do not publish incomplete OCR output or invent a value unsupported by the source.

## Data model

Import/upload, extracted candidate/decision, and commit-evidence models are defined in `prisma/schema.prisma`; upload storage and validation are in `src/lib/restaurant/menu-import-uploads.ts`, extraction in `src/lib/restaurant/menu-extraction.ts`, and catalog commit in `src/lib/restaurant/menu-import.ts`.

## API surface

The restaurant-admin API is `src/server/routers/restaurant-menu-import.ts`; page/console entry points are `src/app/(app)/restaurant/menu-import/page.tsx` and `src/components/restaurant/menu-import/menu-import-console.tsx`. Extraction adapter boundaries are `src/lib/restaurant/menu-extraction-vision.ts` and `src/lib/restaurant/menu-extraction.ts`.

## Edge cases and failure modes

- Unsupported/mislabelled/empty/oversized/over-page sources fail before extraction; database constraints repeat size/page ceilings. See exact tests in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- Injection payloads remain inert flagged text; prices without evidence cannot be invented. See `persists an injection payload as inert text with a flag` and `refuses to accept a line the menu gave no price, rather than inventing one` in `tests/restaurant-menu-import-acceptance.db.test.ts`.
- Commit rolls back as a unit, deletes decided source files, and retention purges abandoned drafts idempotently. See `rolls the whole import back when any step fails`, `deletes the uploaded file on commit`, and `purges drafts abandoned past the retention window, and is safe to run twice` in `tests/restaurant-menu-import-acceptance.db.test.ts`.

## Gaps

- A production OCR vendor SLA, human transcription service, and accuracy benchmark corpus: **NOT IMPLEMENTED**; current adapters/fixtures are in `src/lib/restaurant/menu-extraction-vision.ts` and `src/lib/restaurant/menu-extraction-fixtures.ts`.
- Automatic publication of imported menus: **NOT IMPLEMENTED**; accepted imports deliberately produce DRAFT catalog artifacts per `tests/restaurant-menu-import-acceptance.db.test.ts`.
