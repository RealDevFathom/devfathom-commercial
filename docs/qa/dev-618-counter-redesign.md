# DEV-618 counter redesign QA

## Reference and scope

Visual source: `origin/design/counter-screens-mockups`, commit `9f842989ce0d48eb168fb872f5a0ab9d229813d4`, `docs/design/counter-screens/01`–`08` pharmacy PNGs. Read-only extracted references and decoded Claude HTML bundles: `/tmp/dev618-counter-references/`. Payment (06) and receipt (08) PNGs contain the dimmed background without their dialogs; decoded HTML supplied overlay geometry/content. Studio semantic tokens/shared controls remain authoritative for product-wide styling. Reference artifacts were not copied into this branch.

## Blocker coverage

1. **Next line:** inline medicine/form/batch/expiry/rack, sale unit, quantity, units/prices/total, F6, covered stock and actual FEFO/allocation behavior; deduplicated rack code.
2. **Cart:** five-column medicine/unit/batch/amount table, real Rx/FEFO/near-expiry metadata and notes, responsive rows; padded idle/loading/error/empty states while retaining full-width populated tables.
3. **Bill rail:** gross/discount/tendered/balance and Pay, with Hold F7/Resume F8/Void below; desktop, phone and F9 use the same payment handler and existing payment guards.
4. **Console and panels:** inline search and Actions, checks/payment/receipt overlays, actual safety and receipt states, persistent tender drafts; fixed visible drawer header with scrolling content and existing Rx/scan focus behavior.
5. **Authentication:** pharmacy mockup composition and labels applied to existing sign-in/registration. Registration still submits for review/invitation; no fake password field, password provisioning, new authentication or permission loosening.
6. **Behavior and types:** focused interactions cover next-line quantities, branch/actions/Shortcuts, keyboard/payment paths and exactly-once receipt F10 printing; four pre-existing fixture type corrections retained.
7. **Header and copy:** visible branch name/code, permission-driven module navigation, bill/drawer status, short phone chips with accessible full labels, exact safety-note/loyalty copy, Studio icons and semantic control geometry.
8. **Phone and visual QA:** payment-bar clearance, added feedback, overlay focus/geometry and control radius corrections, including the conditional Capture prescription anchor; frozen-source fixture evidence below.

## Final verification

Commands ran sequentially with `PATH=$HOME/devfathom-qa/bun/bin:$PATH` and `NODE_OPTIONS=--max-old-space-size=12288` after final source formatting.

| Command                                   | Exit | Result                                          | Local log                                                                                            |
| ----------------------------------------- | ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bunx tsc --noEmit`                       | 0    | Zero errors                                     | `/tmp/dev618-final-tsc.log`                                                                          |
| `bunx vitest run src/components/pharmacy` | 0    | 29 files, 410 tests passed                      | `/tmp/dev618-final-pharmacy-vitest.log`                                                              |
| `bun run build`                           | 0    | 233/233 pages generated                         | `/tmp/dev618-final-build.log`                                                                        |
| Scoped ESLint                             | 0    | Changed UI files clean; final Rx file rechecked | `/tmp/dev618-integrated-eslint.log`, `/tmp/dev618-portal-eslint.log`, `/tmp/dev618-final-eslint.log` |
| Prettier check                            | 0    | All 19 changed UI files formatted before freeze | `/tmp/dev618-final-prettier.log`                                                                     |
| `git diff --check`                        | 0    | No whitespace errors                            | `/tmp/dev618-final-diff-check.log`                                                                   |

The build used a cryptographically random `AUTH_SECRET` only in its child-process environment. It was neither printed nor persisted; the production guard is unchanged. Two existing dynamic-filesystem tracing warnings remain in `src/lib/storage.ts:22` and `:43`.

## Accepted browser evidence

Coordinator handoff: `/tmp/dev618-browser-final-ready.json`; counter details: `/tmp/dev618-counter-browser-qa/evidence/final-capture-2026-11-03T01-36-38.715Z/final-handoff.json`. Final browser reports were checked against the checkout: **30 distinct source/test/style paths match SHA-256 exactly**, including all 19 frozen UI files; no whitespace exceptions. Counter aggregate: `f62a990054e0560348c03e5954faf3548617d912e3ec9001db41979c6d0eaa1f`. Freeze marker: `/tmp/dev618-portal-source-ready.txt` at `2026-11-03T01:34:34.839857+00:00`.

| Surface                                                               | Accepted cases                  | Screenshots | Named checks                         | Evidence                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Counter matrix (375/768/1024/1440, light/dark, normal/reduced motion) | 64                              | 256         | 820                                  | `/tmp/dev618-counter-browser-qa/evidence/final-capture-2026-11-03T01-36-38.715Z/report.json`                  |
| Counter loading/error/empty/disabled/destructive states               | 20                              | 40          | 152                                  | `/tmp/dev618-counter-browser-qa/evidence/targeted-final-2026-11-03T01-38-38.612Z/accepted-report.json`        |
| Conditional Capture prescription anchor                               | 4                               | 4           | 16                                   | `/tmp/dev618-counter-browser-qa/evidence/conditional-final-2026-11-03T01-35-48.994Z/report.json`              |
| Receipt supplementary captures                                        | 4                               | 4           | Bounds/focus and manual review       | `/tmp/dev618-counter-browser-qa/evidence/final-capture-2026-11-03T01-36-38.715Z/receipt-visual-followup.json` |
| Pharmacy auth                                                         | 32 matrix + 6 additional states | 52          | Reported state/overflow/focus checks | `/tmp/dev618-auth-browser-qa/report.json`                                                                     |

Counter primary total: **88 cases, 300 screenshots, 988 named checks**, plus four receipt followups. The browser coordinator reviewed 44 requested counter screenshots; the root coordinator separately accepted desktop cart, phone checks, phone receipt at original resolution, dark desktop receipt, registration and dark phone sign-in. No console/page/external-network errors were reported. All owned fixture servers were stopped.

Evidence qualifications are preserved: the raw targeted report recorded eight failures because it measured the padded paragraph's outer box; a separate live text Range proof verified 16px text inset, yielding the accepted 20/20 report without changing product code or deleting raw evidence. See `/tmp/dev618-counter-browser-qa/evidence/targeted-final-2026-11-03T01-38-38.612Z/report.json` and `/tmp/dev618-counter-browser-qa/evidence/targeted-final-2026-11-03T01-38-38.612Z/padding-proof.json`. Original matrix receipt PNGs show an unexplained header raster anomaly; fresh direct/keyboard diagnostics and four separately named receipt captures passed bounds/focus and manual visual review. The originals remain available; this is not a claim that their anomaly was explained.

## Limits and unchanged baseline

These are isolated fixture/browser and local build/test results. No live database, actual sale/payment/refund, production authentication provisioning, printer, scanner, drawer or other hardware acceptance is claimed. Browser evidence is local under `/tmp` and is not a deployment artifact.

The coordinator independently reproduced the unrelated inventory-router failure at untouched HEAD: `bunx vitest run src/server/routers/pharmacy-inventory.test.ts -t 'refuses regulatory stock through inventory-only'` yielded 1 pass, 1 fail, 74 skipped; expected `INSUFFICIENT_STOCK`, received `COAUTH_REQUIRED`. Permission ordering and server gates were not changed to silence it.

No dependency, global palette, Azure, deployment or unrelated legacy Returns redesign changes. Generated-only `AGENTS.md` changes were restored; the final file matches HEAD. Codebase Memory was refreshed without persistence before the final class-only corrections; no graph artifact is included.
