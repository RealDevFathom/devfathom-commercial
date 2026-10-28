# PR #376 review notes

## Scope reviewed

- Compared the available branch commit with its mainline parent. The requested
  `origin/main` fetch was not possible because this checkout has no configured
  `origin` remote.
- Reviewed the pharmacy counter reload recovery path, its server page boundary,
  and the existing counter authorization and tender recovery tests.

## Findings and fixes

- The original change correctly retained the active branch and sale in the URL,
  allowing a normal browser reload to pass them back into the counter.
- URL persistence now waits for the branch to appear in the authenticated
  account's successful branch response. Untrusted branch and sale identifiers
  are not copied into browser history before that authorization decision.
- Repeated `branchId` or `orderSaleId` query parameters now fail closed at the
  server page boundary instead of selecting an ambiguous value.
- Added regression coverage for recovered bills, idle bill cleanup, unrelated
  query-parameter preservation, unauthorized scopes, and duplicate query
  parameters.

## Invariants reviewed

- Tenant isolation remains server-authoritative; client recovery is additionally
  gated on the authorized branch list.
- Authorization remains deny-over-allow, including ambiguous URL input.
- This change does not alter pharmacy capability evaluation or broaden grants.
- This change does not modify tender amounts, totals, or other money handling.

## Validation

Per the task instruction, dependencies were not installed and tests were not
run. Static review was limited to the branch diff and `git diff --check`.
