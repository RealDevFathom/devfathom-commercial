# Known issues

> Things a developer should know before building on an area. Checked against `develop` at `1906b530` on 10 Nov 2026 (PKT). For product-level gaps per feature, see Appendix F of [`../features/devfathom-all-features.md`](../features/devfathom-all-features.md). Infrastructure and security gaps are CTO-owned (see [`../handover/`](../handover/)).

## Process and tooling

1. **GitHub Actions is off, by Saad's decision (10 Nov 2026)**, and all six workflows are disabled. Before every merge, the deterministic checks run on the AWS worker on the exact final commit; nothing merges until they all pass ([testing-and-ci.md](testing-and-ci.md)).
2. **`develop` is unprotected, by Saad's decision (10 Nov 2026).** `main`'s protection is unchanged: it requires two `verify / …` checks, but no workflow on `main` produces them (the names come from an old workflow that is no longer there), so a PR into `main` can never pass them and can only be merged by an admin, because admins are exempt from `main`'s protection. Nobody should change this unless Saad decides ([branching.md](branching.md)).
3. **develop fails its own unit tests at `1906b530`.** Codex will fix it. Until then, check that a failure in your area isn't one you introduced.
4. **Azure is still in the code:** the deploy workflows (`deploy-staging.yml`, `promote-production.yml`) point only at Azure, `qa.yml` still has Azure image names, `src/lib/ai/provider.ts` has a legacy Azure provider, `src/lib/storage.ts` has an Azure storage adapter, and the dependencies still include `@ai-sdk/azure`, `@azure/identity` and `@azure/storage-blob`. Azure is deprecated; don't run or extend these. Saad ordered Azure removed from all code on 10 Nov 2026. The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437).
5. **`staging` and `main` are behind `develop`.** Both are at `08a247c1`. "Live on develop" doesn't mean released or QA-passed.
6. **The full typecheck can run out of memory.** Give `tsc` 8–12 GB. PR #1240 was marked ready for review 52 seconds before it was merged, with no review and no checks; don't repeat that.
7. **`docs/technical-overview.md` is outdated** (Azure topology). Use [architecture.md](architecture.md).
8. **Hundreds of open PRs** (378 on 10 Nov 2026, 318 of them into `develop`). Check for an existing PR before you start. Some are superseded: #802 by later work; #246, "PR J" and #984 possibly by #994; #859 and #140 possibly obsolete. TODO(confirm).

## Code

1. **`platformAIUsage.currentMonth` is a `publicProcedure`** (`src/server/routers/platform-ai-usage.ts`). It is safe: `readMonthlyAIUsage` checks the platform session itself and allows SuperAdmin only, so signed-out callers get no data. But they get an error page instead of a proper "not allowed" response. Sev3.
2. **Pharmacist review sign-off is only checked in the database.** A trigger (`pharmacy_review_no_self_approval`) refuses a decision from the user who requested the review, but `pharmacyDispensing.decideReview` doesn't check it in server code, and nothing stops a review being decided twice ([auth-and-permissions.md §5](auth-and-permissions.md#5-separation-of-duties-sod)). Sev3.
3. **Refund manager/owner PIN approval isn't built.** It's a product decision; refunds only need counter receipt access today.
4. **The narcotic flag isn't built.** It's a product decision. The existing controlled-medicine gate (pharmacist PIN + prescription or emergency reason) is unchanged. The controlled-drugs register is partly built (`src/lib/pharmacy/controlled-register.ts`).
5. **Access gaps in catalogue, marketing and drawer close.** Any signed-in user, including a cashier, can edit the medicine catalogue, including MRP and barcodes (`protectedProcedure` in `pharmacy-medicine.ts`; Sev2; fix #995 has merge conflicts). Marketing is owner-only (tenant admin role), so managers are locked out, against Saad's "manager or owner" rule. Closing a drawer needs only the counter permission. #996 fixes both but has merge conflicts.
6. **The AI "deep" tier has no settings UI.** Opus is used only for the weekly summary, or where an organization has opted in by data.
7. **The tenant `audit_logs` table isn't append-only yet** (open PR #171).
8. **Cross-tenant isolation hasn't been tested end to end** with two real tenants. Only the RLS suites cover it.
9. **No camera hardware has passed acceptance** (`docs/pharmacy/hardware-acceptance-matrix.md`).
10. **Fixed in code but not re-tested by QA:** DEV-583, DEV-579 to DEV-581, and DEV-591. DEV-735 (input-tax bills with a PKR 0 claim wrongly flagged as missing NTN/STRN; Sev2) has no PR and is still live.
11. **Hotel is paused.** Its routers exist; don't extend them without a go-ahead.
