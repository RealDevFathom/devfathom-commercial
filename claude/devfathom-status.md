# DevFathom delivery status

Last refreshed: 2026-08-30 09:34 PKT (UTC+05:00)

Concise evidence ledger, not delivery chronology. Paperclip status alone does not prove completion.

## Source of truth

- Canonical observed Restaurant/v1 baseline: `27b4e51165428e00248edc12d1b6e175f31933a6`.
- Private integration branch: `WHA-842-compose-the-actual-restaurant-candidate-union-on-a-private-integration-branch`.
- Observed clean private integration head: `2828bb1e430a232a73bd48cb9817f4f8f4e614ae`.
- Local `main` observed at `5c4b48cfc208a7bf321ce9e42de7a2f8f67e1ab6`; not Restaurant delivery base.
- No local `staging` or `production` ref observed. Deployment state is not independently verified.
- This refresh makes no push, shared-ref merge, deploy, or live-release claim. Restaurant remains incomplete.

References: [restaurant administrator guide](../docs/product/restaurant-administrator-guide.md), [tax/checkout/settlement spec](../docs/specs/restaurant-tax-checkout-settlement.md), [QA guide](../docs/qa.md), [platform testing/release guide](../docs/admin-platform/testing-release.md).

## State legend

- **Committed candidate:** commit exists; acceptance is not implied.
- **Independently accepted:** separate acceptance evidence exists for stated scope.
- **Privately integrated:** accepted commit is an ancestor of observed private integration head.
- **Browser-verified:** real-browser evidence exists for stated journey and SHA.
- **Deployed/live:** authorized release of exact SHA is independently evidenced.

## Restaurant module ledger

Implementation presence does not prove browser verification, release readiness, or deployment.

| Surface              | Evidence state                                                                                      | Remaining gap                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| POS/KDS              | Broad POS and kitchen workflows present; guided enrollment privately integrated through `c137a191`. | Browser enrollment, PIN, KDS, revoke, and no-secret proof pending. |
| catalog/menu/OCR     | Catalog, menu, modifiers, and OCR/import flows present.                                             | Restaurant E2E and applicable provider-backed OCR proof pending.   |
| floor/orders         | Floor/order workflows present; refund/void privately integrated via `5be4b523`.                     | Same-SHA Restaurant browser proof pending.                         |
| money/payments/tax   | Tax integrated via `c94b0b91`; cash/day close via `a9555e0b` + `0663b465` after independent READY.  | Browser publish and other-branch proof pending.                    |
| Restaurant Finance   | Privately integrated as `1b80ef4c`; focused checks `156/156`, zero skip.                            | Browser role/branch/Agency regression pending.                     |
| inventory/purchasing | Inventory and purchasing workflows present.                                                         | Reconciliation and same-SHA browser proof pending.                 |
| staff                | Entitlement, hydration, staff selectors, and branch-device security are privately integrated.       | Same-SHA Restaurant browser proof pending.                         |
| SOP                  | WHA-868 independently accepted and privately integrated via `da4e31d7` + `6d7b9381`.                | Same-SHA Restaurant browser proof pending.                         |
| loyalty              | Loyalty surfaces and guided device enrollment candidate present.                                    | Enrollment browser journeys remain pending.                        |
| Insights/dashboard   | Dashboard privately integrated via `1d97e65f`.                                                      | Reconciliation and browser proof pending.                          |
| Reports              | Privately integrated via `d79c8057` + `be91a7d9` + `ef18995d` + `2828bb1e` after independent READY. | Same-SHA Restaurant browser proof pending.                         |
| docs                 | Product, QA, and release references maintained.                                                     | Refresh evidence at phase gates.                                   |

## Concise integration evidence

- Dashboard: `1d97e65fed7890be18f8533df8aaf9da816ce4e1` privately integrated.
- SOP entitlement and review: WHA-868, `da4e31d771efa0feb4fd57f8abf0213642e942ac` + `6d7b93818279edd9e1db0f19dd2a8d111df1b3fe`, independently accepted and privately integrated.
- Hydration: WHA-872, `dc7f89a65c64d53495364dd7e5ee9067dd144b86` + `1402d70045a2e84c2c98c5e825bd8ec2c44ec2ad`, independently accepted and privately integrated; browser proof pending.
- Staff selectors and authorization: `fa157c476eea6ea7c513005409d6e351705f15cd`, `62e38c17bfbde32dbf16609cb89fabf1f02e91a6`, `ef5a50014bd37a123e7ebbff9a2ff682c36a348e`, and branch-device security `ef5a87a8099bc6f98793ff25b6d3775c425057a3` privately integrated.
- Tax: WHA-864, `c94b0b91a61ea4ee5769c672fd74055e88ef9b9d` privately integrated; restricted combined `116/116`; browser publish/other-branch pending.
- Guided enrollment: WHA-863, integrated through `c137a191eee82fb75645e9afd91bc175b5486586`; focused `49/49` plus real-DB exact-cleanup `5/5`, zero skip; browser enrollment/PIN/KDS/revoke/no-secret pending.
- Restaurant Finance: WHA-874, integrated as `1b80ef4cfb3f5e58a656b8c5cb00a132fa84c9b7`; `156/156`, zero skip; browser role/branch/Agency regression pending.
- Cash/day close: `a9555e0b` + `0663b465` privately integrated after independent READY.
- Reports: `d79c8057` + `be91a7d9` + `ef18995d` + `2828bb1e` privately integrated after independent READY.
- Combined focused gate: 10 files, 132 tests passed; one restricted file initially skipped. Later disposable restricted-PostgreSQL cash/branch suites: 4 files, 43 passed, zero skipped. Combined `tsc`, conflict-file ESLint, and diff-check passed.

## Active lanes

- WHA-876 — service charge remains active and not integrated. Reviewed amendment `4af9b01e` fixed schema/audit/end replay, but fresh PostgreSQL found a legacy taxable-service constraint regression; the authorized micro-correction is in progress.
- WHA-879 — Restaurant browser E2E read-only preflight.
- WHA-880 — SuperAdmin read-only preflight.
- WHA-881 — Agency read-only preflight.

## Next-phase audit findings

- **SuperAdmin P0:** platform-page read RBAC/navigation; vertical-aware Restaurant departments; disposable onboarding-to-tenant browser E2E.
- **Agency:** broad implementation exists; full browser workflow, Email, and external-provider acceptance remain pending; unified Reports needs a separate decision.

## Required sequence

1. Finish Restaurant E2E; browser, build, and fresh-database gates remain.
2. Then finish SuperAdmin/control-plane E2E.
3. Then finish Agency every-module E2E.

## Release blockers and owner-authority gate

- Prove release from a fresh scratch database.
- Use distinct migration-owner and runtime roles; both `NOSUPERUSER` and `NOBYPASSRLS`.
- Run standalone Next.js under runtime role.
- Produce same-SHA security, tenant-isolation, branch-isolation, reconciliation, build, and real-browser evidence.
- External live providers and Pakistan production tax require owner, provider, legal, and accounting authority.
- Saad alone authorizes push, shared-ref merge, deploy, or live release.

## Operating constraints

- Codex-only Paperclip execution.
- One writer per surface plus one independent review.
- One bounded amendment when review requires correction; no redundant loops.
- No secrets or transcript chronology.
- Amend ledger at phase gates; keep concise.
