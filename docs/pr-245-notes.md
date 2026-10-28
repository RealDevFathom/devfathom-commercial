# PR #245 review notes

## Scope reviewed

The branch was reviewed against its merge base (`2f6ce748`) because this checkout has no
configured `origin` remote. The review covered every repair migration, the forced-RLS database
fixture, and the existing migration-sweep evidence. Per the task instructions, dependencies were
not installed and tests were not run.

## Findings and resolutions

- **Merge blocker — blanket pharmacy capability rewriting.** Two late additions rewrote every
  `pharmacy.*` grant to a colon-delimited spelling. Dot-delimited capabilities such as
  `pharmacy.counter`, `pharmacy.inventory`, and `pharmacy.finance` are canonical, exact grants in
  the application catalog. Rewriting them would revoke intended access, manufacture unrecognised
  grants, and collapse an ALLOW/DENY pair into a different authorization decision. Both the
  blanket migration and its replay were removed. The narrow
  `pharmacy:catalogue-review` migration remains an intentional no-op so a repair cannot resurrect
  an administrator-revoked grant. This preserves exact-grant-only authorization and existing
  DENY-over-ALLOW decisions.
- **Tenant isolation — delivery replay breadth.** The pending-delivery repair previously iterated
  every organization before setting tenant-local RLS scope. It now selects only restaurant
  organizations, while the update continues to bind both the RLS setting and row predicate to the
  same organization id.
- **Money invariant coverage.** The database fixture now gives the legacy pending fulfillment a
  non-zero `deliveryFeeSnapshot` and asserts that the repair clears only the invalid pending
  `paymentMode`; the snapshotted money remains exactly unchanged across initial repair and replay.
- **Preserved conservative behavior.** The review retained the no-op MFA and pharmacy-reference
  repairs, preservation of NULL-reason module pins, no-fill behavior for partially assigned
  pharmacy organizations, explicit department-key conflict handling, nested webhook-secret
  removal, and transaction-local platform scope.

## Verification status

Only source review and whitespace validation were performed. No test, typecheck, migration deploy,
dependency installation, or database command was run, as requested.
