# Counter stock alternatives — automated verification

Issue: https://linear.app/devfathom/issue/DEV-878
GitHub: https://github.com/RealDevFathom/devfathom-commercial/issues/1924

Base: `37afe6d570527a893aabae8e4460751603999db8` (fetched `origin/develop`).
Branch: `codex/dev-878`.

## Scope and ownership

The full issue descriptions and comments were read before edits. At preflight,
Linear was Backlog, the GitHub issue was open, and no matching branch or pull
request existed. The archived substitute implementation was inspected read-only;
it was not restored. Its server-price and permission history was considered,
including https://github.com/RealDevFathom/devfathom-commercial/pull/15.

Develop already has cheaper substitute proposals after selecting a shortfall.
This change adds the missing search-time stock alternatives without changing
that existing cheaper-proposal contract. Search suggestions need no source price
and include more expensive alternatives. They never write a sale or prescription.

The active layout work at
https://github.com/RealDevFathom/devfathom-commercial/pull/1375 remains separate:
no production edits to `counter-console.tsx`, shells, navigation or tender panels.
The integration test adds an opt-in real search-results renderer to the existing
console fixture. Add-line idempotency and transfer-reference work remain with
https://linear.app/devfathom/issue/DEV-874 and
https://linear.app/devfathom/issue/DEV-875 respectively. Catalogue publication and
inventory labels remain with https://linear.app/devfathom/issue/DEV-852 and
https://linear.app/devfathom/issue/DEV-862.

## Acceptance evidence

| Requirement | Implementation | Regression evidence |
| --- | --- | --- |
| Automatically show alternatives on the first unavailable search match | `src/lib/pharmacy/counter.ts`, `searchCounterCatalog` | `counter-stock-alternatives.test.ts`: no source lot or historical price required; in-stock matches do not request suggestions |
| Ingredient SET, per-ingredient strength, dosage form | Same server function, stored strength graph only | Reordered combinations match; missing/extra/different salts do not; swapped strengths and different forms/routes go to `other`; every candidate presentation is inspected |
| Branch stock eligibility and FEFO then price | Shared `hydrateCounterRows`, existing inventory and price kernels | Expired/expiry-boundary, recalled, quarantine, damaged, unreceived, empty, unpublished, foreign tenant/branch excluded; earlier expiry precedes cheaper later stock; equal expiry sorts by pack price |
| Brand, strength, form, pack, price, quantity | `counter-search-results.tsx` reuses Studio tokens, `Button`, `StatusPill` | `counter-search-results.test.tsx`: automatic exact/other groups expose every field and retain disabled state |
| Normal add-line path, no swap | Existing `onSelect` -> stage -> explicit Add to cart | `counter-console.test.tsx`, DEV-878 block: actual component selection never auto-adds; ordinary selection sends normal scoped/idempotent add-line input; controlled selection still requires authorization; server refusal is displayed |
| Pharmacist decides for prescription/controlled products | Search alternatives panel | Visible pharmacist disclaimer and suggestion-only status asserted before selection |
| Missing ingredient explanation | Server `ingredientRecorded` and panel text | Empty ingredient lists never match; exact required missing-ingredient text is asserted |
| Permission and tenant/branch isolation | Existing `requireCounterReceiptAccess` now protects search before catalogue reads | `pharmacy-sales.counter-receipt-auth.test.ts`, DEV-878 block: assigned cashier allowed; no grant, deny override, other/unassigned/foreign branch, tenant mismatch, inactive session and disabled module refused |

Within a brand, the normal sale writer's existing FEFO/id lot tie-break remains
intact so the displayed lot price agrees with the normal counter read. Alternatives
are ordered by that safe lot's expiry and then its printed pack price. Existing
money, stock writes, tax, pricing floors, prescription and controlled-drug kernels
are unchanged. No catalogue seeds, migration or permission-action changes.

## Negative controls

The four updated test files were run with all three changed production files
replaced temporarily by the exact base versions, then restored automatically:
28 failed / 425 passed, all failures in the new DEV-878 cases. The same four
files pass with the implementation (453 tests). The failure set covers missing
automatic suggestions, ingredient/form separation, eligibility, ordering, the
missing-ingredient text, permissions, display and normal counter integration.

## Browser evidence

An isolated synthetic fixture renders the actual search-results component and
repository CSS. Automated Chromium checks passed 28 cases: 375/768/1024/1440px,
light/dark, normal/reduced motion; keyboard order, visible focus, Enter selection,
Escape without losing selection, no document horizontal overflow; and loading,
error/retry, idle, empty, missing ingredient and disabled states in both themes.
Zero render or console errors. Mobile light/dark captures were inspected.

This is automated component/browser verification, not human QA sign-off or an
authenticated end-to-end database counter run. Final-commit generation, typecheck,
full source lint, full prescribed unit suite and production build results belong
in the draft pull request. Deployment, merging and issue closure are outside scope.
