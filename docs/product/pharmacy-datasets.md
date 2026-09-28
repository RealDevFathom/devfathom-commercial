# Pharmacy reference datasets: options and ingestion plan

Research date: 2026-09-29. Issue: WHA-1609. Documentation only; no acquisition pipeline, database change, or clinical feature implemented.

Board-authorized pharmacy base: `89f39834e7688c7f93dc467b945c980ada708463`.
Worktree: `/Users/Saad/Developer/paperclip-worktrees/devfathom/PH-DATA-datasets`; branch `PH-DATA-datasets`. This supersedes the original Restaurant release base. No Restaurant worktree was edited.

## Recommendation overview

| Dataset | Recommended first step | Release gate |
| --- | --- | --- |
| DRAP MRP and registered products | Obtain a regulator-authorized export and price-notification provenance; use reviewed manual imports initially | Written reuse scope, pack-level identity and effective-date validation |
| Interactions and contraindications | Evaluate a licensed DrugBank clinical feed under an explicit intended-use agreement; use open labels only as supporting research | Commercial rights, Pakistan ingredient coverage, clinical reviewer acceptance; no purchase authorized |
| Urdu directions | Commission original, structured templates with Urdu-language and pharmacist review | Rights assignment, semantic validation and approved version per phrase |
| Pakistani generic/brand mapping | Combine permission-scoped Healthwire catalog assertions with authorized manufacturer/regulator evidence | Healthwire agreement reference and scope; ambiguous mappings remain unresolved |

Verified means supported by a cited primary page or the inspected base source. Proposed means a design choice, not existing functionality. Unknown/guess means not verified; no cost, coverage or cadence should be inferred from it. These recommendations do not establish registration, legality, completeness, medical advice or clinical suitability.

## 1. DRAP MRP and registered products

The [DRAP price index](https://e.dra.gov.pk/public/price) exposes a paginated HTML table containing product name, registration number, manufacturer, category, pack size, price and effective date. Public access does not establish a bulk reuse licence. The page states all rights reserved. No documented export API, publication SLA or commercial reuse permission was verified. Cost: public viewing has no observed access charge; export/licensing cost is unknown, not assumed free.

The [provisional registered-product search](https://eapp.dra.gov.pk/WebProductIndex.php?view=205com) supports registration, brand and generic lookup. Its disclaimer restricts the list to stakeholders reviewing their own products and rejects broader reference uses, including research and citation. Treat it as evidence of an access/rights limitation, not as an authorized dataset for this product. Do not bulk ingest it without explicit regulator permission. DRAP remains the regulatory reference; a search hit does not independently establish current registration or lawful sale.

**Proposed ingestion:** obtain an authorized CSV/XLSX export with schema/version and scope; keep its checksum and original strings. Parse public price notices deterministically where permission permits. PDF extraction needs page coordinates and manual verification of ambiguous cells; do not infer missing pack sizes, effective dates or currency. Compare price records using registration number + exact pack + effective date + notice reference. A registration number alone is insufficient for pack pricing. Preserve old effective versions rather than overwrite them.

Catalog fields can enter the manual reference connector after review. A verified price notification can become a `DrapPriceNotice` only after resolving its pack to the intended medicine. Use integer PKR minor units and an explicit date policy; distinguish pack price from unit price. The current notice type cannot carry pack identity, so hold multi-pack cases outside the seam pending a future schema change. No observed HTML price row should automatically become a legally authoritative notice.

**Cadence:** source SLA unknown. Proposed weekly export reconciliation and an owner-approved notice check schedule; urgent notice handling needs a separately agreed process. These are operational proposals, not scheduled jobs. Prefer regulator-supplied files over scraping. Retain source title, notice number, issue/effective dates, retrieval time, digest and supersession relationship.

## 2. Drug–drug interactions and contraindications

| Option | Rights and cost | Format and updates | Assessment |
| --- | --- | --- | --- |
| [DrugBank Clinical API](https://go.drugbank.com/clinical/) / [API documentation](https://docs.drugbank.com/v1/) | Commercial licence required; quote unknown | Documented API; interaction severity, description and management. Contractual cadence/SLA unverified | Recommended vendor evaluation, not approval to acquire or use |
| [openFDA drug labels](https://open.fda.gov/apis/drug/label/) | [Generally CC0 unless noted](https://open.fda.gov/license/), subject to service terms and exceptions; no data licence fee assumed for CC0 content | JSON derived from SPL; weekly API updates | Supporting label evidence; not a validated pairwise interaction engine |
| [DailyMed](https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm) | Content redistribution terms not verified here; do not assume all label assets are unrestricted | Versioned GET API, XML/JSON metadata and SPL downloads; history/last-update information available | Alternative label retrieval; preserve label version and section |
| [DrugCentral](https://drugcentral.org/download) | [Primary licence page](https://drugcentral.org/privacy) links Creative Commons, but exact linked terms could not be retrieved; licence variant remains unverified | Dated PostgreSQL dump, TSV drug-target data and chemical identifiers; fixed cadence unknown | Research/identifier candidate, not evidence of comprehensive DDI coverage; no dump downloaded |

Drug-target interactions are not drug–drug interactions. Contraindications also include conditions, routes and patient contexts; a pairwise DDI feed alone does not satisfy that requirement. Vendor evaluation must separately verify contraindication scope and provenance without using real patient records.

[DrugBank terms](https://trust.drugbank.com/drugbank-trust-center/terms-of-use) contain restrictions on redistribution, derivative databases and safety-critical uses, with some exceptions dependent on a signed order. Obtain explicit rights for intended decision-support use, server caching, retention, customer display, derived mappings and any model/RAG use. Do not assume an academic download permits commercial use. The quoted product scope, ingredient coverage, update latency, termination/deletion obligations and price remain unknown.

[NLM confirms](https://lhncbc-portal.lhcaws-prod-pub.nlm.nih.gov/RxNav/information/FAQs.html) RxNav drug-interaction features ended on January 2, 2024. RxNorm can help normalize identifiers; it is not an available replacement DDI service. Its APIs generally do not require a licence, except the proprietary endpoint described in that FAQ. Pakistan brand coverage and bulk terminology rights need separate verification.

openFDA explicitly cautions against using its output to make medical-care decisions. Labels are US submissions, may differ from distributed/approved labeling, and do not prove Pakistan coverage. Preserve section text and source version; missing interaction/contraindication sections mean unknown, not no risk.

**Proposed ingestion:** retain provider record/version, ordered ingredient participants, interaction identifier, severity vocabulary, evidence/reference, management text and rights reference. Store contraindication concepts separately from pairwise rules, with route/context qualifiers. Quarantine unresolved ingredient mappings. No existing inspected connector field represents these rules. A future licensed adapter and dedicated reference schema are needed; never stuff clinical text into `alias`, or activate a health badge before a working rights-gated adapter exists.

**Cadence/cost recommendation:** negotiate vendor update and correction SLAs; refresh only within licence limits. Open-label prototype research is lower acquisition cost but still incurs curation costs. No monetary estimate is verified. No vendor contact, purchase or installation was performed.

## 3. Urdu dosage-direction phrase corpus

Recommend original templates commissioned under written commercial reuse/translation rights, reviewed by an Urdu linguist and a pharmacist. Define approved source meanings and placeholders before translation; do not derive phrases from prescriptions, orders, patient messages or account content. This run did not create clinically approved phrases.

[Tatoeba terms](https://tatoeba.org/en/terms_of_use) describe default text licensing as CC BY 2.0 FR and explicitly disclaim professional translation/content review. Its [downloads](https://tatoeba.org/en/downloads) list Urdu, weekly Saturday exports, and some CC0 sentences. It is a general-language candidate, not an established dosage corpus. CSV-style sentence/link exports need parsing according to their documented delimiters. Audio has separate licences and is excluded. No Urdu phrase count, medical coverage or quality was measured. Any later use must reconcile required attribution with this task’s prohibition on collecting personal data; do not collect contributor profiles or identities under this scope. Prefer the original commissioned corpus.

**Proposed format:** UTF-8 JSONL or CSV with `phraseId`, `version`, `sourceMeaning`, `urduText`, `locale`, typed placeholder definitions, allowed contexts, rights reference, approval status and non-personal review-record reference. Numeric dose/frequency/duration values come only from an approved upstream instruction; templates do not select doses. Do not silently equate “twice daily” with “every twelve hours”. Preserve negation, route, food/timing meaning and maximum-use qualifiers. Test RTL rendering, digit/unit ordering, placeholder substitution, line wrapping and printed labels separately in a later implementation task.

**Cadence:** proposed versioned releases after every approved change, plus quarterly terminology review; no provider SLA. **Cost:** reviewer/translation procurement quote unknown. An internal rights-owned corpus avoids third-party per-call licensing but does not eliminate review cost. The inspected reference seams contain no Urdu phrase representation. Keep this as a separate versioned reference package; do not import sentences into medicine aliases. No LLM-only translation should be marked reviewed.

## 4. Pakistani generic/brand mapping

Healthwire is a commercial catalog source. Its [public terms](https://healthwire.pk/terms-and-conditions) do not establish a reusable catalog licence or complete/accurate medical reference. Owner reports that permission was purchased. **Permission reference status: owner-attested purchase; agreement identifier, dates, allowed URLs/fields, rate, retention, redistribution and derived-data/AI rights not supplied or verified.** No bulk collection may start until those scope fields are recorded. This document does not reverse the owner’s purchase statement or assume unlimited rights.

Prefer a licensed export from Healthwire and authorized manufacturer product/pack files. A direct parser for allowlisted public product pages is a fallback only within the purchased scope. Formats, commercial feed API, update SLA and purchased price are unknown. Proposed refresh is weekly initially, adjusted to the agreement; this is a guess about an appropriate operating cadence, not a source promise. Manufacturer reuse terms and costs need individual confirmation. DRAP evidence, obtained within authorized scope, supplies regulatory reference; neither retailer presence nor manufacturer marketing establishes regulatory status.

**Proposed mapping:** preserve source product ID/URL, brand, manufacturer, ingredient list, salt, strength numerator/denominator and unit, dosage form, route, pack quantity/unit, registration assertion and effective observation time. Keep observed retail price separate from DRAP MRP. Normalize Unicode/whitespace and units deterministically while retaining original strings. Ingredient synonym tables must be versioned and reviewed. Do not collapse salts, modified-release forms, combination products, strengths or pack sizes. Fuzzy matches propose candidates only; unresolved or conflicting products remain separate with reasons.

Create field-level assertions, not a winner-takes-all merged row. Join exact identifiers only after checking qualifiers and provenance. International identifiers may supplement ingredient lookup but do not imply Pakistan brand equivalence. Existing `alias` can store reviewed textual aliases; it cannot represent a complete ingredient graph. Dedicated ingredient relationships and per-source rights enforcement are future work.

## Existing seams at the approved base

| File / contract | Verified behavior | Ingestion consequence |
| --- | --- | --- |
| `src/lib/pharmacy/licensed-reference-connectors.ts` | `medicineConnectorHealth()` returns only ready `manual-file` | No live DRAP, Healthwire or DDI adapter advertised |
| `src/lib/pharmacy/reference-connectors.ts` | `ManualFileConnector`, `NormalizedMedicineReferenceRow`, field assertions and rights; missing product/strength/form/pack blockers | Authorized parsed files can map supported catalog fields; raw source evidence must stay alongside the batch |
| `src/lib/pharmacy/reference-connector-automation.ts` | `MAX_CONNECTOR_ROWS_PER_CALL = 100`; digest/replay handling; direct brand/manufacturer fields; regulated proposals | Use bounded batches and existing confirmation workflow. Do not treat a schedule expression as a deployed scheduler |
| `src/lib/pharmacy/drap-monitoring.ts` | `FILE`/`MANUAL` only; JSON array parser; price and recall types; no/multiple registration matches remain unresolved | Reviewed notices only. Identical source/kind replays reuse previous ingest; changed payload conflicts. Price changes have a confirmation function |

Manual rights currently describe tenant uploads/cache and prohibit outside-tenant redistribution. They are not a substitute for upstream licences. A manual import labels assertions as `IMPORT`; preserve regulator/commercial origin in separate batch provenance rather than claiming this code already implements provider-specific rights. No database was run and these are source-inspection findings, not executed integration tests.

## Proposed acquisition and quality contract

1. Record source agreement reference/status and rights matrix before any collection. Allowlist catalog/reference paths; exclude accounts, prescriptions, orders, patients, cookies, credentials and other personal data. Never save authentication headers or cookies in fetch logs.
2. Cheapest deterministic acquisition first: authorized export, then direct parser. No Firecrawl purchase or repeated LLM page reading. Start with one request in flight and a proposed five-second minimum interval, subject to stricter source limits. Cache by URL/version and conditional headers when supported. Stop immediately on 403/429 or material distress; checkpoint and seek a revised authorized path, not proxy rotation.
3. Separate sanitized fetch metadata (`url`, status, retrieval time, content type, digest, source version, parser version, rights reference) from permitted raw content and normalized rows. Checkpoint source cursor/page, processed hashes, accepted/rejected counts and failure URL/reason. Resume from the last committed checkpoint without refetching cached pages.
4. Validate schema before mapping. Report required-field null counts/rates, parse errors, duplicate source keys, duplicate candidate identity keys, conflicting assertions, unmatched/ambiguous joins and price/pack anomalies. Missing values remain missing; never coerce unknown registration/classification to a negative value.
5. Reject exact key collisions with different payloads. Identical repeats are replay candidates, not evidence that separate products are equivalent. Keep source-specific assertions even when a mapping is approved.
6. Review an agreed stratified sample (proposal: 30 records per source or all if fewer), including combinations, multiple packs, missing fields and duplicates. Report observed sample counts and source-to-normalized comparisons; a sample does not prove nationwide completeness. Require rights and pharmacist approval before clinical-facing activation.

## Research and validation evidence

No dataset was acquired or imported. Dataset schema-valid/null/duplicate rates are **N/A**, not zero-percent claims; normalized record count is 0. No bulk/API product requests or personal-data collection. Research used 6 web tool calls: 8 search queries, 15 opens, 1 link click and 2 finds (26 requested tool operations). Search/caching backend HTTP request counts are not exposed and must not be invented. Direct source HTTP requests from local scripts: 0.

Research failures: `https://www.dra.gov.pk/therapeutic-goods/pharmaceutical-drugs/registered-drugs/` and `https://lhncbc.nlm.nih.gov/RxNav/docs/interaction/interactionAPIs.html` were inaccessible through the web tool; the Creative Commons link on `https://drugcentral.org/privacy` returned an internal error (destination not exposed in that response). No HTTP 403/429 was reported. Alternative primary references above support the registry limitation and RxNav discontinuation; the exact DrugCentral licence remains unverified.

Sample evidence, not imported records: the rendered DRAP price page showed registration `018727` in two pack rows with prices PKR 352.41 and 3,524.23 and the same displayed effective date. This demonstrates why registration-only price matching is unsafe. Arithmetic normalization would be 35,241 and 352,423 minor units, respectively; no regulatory price assertion was persisted. Connector inspection confirms `DrapPriceNotice` has no pack field and refuses multiple medicine matches. Tatoeba’s licence/cadence and NLM’s discontinued-service statement were checked against their primary pages. No clinical correctness validation was performed.

Exact key workspace commands and observed results:

- `df -h /` — exit 0, 36 GiB available before worktree creation; no installation/build needed.
- `git -C /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1388-pharmacy-union rev-parse 89f39834` — exit 0, full base SHA above.
- `git -C /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1388-pharmacy-union worktree add -b PH-DATA-datasets /Users/Saad/Developer/paperclip-worktrees/devfathom/PH-DATA-datasets 89f39834` — exit 0.
- `git status --short` in the new worktree — exit 0, clean before the document edit.
- Source-navigation correction: attempted `src/lib/pharmacy/medicine-reference-connectors.ts` did not exist (`cat` exit 1); followed the real import to `reference-connectors.ts` successfully. No missing implementation was fabricated.

Final document checks, commit SHA and uploaded evidence link are recorded in the issue handoff. Tests/build/DB checks are intentionally skipped for this docs-only change. Recovery is removal/reversion of this one document commit; no dataset or runtime state needs rollback.

## Owner decisions needed

1. Approve regulator/export rights work and define whether price notices, registry assertions or both are required. The provisional public list is not approved for ingestion.
2. Supply the purchased Healthwire agreement reference and allowed acquisition/cache/redistribution/derived-use scope. Authorize a capped pilot separately; no bulk collection is authorized by this document.
3. Choose vendor-evaluation budget and intended clinical scope for DDI/contraindications; authorize vendor contact/purchase separately and appoint a pharmacist reviewer.
4. Approve an original Urdu corpus commission, rights ownership, language variants and review budget; identify the accountable clinical reviewer without placing personal data in the dataset.
5. Accept manual-file onboarding first and separately scope missing pack-aware price, ingredient graph, clinical-rule and phrase-package schemas. Approve retention, sample size, refresh/freshness thresholds and customer-facing unknown/stale states.
6. Board review of this document and its limitations; no push, merge, deployment or acquisition follows automatically from document acceptance.
