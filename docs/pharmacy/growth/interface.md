# Shared growth interface v1 — coordinator/restaurant handoff

Base: 376d918bd5a7906009cdd2d034bf037a9891a0f8. Exclusive shared owner: WHA-1622.

`src/lib/ai/growth-recommendations.ts` exports `growthInputSchema`, `growthFactSchema`, `growthActionSchema`, `growthOutputSchema`, `GrowthInput`, `GrowthOutput`, `GrowthResult`, `generateGrowthRecommendations(input)`, `prepareGrowthInput`, `validateGrowthOutput`, `presentGrowthRecommendation`, and code-owned definition dictionaries.

Input: vertical PHARMACY|RESTAURANT, current/comparison {from,cutoff} UTC ISO exclusive-end periods, currency enum, facts [{ref:e1…e999, metric:key from GROWTH_METRICS, value:decimal string, period:CURRENT|COMPARISON, cohortSize, coverage:COMPLETE|PARTIAL|ESTIMATED, freshAt}], actions [{ref:a1…a999, kind:RETAIL_REVIEW|LOYALTY_REVIEW|CATERING_REVIEW|INVENTORY_COST_REVIEW}]. No arbitrary source prose, database IDs or free-text constraint strings. Suppress cohorts under ten before invocation. Restaurant facts include catering quote/confirmed/fulfilled counts/headcounts/capacity/estimated margin; quotes/deposits are explicitly not settled sales.

Output: at most three ranked {evidenceRefs,actionRef,hypothesis,limitations}. Hypothesis/limitation tokens have code-owned text. Free-text narrative deliberately excluded: stricter than a keyword filter, prevents invented numbers, clinical advice or executable instructions. Model still selects/ranks hypotheses using actual aggregate evidence. Missing provider returns UNAVAILABLE, sparse input INSUFFICIENT_DATA, malformed output INVALID. No deterministic AI fallback. Values and mandatory observational/cost-unknown limitations attached by server.

Adapter responsibilities: authenticate current tenant/branch/role/package before evidence construction and again before review; retain scope/source links privately; persist full result and sanitized snapshot; server action refs map to fixed vertical actions. Pharmacy maps RETAIL_REVIEW to existing createMarketingDraft, never delivery approval. Restaurant uses its own adapter/tables and must not alias pharmacy tables.

Proposed persistence shape for central composition: generic append-only growth insight (org, vertical, branch, actor, version, input hash, period/evidence snapshot, provider/model, status/failure, output, createdAt) and pharmacy review/lineage records (insight+recommendation, decision, edited draft settings, campaign id, actor/time). Explicit org/optional branch RLS without platform-admin bypass; immutable source and final decision; unique final decision per recommendation. No root/schema composition edits. The isolated SQL migration will be supplied with implementation; composer owns final Prisma mapping/composition.

Availability checkpoint: current process AI_PROVIDER/AI_MODEL absent; configured=false. No private env files, credential stores, login, network model call, or repairs. Real model acceptance is blocked on already-authorized configured provider availability. Doubles prove contracts only.

## October 7 stable interface extension

`INVENTORY_COST_REVIEW` maps only to `REVIEW_INVENTORY_COST`. At least one referenced fact must be `recipe_cost_coverage_count`, `wastage_minor`, or `inventory_value_minor`. Opens inventory wastage/valuation and recipe-cost coverage review; never changes stock or prices. Restaurant retains its opaque action-ref mapping privately. Pharmacy schema still rejects every action except `RETAIL_REVIEW`. No restaurant product files changed. Exact current shared source hashes are in `source-manifest.json` beside this document.

Pharmacy adapter now suppresses money unless every customer-linked numbered receipt has all sale lines posted through cutoff, matching gross revenue, discount, exact allocated lot COGS, allocation units, and required return entries. Anonymous receipts are excluded explicitly in the metric definition. Current-consent audience counts are computed against each period's receipt population, not asserted as historical permission. Latest MARKETING/WHATSAPP consent, current active flag and WhatsApp opt-in are required. Counts below ten distinct customers never cross the provider boundary.

Live Meta facts use the existing marketing report. Delivery cohorts count distinct delivered customers; attributed-money cohorts count distinct linked receipt customers, not campaign recipients. All stored links must verify in the report and linked receipts must have full Finance coverage. Attribution remains PARTIAL/observational, with unknown message cost. The date-based marketing report is used only for exact UTC-midnight periods; sub-day periods omit marketing outcome facts rather than silently widening the cutoff.

`src/lib/pharmacy/growth-evidence.ts` exports `readGrowthSandboxDiagnostic(db, scope, insightId, cutoff)` for the admitted synthetic DB55625 acceptance harness. It verifies the actual connection's database/port as well as the dedicated test environment, follows saved approval/campaign/capture/attempt/event lineage, chooses bound sandbox deliveries, excludes conflicting evidence, and reconciles exact receipt Finance amounts. Returns `environment: TEST_SANDBOX`, method `SYNTHETIC_SANDBOX_RECEIPT_FINANCE_V1`, observational=true, unknown message cost, and internal receipt/campaign/capture references. It never writes production attribution or contributes facts to the model. The operational source events and Finance rows are persisted; the diagnostic is computed, not a second attribution engine/table. It is not exposed as a production router endpoint.

Approval replay requires identical saved name/template/schedule; conflicting retries fail. SDK `NoObjectGeneratedError` is INVALID/OUTPUT with no raw payload retained. Router tests cover current owner/branch/licence/lifecycle revocation, including after model latency.

Model availability remains **UNAVAILABLE**: AI_PROVIDER and AI_MODEL are absent in this process. No provider/model identity or real-model receipt is asserted. Provider doubles and synthetic Meta namespace fixtures are explicitly test evidence only. Coordinator must supply approved runtime model configuration before actual-model acceptance. WHA-1618 owns central composition and coordinated authenticated browser/build/typecheck admission.

## WHA-1622 bounded parser correction — October 7

Public exports, schemas and `GrowthResult` remain unchanged. Generation now permits
one initial attempt plus at most one repair, only for local schema failures or
SDK `NoObjectGeneratedError` with `finishReason: 'stop'` and an explicit
`JSONParseError` or `TypeValidationError` cause. Message/raw-text inference is never
used. Response completion metadata is checked before accessing the output getter.
Non-stop or absent completion metadata (including truncation and unknown reasons)
is terminal INVALID/OUTPUT, even for valid-looking output. Semantic unknown
references/actions, duplicate recommendations/evidence, mismatched hypotheses and
missing inventory evidence are terminal INVALID/OUTPUT with no repair. Each call sets `maxRetries: 0`. Both attempts
share one 15-second deadline and abort signal; a promise race bounds waiting even
when an injected generation promise ignores cancellation. Expiry returns
UNAVAILABLE/TIMEOUT; exhausted invalid output returns INVALID/OUTPUT. Configuration
and transport failures are not retried. Sparse suppression and all existing
validation restrictions remain unchanged.

Repair resubmits only prepared input, code-owned definitions/constraints and fixed
validation guidance. No previous model output, exception text or validation details
enter its prompt. No fallback recommendation is fabricated.

[Parser correction receipt](parser-correction-receipt.md) records the current source
hashes and narrow verification, superseding the generator/test hashes in the prior
manifest for this uncommitted correction only. Prior availability statements above
are historical; this invocation did not inspect runtime configuration or call a
real provider. Central composition and real-model evidence remain unaccepted.
