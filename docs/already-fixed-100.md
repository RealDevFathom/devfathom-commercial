# GitHub issue #100 is already fixed

## Verification result

The namespace-composition defect described in issue #100 is not present in the current source.
The root and all three delivered helper planners now use one canonical namespace contract, so no
lane-specific rename or adapter is needed. No production code, authorization rule, grant,
regulatory fact, or migration was changed for this issue.

This conclusion is based on source inspection only, as requested: the exported root producer and
each exported planner are compared directly below without exercising a database or live service.

## File-and-line evidence

1. The shared contract explicitly says that every lane consumes the canonical namespace unchanged
   and accepts exactly `phdemo_` followed by 24 lowercase hexadecimal characters and a trailing
   underscore (`scripts/pharmacy-demo-contract.ts:41-44`).
2. The root `targetNamespace` hashes the environment, target key, organization ID, and branch ID,
   truncates that lowercase hexadecimal digest to 24 characters, and emits that exact canonical
   shape (`scripts/seed-pharmacy-demo.ts:121-134`). For the issue's four inputs, the source algorithm
   yields `phdemo_5448aaf03524eb09362cd3d5_`, which satisfies the shared predicate without rewriting.
3. Inventory imports the shared predicate (`scripts/pharmacy-demo-inventory.ts:6-14`) and applies it
   directly to `facts.namespace` (`scripts/pharmacy-demo-inventory.ts:107-123`). Its focused tests
   verify that a canonical root namespace is accepted and retained in both dependency scope and the
   business reference (`scripts/pharmacy-demo-inventory.test.ts:173-195`).
4. Finance copies `context.namespace` directly into its scope and validates it with the same shared
   predicate (`scripts/pharmacy-demo-finance.ts:503-514`). Its focused tests verify unchanged
   namespace provenance in the result, scope, and namespaced references
   (`scripts/pharmacy-demo-finance.test.ts:497-518`).
5. Retention imports the shared predicate (`scripts/pharmacy-demo-retention.ts:1-8`), validates the
   input namespace with it, and derives references from the unchanged value
   (`scripts/pharmacy-demo-retention.ts:76-101`). Its focused tests verify unchanged identity and
   reference prefixes (`scripts/pharmacy-demo-retention.test.ts:85-98`).
6. Root-focused coverage independently verifies that `targetNamespace` output satisfies the shared
   predicate and remains stable, while the three obsolete lane-specific formats from the report are
   rejected (`scripts/seed-pharmacy-demo.test.ts:166-203`).

Together, these source paths establish composition: the root produces the one shape recognized by
the common predicate, and inventory, finance, and retention all validate and preserve that same
input. The existing focused tests already cover the contract and each helper's unchanged namespace
provenance, so the issue's instruction to add only this evidence document when already fixed applies.
