# Growth G9 blocked — 2026-10-21

G9 is not implemented. Hard stops from `/workspace/ai-growth-plan.md` apply:
required reused customer-note storage is absent, required G2/G3/G5/G7 growth
implementations are absent, and the full build fails in the untouched G1 schema.
Do not merge as a completed refill-reminder feature.

## Dependency evidence in this worktree

- `src/lib/growth/` contains only `flag.ts`, `flag.test.ts`, and `index.ts`.
  G2 `metrics.ts` / `refill.ts`, G3 `whatsapp/provider.ts`, `evolution.ts`,
  `queue.ts`, G5 `segments.ts` / `campaigns.ts`, and G7 `winback.ts` do not exist.
- `src/server/routers/growth.ts` exports an empty router.
  `src/app/api/growth/tick/route.ts` authenticates the cron and logs enabled
  organizations; it runs no metrics, campaigns, queue, or win-back jobs.
- Draft `CustomerMetrics.nextRefillDueAt` exists at schema line 15255, but
  `prevBand`, `GrowthSettings.lastMetricsRunAt`, and `lastPlanRunAt` are absent.
  No migration for `customer_metrics` or seeded `refill_reminder` was found.
- `PharmacyCustomer` (schema lines 1100–1134) has no plain text note field or
  `CustomerNote` relation. There is no `CustomerNote` model. The required `1` /
  `haan` reservation reply cannot reuse customer-note storage as specified.
- Existing `src/lib/pharmacy/refill-support.ts` and
  `src/lib/pharmacy/whatsapp/refill-reminders.ts` implement clinical capture and
  consent-based template reminders. These are existing workflows, not the
  missing G2/G3/G5/G7 growth contracts; they were inspected and left intact.

## Reuse and isolation findings

- Tenant key: `organizationId` on `Organization`; authenticated tRPC context
  derives it from organization/session (`src/server/trpc.ts:51`) and uses
  `createTenantDb`. Keep session-derived scope for user actions, and existing
  tenant-scoped DB helpers for scheduler work; never accept a client tenant ID.
- Retail identity: `PharmacyCustomer`; full phone and date of birth live on
  linked `PharmacyPatient.phone` / `dateOfBirth`. Existing consent fields are
  `whatsappOptIn`, `whatsappOptInAt`, `whatsappOptOutAt`, and
  `whatsappOptInChangedAt`; do not grant consent implicitly for refill replies.
- Product: `Medicine.productName` / `rx`; clinical refill captures already have
  directions, quantity, and exhaustion dates. No `isChronic` / `dailyDose` field
  was found. Do not create a second clinical scheduling model.
- Sales: `PharmacySale.discountCode`; existing sale discounts remain unchanged.
- Settings: `GrowthSettings` is a draft; feature gating already uses
  `OrganizationModule` entitlements via `resolveOrganizationEntitlements` /
  `hasModule` in `src/lib/growth/flag.ts`.
- AI client: existing `src/lib/ai/provider.ts` with `createGroq` and provider
  selection. G9 needs no AI call.
- Messaging: reuse `PharmacyMessageLog` and existing provider/dedupe semantics
  once prerequisite growth integrations exist. No parallel queue or provider.
- Existing clinical refill capture migration
  `20260904198000_pharmacy_refill_support` enables and forces RLS. No schema,
  migration, tenancy, consent, provider, or runtime code was changed here.
- Any eventual G9 implementation must be pharmacy utility only: no drug/Rx
  promotion, discount, or stock reservation logic. Retain clinical consent gates.

## Required checks

Installed Next.js route-handler guide was read in full:
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
No UI work was planned or changed; visual QA does not apply.

- `bun run build`: FAIL (exit 1), before Next compilation, Prisma P1012 at
  `prisma/schema.prisma:15257`. The composite one-to-one relation on
  `CustomerMetrics.customer` lacks `@@unique([organizationId, customerId])`.
  Same failure as the user-reported initial install; no retry or G1 repair.
- `bun run test src/lib/growth/flag.test.ts`: FAIL (exit 1), no tests executed;
  Vitest/jsdom worker initialization fails with
  `TypeError: webidl.util.markAsUncloneable is not a function` in undici.
- `bun run test`: FAIL (exit 1), 17 failed / 23 passed / 8 skipped files;
  24 failed / 373 passed / 63 skipped tests; 755 errors, including the same
  jsdom/undici worker failure. No retries or dependency repairs after repetition.
- `bun run typecheck`: FAIL (exit 2), missing generated Prisma client
  (`prisma/backfill-attendance-log.ts:12`, `prisma/bootstrap.ts:2`, and other
  existing files), plus cascading type errors; 4,101 log lines. No retry.
- `bun run lint`: PASS (exit 0), four existing warnings in
  `src/components/platform/platform-command-form.tsx` and
  `src/components/restaurant/growth/growth-review-panel.test.tsx`.
- `git diff --check`: PASS.
- G9 due/not-due/20-day-cooldown and reservation-reply fixtures: blocked by
  absent implementation/reused note storage; no substitute tests invented.
- Manual live WhatsApp: SKIPPED. No configured, authorized demo recipient was
  established, and prerequisites/build are blocked. No messages were sent.
- Migration/demo DB, FORCE RLS runtime checks: not run; no migration changes.

## Required upstream work

G1 owner must resolve its schema validation, create the tenant-isolated migration
with ENABLE/FORCE RLS and composite foreign keys, generate the client, and seed
safe templates. Land G2/G3/G5/G7 dependencies and establish reusable customer-note
storage upstream before resuming G9. Restore the test environment and resolve
baseline checks in their owning scope. Do not rebuild these packages in G9.

## Delivery status

The earlier read-only Git metadata and GitHub DNS errors occurred in the prior
sandboxed session. This unrestricted delivery session successfully read the
GitHub remote; those earlier errors are not current delivery blockers.

Delivery is limited to a focused `BLOCKED.md` commit on
`improve/ai-growth-g9` and a blocker-audit PR targeting `improve/ai-growth-g1`.
The final commit SHA and PR URL are recorded in the delivery response. Only this
report changes; no runtime code, schema, migrations, or other branches change.
The prior G1 section below is preserved verbatim. Existing check results were
read from `/tmp/g9-checks/*.log` and `*.exit`; no checks were rerun for delivery.

G9 remains blocked by the prerequisites and check failures documented above.
The PR delivers the completed blocker audit, not an implemented feature.
Do not merge as a completed refill-reminder feature.

## Prior G1 blocker (preserved)

# Growth G1 blocked — 2026-10-21

Stopped under the explicit instruction to stop when the same problem fails twice.
`prisma format` and `prisma migrate diff` both reported P1012: CustomerMetrics has
an organization-scoped one-to-one customer relation but lacks the explicit
`@@unique([organizationId, customerId])` required by Prisma. No fix attempts or
further validation were run after recognizing the repeated failure.

## Partial work

- Added draft growth schema models and PharmacyCustomer consent fields,
  PharmacySale.discountCode, and extensions to the existing PharmacyMessageLog.
- Schema is NOT valid. No migration was produced, no database was changed,
  and seed implementation is pending. Do not merge this branch.
- Prisma format also reformatted existing schema alignment; review/minimize that
  incidental diff when resuming.

## Repository findings

- Tenant: Organization / organizationId.
- Retail customer: PharmacyCustomer; full phone and dateOfBirth are on its
  organization-scoped PharmacyPatient relation. Reuse dateOfBirth, not a duplicate
  birthday. Existing nullable whatsappOptIn and whatsappOptInChangedAt must retain
  their audit semantics. Backfill only valid full Pakistani mobile numbers from
  the linked patient; never derive from phoneLast4 or grant consent.
- Sale: PharmacySale, pharmacy_sales; discountCode was absent.
- Settings/flag: OrganizationModule entitlements; growth_ai already uses
  resolveOrganizationEntitlements / hasModule. No new flag system needed.
- AI: src/lib/ai/provider.ts, createGroq / existing provider abstraction.
- WhatsApp: existing PharmacyMessageLog and Meta/mock providers in
  src/lib/pharmacy/whatsapp. No production Prisma cast stub was found in growth
  or WhatsApp files inspected. Preserve existing providerMessageId/dedupeKey
  behavior when adding the required organizationId,direction,waMessageId key.
- No nested AGENTS.md found under prisma or src. Read root AGENTS.md, both
  /workspace plans, and installed Next installation documentation. No UI work.

## Remaining G1 work

Repair the relation; generate one migration with ENABLE and FORCE RLS and
organization isolation policies for every new table; ensure composite tenant
foreign keys; safe phone backfill and false defaults without data loss; seed
GrowthSettings and eight safe templates for existing demo pharmacies only.
No medicine/drug/Rx promotions; refill messages must remain utility only.
Generate Prisma and validate migration on fresh and demo databases and seed.
Run relevant/full tests, typecheck, lint and build. No install was repeated.

## Validation limitations

Prisma format and schema diff failed with the same P1012 relation error.
Generation, migration application, seed, typecheck, tests, lint and build were
not run after the mandatory stop. No DATABASE_URL or SHADOW_DATABASE_URL was
present in the shell environment; no local postgres/psql/docker executable was
found. Database validation would require an available isolated database.
