# PR #377 review notes

## Scope

Reviewed the pharmacy-counter change for QA issue #352: an out-of-stock medicine must not be
described as having a pack-hierarchy mismatch.

The checkout read model already reports safe, sellable canonical stock in `onHandUnits` and leaves
`saleUnits` empty when there is no recommended sellable lot. The counter now passes that stock
quantity to the sale-unit control so the empty state can distinguish an exhausted/blocked medicine
from a stocked lot whose hierarchy genuinely cannot be priced.

## Findings and resolutions

- **Incorrect out-of-stock explanation:** resolved by rendering a dedicated out-of-stock status
  whenever the selected row has no sale-unit options and no positive safe stock.
- **Fail-closed inventory display:** non-positive availability is treated as out of stock. This
  avoids presenting a hierarchy diagnosis if an invalid negative stock value ever reaches the UI.
- **Regression coverage:** the component tests cover the stocked hierarchy-mismatch path, the
  zero-stock path, and the defensive negative-availability path. They also assert that the stockout
  copy does not mention pack hierarchy.
- **Tenant isolation, DENY-over-ALLOW, exact-grant-only pharmacy capabilities, and money
  invariants:** no authorization, tenancy, capability, database, pricing, or money calculation code
  is changed by this PR. The UI consumes the already-scoped counter row and continues to delegate
  all price previews to the existing pricing kernel.

## Review constraints

The checkout has no configured `origin` remote in this workspace, so `git fetch origin main` could
not resolve a repository. The available PR commit was reviewed against its first parent, which is
the merge commit immediately preceding the QA fix. Per the task request, dependencies were not
installed and tests were not run.
