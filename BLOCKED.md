# Growth G6 blocked — 2026-10-21

G6 cannot be implemented on the requested base without implementing earlier work
packages, which the user explicitly excludes. No G6 runtime code was added.

## Verified base and missing prerequisites

- Worktree: /workspace/wt/improve/ai-growth-g6; branch: improve/ai-growth-g6.
- HEAD and remote improve/ai-growth-g1 both resolve to
  97e9d2c426918b799df8f5a45ca4a56859f61db3 at verification time.
- G6 explicitly depends on G5. src/server/routers/growth.ts is an empty router;
  growth contains only flag.ts, index.ts and the flag test. There is no G5
  segments.ts, campaigns.ts or codes.ts, nor the G2 metrics job.
- The base already records an invalid G1 draft. No G1 growth migration exists.
  CustomerMetrics.customer at prisma/schema.prisma:15257 lacks the composite
  uniqueness required for its one-to-one relation. This is an earlier package's
  repair, not G6 work. No migration or RLS policy was changed.
- G6 settings additions (customDates, lastPlanRunAt) are absent as expected for
  unimplemented G6; adding them alone cannot supply the missing prerequisites.

The plan's stop condition applies: a required reusable foundation does not exist.
Do not merge this documentation PR as a completed AI planner. Resume G6 only on
an explicitly authorized base containing validated G1 and completed G2–G5.

## Discovered repository names

- Tenant: Organization / organizationId; scoped database access is in
  src/lib/tenancy/scoped-db.ts. Preserve tenant isolation and FORCE RLS.
- Customer: PharmacyCustomer; linked PharmacyPatient holds dateOfBirth/phone.
- Sale: PharmacySale / pharmacy_sales; draft discountCode exists; sale lines use
  PharmacySaleLine and the existing sale discount mechanism must be reused.
- Settings: GrowthSettings / growth_settings (draft); feature entitlement:
  OrganizationModule with resolveOrganizationEntitlements / hasModule.
- Campaign / campaigns, CampaignRecipient / campaign_recipients,
  CustomerMetrics / customer_metrics, MessageTemplate / message_templates are
  draft schema names, not validated deployed tables.
- Audit/channel: existing PharmacyMessageLog. AI client:
  src/lib/ai/provider.ts, createAIModel with the existing Groq provider.

## Validation

- Read AGENTS.md and the exact WP-G6 section; user waived the four named tools
  and prohibited recursive Codex. No UI or UI planning was performed.
- Read installed Next.js route-handler reference before any runtime changes;
  no runtime changes were ultimately made.
- node_modules was initially absent. Ran bun install first: failed in postinstall
  prisma generate with P1012 for the inherited CustomerMetrics relation above.
  Did not retry the known schema failure or repair earlier packages.
- bun run test -- src/lib/growth/flag.test.ts
  src/app/api/growth/tick/route.test.ts: exit 1; 15 tests passed, but one worker
  failed before collecting its tests with undici/jsdom error
  `webidl.util.markAsUncloneable is not a function`.
- Typecheck result recorded below after completion.
- Lint, build and full suite skipped after confirming the prerequisite blocker;
  build also invokes the known failing prisma generate.
- G6 canned-output, slow-day and weekly-idempotency tests: not available because
  G6 was not implemented. No test is represented as passing for G6.
- Manual real planner/demo DB run: skipped; no runnable planner or migrated
  growth foundation exists. No live model call, message, or database mutation.
- No drug/Rx/medicine promotion code or content was introduced; future refill
  behavior must remain utility only. No session-facing surface was added.

Typecheck: `bun run typecheck` exited 2. Missing generated Prisma client
(src/generated/prisma/client.js) produces repository-wide TS2307 and cascading
implicit-any/unknown errors. Generation was blocked by the inherited P1012.
