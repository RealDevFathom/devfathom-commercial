# DevFathom delivery status

Last refreshed: 2026-08-30 08:12 PKT (UTC+05:00)

This is the concise evidence ledger, not a delivery chronology. Amend it at phase gates; do not infer completion from Paperclip status alone.

## Source of truth

- Canonical observed restaurant/v1 baseline: `27b4e51165428e00248edc12d1b6e175f31933a6`.
- Private integration branch: `WHA-842-compose-the-actual-restaurant-candidate-union-on-a-private-integration-branch`.
- Current observed private-union head: `1402d70045a2e84c2c98c5e825bd8ec2c44ec2ad`.
- Local `main` was observed at `5c4b48cfc208a7bf321ce9e42de7a2f8f67e1ab6`; it is not the Restaurant delivery base.
- No local `staging` or `production` ref was observed. Deployment state is not independently verified.
- No push, merge, or deploy was performed or authorized.

Tracked references: [restaurant administrator guide](../docs/product/restaurant-administrator-guide.md), [restaurant tax/checkout/settlement spec](../docs/specs/restaurant-tax-checkout-settlement.md), [QA guide](../docs/qa.md), and [platform testing/release guide](../docs/admin-platform/testing-release.md).

## State legend

- **Implemented candidate:** code or documentation exists; acceptance is not implied.
- **Independently reviewed:** separate review evidence exists for the applicable scope.
- **Locally integrated:** the accepted commit is an ancestor of the observed private union.
- **Gate-green:** required release checks passed on the same SHA in the required environment.
- **Browser-verified:** real-browser evidence exists for the stated journey and SHA.
- **Deployed:** an authorized deployment of the exact SHA is independently evidenced.

## Restaurant module ledger

Broad implementation is visible across these surfaces. Presence does not establish browser verification, gate-green status, or deployment.

| Surface              | User-visible status                                                                      | Current gap                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| POS/KDS              | Broad POS and kitchen workflows are present, including friendly operator controls.       | Finish Restaurant E2E and same-SHA browser evidence.                                            |
| catalog/menu/OCR     | Catalog, menu, modifiers, and OCR/import flows are present.                              | Finish Restaurant E2E and provider-backed OCR evidence where applicable.                        |
| floor/orders         | Floor and order workflows are present; refund/void is locally integrated via `5be4b523`. | WHA-866 selectors; finish same-SHA Restaurant E2E.                                              |
| money/payments/tax   | Checkout, payments, tax, and settlement surfaces are present.                            | WHA-864 custom Pakistan tax; WHA-874 finance authorization/discovery.                           |
| inventory/purchasing | Inventory and purchasing workflows are present.                                          | Finish Restaurant E2E, reconciliation, and same-SHA browser evidence.                           |
| staff                | Staff and authorization surfaces are present.                                            | WHA-865 review; WHA-866 selectors; WHA-871 bounded authorization amendment.                     |
| SOP                  | SOP workflows are present; WHA-868 is independently reviewed and locally integrated.     | WHA-866 selectors; finish same-SHA Restaurant E2E.                                              |
| loyalty              | Loyalty surfaces are present.                                                            | WHA-863 candidate blocked on disposable authenticated browser fixtures.                         |
| Insights             | Insights surfaces are present.                                                           | WHA-869 customizable analytics dashboard is active; reconciliation and browser evidence remain. |
| dashboard            | Restaurant dashboard surfaces are present.                                               | WHA-869 is active; browser verification remains.                                                |
| Reports              | Related reporting surfaces exist, but the unified Basic Reports module is missing.       | WHA-873 Basic Reports is active; unified-module acceptance remains.                             |
| docs                 | Restaurant administrator and product documentation are present.                          | Keep evidence links and gate status current at phase gates.                                     |

## Accepted private-union commits

Presence below is local-integration evidence, not deployment evidence.

- `6776d634` — AA contrast for POS and roles.
- `0ba1badc` / `fbd1dfb9` — tax fixture and unavailable reason.
- `63a98c24` — friendly POS operator controls.
- `487bc038` / `6c316e76` / `35d73fa6` — Restaurant documentation and review corrections.
- `5be4b523` — refund/void candidate locally integrated; WHA-867 review is finished.
- `da4e31d7` + `6d7b9381` — WHA-868 independently reviewed and locally integrated; exact reviewed relevant tree.
- `dc7f89a6` + `1402d700` — WHA-872 independently reviewed and locally integrated; browser proof remains.

## Current lanes and bounded blockers

Activity is reported/current unless stronger evidence is stated.

- WHA-863 — candidate `fcc69df` exists; blocked on disposable authenticated browser fixtures.
- WHA-864 — unblocked and in progress with a 45-migration restricted test DB.
- WHA-865 — staff-authorization review.
- WHA-866 — remaining staff/floor/SOP selectors.
- WHA-869 — customizable analytics dashboard active.
- WHA-871 — blocked in independent review for device-branch credential authorization; back in one bounded amendment and not integrated.
- WHA-873 — Basic Reports active; unified module currently missing.
- WHA-874 — Restaurant Finance authorization/discovery active; current finance is fragmented and misnamed, neither absent nor complete.

WHA-867 review is finished and is not an active lane. WHA-868 and WHA-872 are independently reviewed and locally integrated as recorded above.

## Completed candidates awaiting acceptance/integration

The commit objects exist locally. Completion is reported; acceptance and integration remain pending.

- WHA-856 — `386e7ba869c31fa8d08cdad4aaa6a26538730328` — enforce staff branch authorization.
- WHA-859 — `7d790041f8a373f67faa3c129f3755230e55e5f3` — harden void approver probes.
- WHA-860 — `2e87a1f4b3b3e41ca7f51d5466ec5d7cd9ae505b` — stabilize hydration bootstrap.

## Next-phase audit findings

These are findings, not implementation or acceptance claims.

- **SuperAdmin P0:** platform-page read RBAC/navigation; vertical-aware Restaurant departments; disposable onboarding-to-tenant browser E2E.
- **Agency:** broad implementation exists, but the full browser workflow is missing; Email and external-provider acceptance remain pending; make a separate unified Reports decision.

## Required sequence

1. Finish Restaurant E2E.
2. Then finish SuperAdmin/control-plane E2E.
3. Then finish Agency every-module E2E.

## Release blockers and owner-authority gate

- Prove the release from a fresh scratch database.
- Use distinct migration-owner and runtime roles; both must be `NOSUPERUSER` and `NOBYPASSRLS`.
- Run standalone Next.js under the runtime role.
- Produce same-SHA security, tenant-isolation, branch-isolation, reconciliation, build, and real-browser evidence.
- External live providers and Pakistan production tax require the relevant owner, provider, legal, and accounting authority.
- Saad alone authorizes push, merge, or deploy.

## Operating constraints

- Codex-only Paperclip execution.
- One writer per surface plus one independent review.
- One bounded amendment when review requires correction; no redundant loops.
- No secrets or transcript chronology.
- No push, merge, or deploy without Saad.
- Amend this ledger at phase gates; keep it concise.
