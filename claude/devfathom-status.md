# DevFathom delivery status

Last refreshed: 2026-08-30 07:52 PKT (UTC+05:00)

This is a concise evidence ledger, not a delivery chronology. It supersedes the old hundreds-of-issue chronology by recording only the present baseline, evidence, gaps, and gates. Amend it at phase gates; do not expand it into chronology.

## Source of truth

- Canonical observed restaurant/v1 baseline: `27b4e51165428e00248edc12d1b6e175f31933a6`.
- Private integration branch in this local repository/worktree: `WHA-842-compose-the-actual-restaurant-candidate-union-on-a-private-integration-branch`.
- Current observed private-union head for this ledger: `35d73fa6aa689b256b1308056d32d5172fea931b`.
- Local `main` was observed at `5c4b48cfc208a7bf321ce9e42de7a2f8f67e1ab6`; it is not the restaurant delivery base.
- No local `staging` or `production` ref was observed. Deployment state is not independently verified.
- No push, merge, or deploy was performed or authorized.

Useful tracked references: [restaurant administrator guide](../docs/product/restaurant-administrator-guide.md), [restaurant tax/checkout/settlement spec](../docs/specs/restaurant-tax-checkout-settlement.md), [QA guide](../docs/qa.md), and [platform testing/release guide](../docs/admin-platform/testing-release.md).

## State legend

Statuses are cumulative only when evidence establishes each state; no status implies any later state.

- **Implemented candidate:** code or documentation exists in a candidate commit; acceptance is not implied.
- **Independently reviewed:** a separate reviewer has recorded evidence against the applicable scope.
- **Locally integrated:** the accepted commit is an ancestor of the observed private union.
- **Gate-green:** the required release checks passed on the same SHA in the required environment.
- **Browser-verified:** real-browser evidence exists for the stated user journey on that SHA.
- **Deployed:** an authorized deployment of that exact SHA is independently evidenced.

## Restaurant module ledger

The observed private union visibly contains broad implementation across these surfaces. The table does not claim browser verification or deployment.

| Surface              | User-visible status                                                                  | Current gap                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| POS/KDS              | Broad POS and kitchen workflows are present, including friendlier operator controls. | Finish Restaurant E2E and same-SHA browser evidence.                                                            |
| catalog/menu/OCR     | Catalog, menu, modifiers, and OCR/import flows are present.                          | Finish Restaurant E2E and provider-backed OCR evidence where applicable.                                        |
| floor/orders         | Floor and order workflows are present.                                               | WHA-866 remaining floor selectors; WHA-867 refund/hydration review.                                             |
| money/payments/tax   | Checkout, payments, tax, and settlement surfaces are present.                        | WHA-864 custom Pakistan tax; WHA-867 refund/hydration review; Restaurant Finance SPEC/AUDIT pending assignment. |
| inventory/purchasing | Inventory and purchasing workflows are present.                                      | Finish Restaurant E2E, reconciliation, and same-SHA browser evidence.                                           |
| staff                | Staff and authorization surfaces are present.                                        | WHA-865 staff-authorization review; WHA-866 remaining staff selectors.                                          |
| SOP                  | SOP workflows are present.                                                           | WHA-866 remaining SOP selectors; WHA-868 shared-limit resolver.                                                 |
| loyalty              | Loyalty surfaces are present.                                                        | WHA-863 guided browser enrollment.                                                                              |
| Insights             | Insights surfaces are present.                                                       | WHA-869 customizable analytics dashboard active; browser and reconciliation evidence remain.                    |
| dashboard            | Restaurant dashboard surfaces are present.                                           | WHA-869 customizable analytics dashboard active; browser verification remains.                                  |
| Reports              | Reporting surfaces are present.                                                      | Basic Reports SPEC/AUDIT pending assignment; Restaurant Finance SPEC/AUDIT pending assignment.                  |
| docs                 | Restaurant administrator and product documentation are present.                      | Keep evidence links and gate status current at phase gates.                                                     |

## Accepted commits present in the private union

These commits are ancestors of, and present in, the current observed union. Presence is local-integration evidence, not a deployment claim.

- `6776d634` — AA contrast for POS and roles.
- `0ba1badc` — tax-profile fixture provisioning.
- `fbd1dfb9` — reason shown when tax profiles are unavailable.
- `63a98c24` — friendly POS operator controls replacing raw IDs.
- `487bc038` — restaurant administrator documentation.
- `6c316e76` — documentation review corrections.
- `35d73fa6` — documentation plan-status alignment.

## Reported current lanes

Activity below is reported/current. Paperclip status alone does not establish completion.

- WHA-863 — guided browser enrollment.
- WHA-864 — custom Pakistan tax.
- WHA-865 — staff-authorization review.
- WHA-866 — remaining staff/floor/SOP selectors.
- WHA-867 — refund+hydration review.
- WHA-868 — SOP shared-limit resolver.
- WHA-869 — customizable analytics dashboard.
- Basic Reports — SPEC/AUDIT pending assignment until an identifier exists.
- Restaurant Finance — SPEC/AUDIT pending assignment until an identifier exists.

## Completed candidates awaiting acceptance/integration

The commit objects exist locally. Completion is reported; acceptance and integration remain pending.

- WHA-856 — `386e7ba869c31fa8d08cdad4aaa6a26538730328` — enforce staff branch authorization.
- WHA-859 — `7d790041f8a373f67faa3c129f3755230e55e5f3` — harden void approver probes.
- WHA-860 — `2e87a1f4b3b3e41ca7f51d5466ec5d7cd9ae505b` — stabilize hydration bootstrap.

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
- No redundant loops.
- No lane is complete from Paperclip status alone.
- No push, merge, or deploy without Saad.
- Amend this ledger at phase gates; do not turn it into chronology.
