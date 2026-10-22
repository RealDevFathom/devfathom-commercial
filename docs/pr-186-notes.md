# PR 186 review notes

## Review scope

Reviewed the POS/counter refresh changes against the available pre-PR parent (`fa3658b`) because this checkout has no configured `origin` remote. The requested `git fetch origin main` and `git diff origin/main...HEAD` therefore could not be completed in this environment. The reviewed range contains the five POS commits from `699d5c1` through the branch tip.

No dependencies were installed and no test, lint, typecheck, build, or browser command was run, as requested.

## Findings and resolutions

### Fixed: an open restaurant order could be repriced by a later service policy

The refreshed order detail calculated service charge from the branch policy effective at read time, and tender settlement independently repeated that lookup. An acknowledged service-charge policy is already pinned to the order and its allocated amount is snapshotted on a cut bill. Looking up a newer policy could therefore make the displayed amount change after opening an order and make settlement disagree with the immutable bill.

The order-detail quote now uses the order's pinned policy rate. Tender settlement again uses `bill.serviceChargeTotal`, preserving the bill-cut allocation and money invariant. Regression coverage changes the current branch rate independently from the pinned rate and asserts that the open-order total does not change.

### Reviewed: tenant and branch isolation

The commercial-terms endpoint derives its branch solely from the authenticated terminal context. Order detail retains its `id + branchId` lookup and does not accept a client-selected tenant or branch for the new pricing reads. The scoped database remains the source of organization isolation.

### Reviewed: tax fail-closed behavior

Commercial-term reads select only published profiles and rules inside the effective interval. Draft/order quoting refuses to return a price when no effective tax profile exists, and the terminal detail endpoint maps that expected condition to a conflict response instead of returning a zero-tax total.

### Reviewed: pharmacy authorization semantics

The pharmacy changes in this range are presentational and client-state changes; they do not add or broaden a server capability. Existing server procedures remain authoritative. No wildcard or prefix-based grant matching, ALLOW-over-DENY change, or pharmacy cap calculation was introduced by this PR.

### Reviewed: exact money handling

Restaurant prices, modifier deltas, tax rates, service rates, and delivery fees stay as decimal strings/Prisma decimals through quote calculation. No floating-point conversion was introduced. Pharmacy monetary values remain integer minor units, including the new bill validation guards.

## Remaining limitations

Visual QA and screenshots were intentionally not produced because the request explicitly prohibited running tests and asked for code-only completion. The UI should still be exercised at the design-contract viewport/theme matrix before release in an environment where QA commands are permitted.
