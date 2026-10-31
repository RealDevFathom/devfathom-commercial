# PR #292 validation — 2026-10-28

Single-owner, serial implementation based on `ea39c865`. Read AGENTS.md, the full
Studio contract, and installed Next.js guides. Retrieved run 40675368598,
job 122806121622 logs and both retained artifacts through the GitHub connector.
No Azure files changed. `origin/develop` is already an ancestor; no merge,
rebase, or force push is required.

## Final checks

| Check                                              | Passed | Unexpected / skipped / did not run |
| -------------------------------------------------- | -----: | ---------------------------------- |
| Restaurant, exact CI 16-file corpus                |     70 | 0 / 0 / 0                          |
| Catering                                           |      7 | 0 / 0 / 0                          |
| Agency                                             |      8 | 0 / 0 / 0                          |
| Pharmacy, including fresh tenant first sale        |     13 | 0 / 0 / 0                          |
| Platform control plane                             |     16 | 0 / 0 / 0                          |
| POS/KDS accessibility and visual QA                |      6 | 0 / 0 / 0                          |
| Platform login browser matrix                      |     16 | 0 / 0 / 0                          |
| Affected unit regressions, 30 files                |    526 | 0 / 0 / 0                          |
| Terminal flow and recipe PostgreSQL regressions    |     11 | 0 / 0 / 0                          |
| Platform health PostgreSQL fixture and regressions |      9 | 0 / 0 / 0                          |

Lint (`bun run lint`), typecheck (`bun run typecheck`), final production build
(`bun run build`), formatting of changed files, and `git diff --check` passed.
All browser lanes used local PostgreSQL and Chromium. Runtime database roles
retain NOSUPERUSER/NOBYPASSRLS. Restaurant files use separate fresh clones.
No test count, skip, or 44px assertion was weakened.

## Studio matrix

All relevant routes cover 375, 768, 1024, and 1440 pixels, light/dark themes,
and normal/reduced motion. Existing semantic tokens and shared Studio components
are reused.

| Contract requirement                                              | Evidence                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsive layout, theme, motion, no horizontal document overflow | POS/KDS 32 screenshots; catering/enrolled POS matrix; health matrix; login 16 cases; pharmacy proposal 16 screenshots                                                               |
| Keyboard, focus, Escape                                           | POS/KDS accessibility cases; catering keyboard traversal; platform navigation/filter focus and Escape; login keyboard matrix; proposal focus assertion                              |
| Loading, empty, error, denied/revoked, disabled, active           | POS/KDS state cases; proposal component regressions; real platform and catering access-denial cases                                                                                 |
| Sensitive action confirmation and recovery                        | Receipt/refund/catering recovery cases; owner PIN tests; pharmacy confirmation produces a reviewed draft before separate publication                                                |
| Console/accessibility                                             | POS/KDS console and axe checks; platform health page errors and navigation checks; login browser console/axe checks; proposal scoped axe and zero observed first-sale 4xx responses |
| Product-family geometry and typography                            | Representative mobile POS, desktop KDS, and mobile proposal screenshots visually inspected; health and catering use the same Studio shell                                           |

The 44px POS controls retain their steppers. Mobile content scrolls vertically;
the toolbar wraps. KDS unlock reaches the accessible Kitchen floor heading.

## Correctness and safety evidence

- Seeded administrators have administrator scope; operators receive the explicit
  kitchen capability. The fixture manifest verifies 203 owned rows and zero leaks.
- Menu extraction fixtures work only in the admitted fixture environment;
  production rejects that adapter. The image-import lifecycle passes.
- Recipe graph cycles are checked before independent yield/conversion validation,
  including direct and indirect null-yield regressions.
- Sole-owner approval requires a freshly verified PIN in the authenticated
  actor/device request scope, effective approval permission, and exactly one
  active staff owner. Wrong PIN, identity/device mismatch, multiple staff, and
  explicit denial fail closed. The PostgreSQL test verifies same-actor approval,
  terminal-session attribution, and OWNER_PIN_REAUTHENTICATION audit evidence.
- Pharmacy first sale creates and reviews catalogue data, authorizes a supplier,
  refuses creator self-approval, obtains colleague approval, posts stock,
  completes all twelve gates, activates, takes payment, and renders a receipt.
  Standalone receiving packs retain their exact frozen conversion at sale;
  mismatches are refused and no strip is invented.
- PostgreSQL medicine-search grants match the existing production runtime-role
  preparation. Catering explicitly uses its trusted loopback CIDR configuration.
- `landing=1`, dashboard page props, counter scan cleanup, and bills `compLine`
  behavior remain preserved; the corresponding full lanes pass.

## Evidence locations and limits

Local JSON reports: `/tmp/pr292-restaurant-final.json`, `/tmp/pr292-catering.json`,
`/tmp/pr292-agency.json`, `/tmp/pr292-pharmacy.json`, `/tmp/pr292-platform.json`,
`/tmp/pr292-focus.json`, `/tmp/pr292-units.json`, `/tmp/pr292-dbunits.json`, and
`gate/vitest-platform-login.json`. Screenshots are retained under
`/tmp/pr292-visual`, `playwright-artifacts`, and the catering acceptance output.
Generated reports/screenshots are local evidence, not committed binary assets.

The pharmacy CI journey uses explicitly synthetic jurisdiction/licensing evidence
restricted to a disposable loopback database and origins. It does not attest to
real licensing, external email delivery, printer hardware, or deployed services.
Remote CI must run against the pushed commit; these are local production-build
and PostgreSQL results.
