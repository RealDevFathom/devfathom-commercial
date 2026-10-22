# Issue #455 — archived WHA-242 work is already present

## Decision

Close the recovery issue as obsolete. No archived commit should be cherry-picked or
re-opened as a PR: every item in the supplied `main..archive/rescue/WHA-242`
inventory already has an equivalent (and, in several cases, a more complete
successor) on the current branch.

The archived tag object was not included in this checkout, and the repository has
no configured remote. A direct fetch from the recorded GitHub URL was also denied
by the environment with HTTP 403. The verification below therefore maps each
commit in the issue's five-commit inventory to current code and focused regression
coverage rather than claiming an object-level diff that this checkout cannot
perform.

## Current-code evidence and skipped archive work

| Archived commit | Current evidence | Disposition |
| --- | --- | --- |
| `d8696e47` — time-boxed checkout promotion engine (WHA-288) | The deterministic evaluator imposes canonical candidate ordering and checks branch, channel, customer segment, offline policy, and activation authority in [`src/lib/restaurant/promotion-evaluator.ts:113-217`](../src/lib/restaurant/promotion-evaluator.ts#L113-L217). Time windows are delegated to the promotion schedule resolver at [`src/lib/restaurant/promotion-evaluator.ts:45`](../src/lib/restaurant/promotion-evaluator.ts#L45). The tenant-keyed immutable-version, evaluation-snapshot, and cap-ledger data model is documented in [`prisma/schema.prisma:9891-9920`](../prisma/schema.prisma#L9891-L9920), while the focused evaluator battery enumerates rounding, targeting, fail-closed filtering, stacking, and allocation cases in [`src/lib/restaurant/promotion-evaluator.test.ts:1-35`](../src/lib/restaurant/promotion-evaluator.test.ts#L1-L35). | **Skipped as already implemented.** Replaying the archive risks duplicating the schema/migration and replacing the current promotion implementation or its broader regression coverage. |
| `296440a2` — distinguish unavailable from exhausted SOP entitlements (WHA-266) | The current SOP admin model explicitly separates `available`, `disabled`, `exhausted`, and `unconfigured` at [`src/app/(app)/restaurant/sop/admin/sop-admin.tsx:105-140`](../src/app/%28app%29/restaurant/sop/admin/sop-admin.tsx#L105-L140). It renders different status, tone, and remediation for missing configuration, an intentional zero allowance, and a used-up quota at [`src/app/(app)/restaurant/sop/admin/sop-admin.tsx:467-539`](../src/app/%28app%29/restaurant/sop/admin/sop-admin.tsx#L467-L539). Focused regression cases cover unavailable, exhausted, and unconfigured states in [`src/app/(app)/restaurant/sop/admin/page.test.tsx:113-231`](../src/app/%28app%29/restaurant/sop/admin/page.test.tsx#L113-L231). | **Skipped as already implemented and extended.** The current four-state model is more precise than restoring an older unavailable/exhausted distinction alone. |
| `5b44fd62` — gate SOP depth on module and limit catalog (WHA-264) | The generic evaluator fails closed when modules or limits are absent at [`src/lib/module-catalog.ts:387-444`](../src/lib/module-catalog.ts#L387-L444), and the SOP depth catalogue declares module-plus-limit requirements without package coupling at [`src/lib/module-catalog.ts:447-515`](../src/lib/module-catalog.ts#L447-L515). Router enforcement reads only the caller organization's resolved entitlements and rejects insufficient depth before resolver work at [`src/server/routers/restaurant-sop-execution.ts:42-69`](../src/server/routers/restaurant-sop-execution.ts#L42-L69). Tests pin missing-module denial, absent-limit denial, and catalogue-only keys at [`src/lib/module-catalog.test.ts:287-355`](../src/lib/module-catalog.test.ts#L287-L355). | **Skipped as already implemented.** Restoring the old commit would add no capability and could regress the current fail-closed, tenant-scoped enforcement. |
| `a24e10f0` — bind workspace chrome to session organization | Tenant branding carries its owning organization and the identity comparison rejects mismatches at [`src/lib/tenant-brand.ts:1-24`](../src/lib/tenant-brand.ts#L1-L24). The application shell withholds tenant chrome, palette, and page content when the live session moves organizations at [`src/components/layout/app-shell.tsx:117-157`](../src/components/layout/app-shell.tsx#L117-L157) and applies that check before rendering the branded shell at [`src/components/layout/app-shell.tsx:168-203`](../src/components/layout/app-shell.tsx#L168-L203). Focused tests prove that mismatched content and brand tokens do not render and that matching identities still work at [`src/components/layout/app-shell.tenant-identity.test.tsx:93-147`](../src/components/layout/app-shell.tenant-identity.test.tsx#L93-L147). | **Skipped as already implemented.** The present fail-closed shell and tests directly cover the archived fix's stated purpose. |
| `a678e149` — add Chai Chowk tenant fixture | The restaurant seed upserts Chai Chowk as its own restaurant organization with stable locale, currency, and timezone at [`scripts/seed-restaurant-e2e.ts:1038-1074`](../scripts/seed-restaurant-e2e.ts#L1038-L1074). The showcase layer describes the PKR-denominated Gulberg fixture at [`scripts/seed-restaurant-demo.ts:1-13`](../scripts/seed-restaurant-demo.ts#L1-L13). The seed also verifies cross-organization membership and rejects any owned fixture row attributed to another tenant at [`scripts/seed-restaurant-e2e.ts:2802-2824`](../scripts/seed-restaurant-e2e.ts#L2802-L2824). | **Skipped as already implemented and hardened.** The current fixture includes explicit tenant-separation verification, so restoring an older seed would be redundant and could collide with stable fixture identities. |

## Recovery outcome

- Ported: **nothing** — there is no valuable fix from the supplied archive
  inventory missing in the current code.
- Skipped: **all five archived commits**, individually justified above.
- Added tests: **none** — this issue is already fixed and the instruction for that
  outcome limits the change to this evidence document; the focused existing tests
  are linked above.
- Security invariants: unchanged. This documentation-only resolution does not
  alter tenant isolation, authorization precedence, exact-grant pharmacy rules,
  WhatsApp sending, migrations, or logging.
