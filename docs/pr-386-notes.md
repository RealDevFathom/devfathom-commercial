# PR #386 review notes

## Scope

PR #386 fixes QA issue #355 by requiring the canonical `pharmacy:safety` capability for the two
recall workflow mutations that previously required only an authenticated user:
`pharmacyInventory.acknowledgeRecall` and `pharmacyInventory.closeRecall`.

The requested `git fetch origin main` and `git diff origin/main...HEAD` could not be performed
because this checkout has no Git remote or `origin/main` ref. The available PR commit was reviewed
against its first parent (`9194795`) instead.

## Findings and resolution

- **Authorization gap (fixed by the PR):** both recall mutations now use the existing
  `capabilityProcedure('pharmacy:safety')` procedure. This keeps authentication, module licensing,
  audit coverage, and the central ABAC decision in one middleware chain.
- **Fail-before-lookup coverage (strengthened):** the router test now proves a denied safety
  decision occurs before resolving a caller-supplied branch and before opening the close-recall
  transaction. This prevents unauthorized callers from using either mutation to probe tenant
  references or reach a write path.
- **Tenant isolation:** the acknowledgement continues to derive its organization and actor from
  the session and validates the requested active branch within that organization. Closing a recall
  continues to pass the session-derived organization and actor into the operation, whose notice
  lookup is organization-scoped.
- **DENY-over-ALLOW and exact grants:** no local authorization logic was introduced. Both mutations
  delegate to the shared ABAC engine through `capabilityProcedure`, preserving its explicit DENY
  precedence and canonical capability matching behavior. The regression test pins the exact
  `pharmacy:safety` action requested by the router.
- **Pharmacy caps and money invariants:** this change neither evaluates pharmacy plan caps nor
  accepts, computes, or persists money. No cap or monetary invariant is changed.
- **Merge blockers:** no additional code issue was found within this narrowly scoped change. The PR
  remains intentionally marked **HOLD - do not merge** as requested.

## Verification

Per the review instruction, dependencies were not installed and tests were not run. Review was
limited to static inspection of the available first-parent diff and the authorization, tenant-scope,
and recall-operation call paths it reaches.
