# Menu import and OCR PRD

## Problem

Restaurant admins need to turn existing menu images/PDFs into editable catalog drafts without treating untrusted extraction as authoritative or silently inventing missing values.

## Users and roles

- **Restaurant admin/import reviewer:** requires the `menu:import` capability and `restaurant-menu` entitlement to upload, review every candidate, commit, or discard. Evidence: [`src/server/routers/restaurant-menu-import.ts`](../../src/server/routers/restaurant-menu-import.ts), [`src/server/routers/restaurant-menu-import.test.ts`](../../src/server/routers/restaurant-menu-import.test.ts) — `registers menu:import as a real capability gated on the menu module`.
- **Platform admin:** can control module entitlement/configuration but does not review tenant menu text. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`src/lib/platform/auth.ts`](../../src/lib/platform/auth.ts).

## Current behaviour

- Upload validates bytes rather than trusting MIME declarations, supports the formats enumerated by the upload validator, caps bytes/PDF pages, hashes content, stores the source temporarily, creates a draft, and enqueues asynchronous extraction. Identical uploads resume one draft. Evidence: [`src/lib/restaurant/menu-import-uploads.ts`](../../src/lib/restaurant/menu-import-uploads.ts), [`src/lib/restaurant/menu-import.ts`](../../src/lib/restaurant/menu-import.ts), [`src/lib/restaurant/menu-import-uploads.test.ts`](../../src/lib/restaurant/menu-import-uploads.test.ts) — `believes the bytes over the declared type` and `gives identical bytes an identical checksum, which is what makes a re-upload idempotent`.
- FIXTURE and VISION adapters normalize into pages/lines with confidence, warnings, variants/modifiers, currency parsing, duplicate matching, and injection flags. Missing/unreadable prices remain null. Evidence: [`src/lib/restaurant/menu-extraction.ts`](../../src/lib/restaurant/menu-extraction.ts), [`src/lib/restaurant/menu-extraction-vision.ts`](../../src/lib/restaurant/menu-extraction-vision.ts), [`src/lib/restaurant/menu-extraction.test.ts`](../../src/lib/restaurant/menu-extraction.test.ts) — `returns null for an unreadable price rather than an estimate` and `flags the injected line, keeps its text verbatim, and leaves prices intact`.
- Extraction creates only a review queue. Review preserves extracted values beside corrections and requires ACCEPTED, REJECTED, or MERGED decisions. Commit is transactional and creates/merges confirmed catalog rows plus a DRAFT menu and DRAFT price-list version; it never directly publishes a live menu. Evidence: [`src/lib/restaurant/menu-import.ts`](../../src/lib/restaurant/menu-import.ts), [`tests/restaurant-menu-import-acceptance.db.test.ts`](../../tests/restaurant-menu-import-acceptance.db.test.ts) — `extracts asynchronously into a review queue, creating no catalog rows` and `imports confirmed rows into catalog, a DRAFT menu and a DRAFT price version`.
- Commit/discard deletes source bytes while retaining review/audit evidence; stale drafts purge after the configured 14-day TTL. Audit payloads contain IDs/counts, not extracted menu text. Evidence: [`src/lib/restaurant/menu-import.ts`](../../src/lib/restaurant/menu-import.ts), [`tests/restaurant-menu-import-acceptance.db.test.ts`](../../tests/restaurant-menu-import-acceptance.db.test.ts) — `deletes the uploaded file on commit`, `purges drafts abandoned past the retention window, and is safe to run twice`, and `never lets extracted menu text into the recorded commit evidence`.

## Data model

`RestaurantMenuImport`, page, and line models store lifecycle, adapter/version, checksum/idempotency, source retention, immutable extracted fields, reviewed overrides/decision, merge targets, and IDs-only commit evidence. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`tests/restaurant-menu-import-acceptance.db.test.ts`](../../tests/restaurant-menu-import-acceptance.db.test.ts) — `forces row level security on every menu-import table`.

## API surface

The `restaurantMenuImport` tRPC router exposes `uploadLimits`, `list`, `get`, `summary`, `upload`, `reviewLine`, `commit`, and `discard`; the tenant page is `/restaurant/menu-import`. Evidence: [`src/server/routers/restaurant-menu-import.ts`](../../src/server/routers/restaurant-menu-import.ts), [`src/app/(app)/restaurant/menu-import/page.tsx`](../../src/app/%28app%29/restaurant/menu-import/page.tsx).

## Edge cases and failure modes

- Unsupported/mislabelled/empty/oversize/over-page files, malformed base64, cross-tenant merge targets, undecided lines, missing accepted price, all-rejected import, wrong lifecycle state, extraction retry, and commit rollback are explicit. Evidence: [`tests/restaurant-menu-import-acceptance.db.test.ts`](../../tests/restaurant-menu-import-acceptance.db.test.ts) — `refuses to import while any line is still undecided`, `rolls the whole import back when any step fails`, and `is idempotent on commit: a replay creates nothing and reports the same evidence`.
- Prompt injection is retained as inert data and flagged; provider output is bounded and normalized. Evidence: [`src/lib/restaurant/menu-extraction.test.ts`](../../src/lib/restaurant/menu-extraction.test.ts) — `normalization is applied to every adapter, not just trusted ones`.

## Gaps

- **NOT IMPLEMENTED:** automatic publication/activation after import; the result remains draft.
- **NOT IMPLEMENTED:** claims of perfect OCR accuracy, handwriting support, arbitrary file formats, or reviewer-free import.
- **PARTIAL:** VISION integration code exists, but production provider credentials/deployment are environment concerns not proved by repository tests. Evidence: [`src/lib/restaurant/menu-extraction-vision.ts`](../../src/lib/restaurant/menu-extraction-vision.ts).
