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

# Growth G10 blocked — 2026-10-21

Branch: improve/ai-growth-g10, based on improve/ai-growth-g1 at
97e9d2c426918b799df8f5a45ca4a56859f61db3. No G10 runtime or schema changes made.

## Mandatory stop

`bun install` (required because node_modules was missing) failed in postinstall
Prisma generation with the inherited CustomerMetrics composite one-to-one
P1012 error at prisma/schema.prisma:15257. `bun run build` independently failed
on that same error before Next compilation. This is the second occurrence in
this session; stop without fixing G1 or retrying per user instruction and plan.

The required reusable G5 campaign code redemption and G8 template editor are
also absent. src/server/routers/growth.ts is an empty router; src/lib/growth/
contains only flag.ts, flag.test.ts and index.ts. There is no growth consent,
queue, campaign engine, templates renderer or growth settings editor to extend.
Draft GrowthSettings, Campaign, CampaignRecipient and MessageTemplate models
exist only in the invalid G1 schema with no G1 migration or seed implementation.
Implementing operational G10 would require building other work packages, which
is explicitly out of scope. The plan's required-reuse stop condition applies.

## Discovery and intended integration points

- Tenant: Organization / organizationId; scope from session.user.organizationId.
  Future migrations must preserve composite tenant foreign keys and FORCE RLS.
- Customer: PharmacyCustomer; linked PharmacyPatient owns full phone/dateOfBirth.
- Sale: PharmacySale; draft discountCode exists; existing checkout discountMinor
  and discountKind fields are in src/server/routers/pharmacy-sales.ts.
- Settings: draft GrowthSettings; feature gating reuses OrganizationModule
  entitlements via resolveOrganizationEntitlements / hasModule.
- AI: src/lib/ai/provider.ts; existing Groq provider abstraction.
- Messaging: PharmacyMessageLog and src/lib/pharmacy/whatsapp already exist;
  growth-specific campaign queue/rendering/redemption are absent.

Read root AGENTS.md, /workspace/ai-growth-plan.md and installed Next route
handler documentation. No UI work was undertaken, so design/visual QA is not
applicable. No medicine promotions, live sends, database changes or migration
were introduced. G10 review timing/caps, first-sale referral redemption, once-only
referrer reward and template editor rendering remain unimplemented.

## Checks

- bun install: FAILED, inherited Prisma P1012 during postinstall.
- bun run build: FAILED, same inherited P1012 before Next compilation.
- bun run test -- src/lib/growth/flag.test.ts src/app/api/growth/tick/route.test.ts:
  FAILED overall; 15 tests passed, but a Vitest worker could not start because
  webidl.util.markAsUncloneable is not a function (jsdom/undici runtime).
- Full suite, migration validation and manual review/referral checks: skipped
  after mandatory stop. No G8 editor exists to exercise message previews.
- bun run typecheck: FAILED (exit 2); 4,101 log lines, including missing
  @/generated/prisma/client and cascading implicit-any/unknown errors. Prisma
  generation could not complete on this base; no fixes attempted.
- bun run lint: PASSED (exit 0), four existing warnings, zero errors.
- git diff --check: PASSED.
