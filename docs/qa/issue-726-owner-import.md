# Issue 726: owner opening-stock importer

Route: `/pharmacy/inventory/import`, linked from Inventory. The existing tenant
shell, PageHeader, SectionCard, Button, Input, Table and StatusPill supply Studio
geometry, typography, semantic colors, focus states and theme behavior.

Owners use the existing workspace ADMIN capability and Pharmacy Inventory
entitlement. Medicines and packs must already be configured. Counts and costs
are per base unit; printed MRP is per selected pack. A file may contain up to
250 rows, 40 columns and 1 MiB. Larger handovers can use several files with
distinct medicine/batch/pack rows before ordinary stock operations begin.

Dry runs do not write inventory. Commit rechecks the review, posts counted units
through MIG-03, and calls the existing opening-stock finance adapter in the same
tenant transaction. Source hashes, actor, mapping, destination and receipt are
audited. Zero-valued openings have no finance journal entry. Existing variance
explanations and independent sign-off remain in force.

Automated tests were added but **not run**, as directed for this issue. No
typecheck, lint, build, migration, security scanner or browser QA was executed.

| Studio release gate | Coverage prepared | Execution status |
| --- | --- | --- |
| 375 / 768 / 1024 / 1440 viewports | Playwright matrix | Pending QA |
| Light / dark | Playwright matrix and existing semantic tokens | Pending QA |
| Normal / reduced motion | Playwright matrix; no page-specific animation | Pending QA |
| Keyboard / focus | Native labeled controls, keyboard preview action in Playwright | Pending QA |
| Bounded table / no document overflow | Shared Table and Playwright assertion | Pending QA |
| Loading / empty / error / disabled / confirmation | Wizard component tests; blocked review in Playwright | Pending QA |
| Hydration / console / fetch errors | Playwright console assertions | Pending QA |
| Product parity | Existing tenant shell and Studio primitives | Pending visual review |
| Escape / focus trapping | No new dialog or drawer; inherited shell behavior | Shared shell coverage |

`tests/e2e/pharmacy-owner-import-visual-qa.spec.ts` prepares screenshots for the
matrix with an ADMIN account in a Pharmacy Inventory tenant. It previews an
unmatched pack and never commits stock. Unit/router/component tests cover
validation, permissions, confirmation and replay. The existing forced-RLS
opening-cutover DB suite now includes atomic stock/valuation posting, concurrent
retry, cross-tenant reads and valuation-failure rollback.
