# GitHub issue #403: already fixed

Issue #403 was verified against the current code and is already fixed:

- `src/app/(app)/pharmacy/inventory/page.tsx:385-390` discards the caught value and builds the redirect from `pharmacyActionErrorMessage('inventory')`, so an exception's `Error.message` cannot enter the user-visible URL.
- `src/app/(app)/pharmacy/finance/page.tsx:253-260` preserves Next.js control-flow errors with `unstable_rethrow` and otherwise redirects with `pharmacyActionErrorMessage('finance')` rather than the caught error text.
- `src/lib/pharmacy/action-error-message.ts:1-10` limits both pages to fixed, user-safe failure copy.
- `src/lib/pharmacy/action-error-message.test.ts:5-33` covers both fixed messages and verifies that the helper does not inspect or stringify a hostile thrown value.

No implementation change is needed.
