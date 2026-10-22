# PR #172 review notes

## Scope reviewed

Reviewed the POS tax-profile fail-closed changes and their draft-check, order-detail, bill,
service-charge, and tender-settlement paths. The review also checked the touched terminal API and
UI boundaries for tenant isolation, deny-over-allow behavior, exact money arithmetic, and accidental
changes to pharmacy grant/cap enforcement.

## Findings and fixes

- **Fixed — ambiguous service-charge terms could price by precedence.** The branch terms loader used
  `findFirst`, so overlapping effective policies would silently select one even though ambiguous
  commercial terms must fail closed. It now reads at most two effective policies and rejects a
  conflict. Coverage pins that deny-over-allow behavior.
- **Fixed — the shared service-charge primitive accepted invalid monetary inputs.** A corrupt stored
  rate or malformed caller value could produce a negative charge or a charge above the merchandise
  basis. The shared calculation now rejects negative bases and rates outside the inclusive zero-to-one
  range before exact decimal multiplication and half-up rounding. Unit coverage includes the bounds
  and the rounding invariant.
- **Verified — missing tax profiles do not become zero tax.** Draft pricing throws a typed unavailable
  error; order reads keep merchandise visible while returning tax and service as unpriced; tender
  settlement still resolves an approved effective profile and therefore refuses settlement without
  one.
- **Verified — tenant boundaries remain server-derived.** The commercial-terms endpoint takes its
  branch from the authenticated terminal context, order detail constrains lookup by that branch, and
  persistence continues through the tenant-scoped database/RLS boundary.
- **Verified — exact-grant-only pharmacy caps are unaffected.** The PR does not change pharmacy quota,
  authorization-grant, inventory-allocation, or cap command code. The pharmacy counter changes are
  presentation/interaction changes only, so no broader or inferred grant was introduced.
- **Verified — money remains exact.** Tax, service charge, delivery fee, comps, discounts, and tender
  totals stay on the shared Decimal helpers; no client-supplied total or floating-point arithmetic was
  added to a settlement path.

## Validation note

Per the PR completion request, dependencies were not installed and tests were not run. Review-time
validation was limited to source/diff inspection and Git whitespace checks.
