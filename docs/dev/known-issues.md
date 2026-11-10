# Known issues

> Things a developer should know before building on an area. Checked against `develop` at `1906b530` on 10 Nov 2026 (PKT). For product-level gaps per feature, see Appendix F of [`../features/devfathom-all-features.md`](../features/devfathom-all-features.md). Infrastructure and security gaps are CTO-owned (see [`../handover/`](../handover/)).

## Process and tooling

1. **GitHub Actions is disabled**, so no CI runs on any PR or push. Run the checks locally ([testing-and-ci.md](testing-and-ci.md)).
2. **`develop` has no branch protection.** Review is by policy only ([branching.md](branching.md)).
3. **Deploy workflows still reference Azure** (`deploy-staging.yml`, `promote-production.yml`), and the dependencies still include `@ai-sdk/azure` and `@azure/identity`. Azure is deprecated; don't run or extend these.
4. **`staging` and `main` are behind `develop`.** Both are at `08a247c1`. "Live on develop" doesn't mean released or QA-passed.
5. **The full typecheck can run out of memory.** PR #1240 merged as "[Draft]" for this reason. Give `tsc` 8–12 GB.
6. **`docs/technical-overview.md` is outdated** (Azure topology). Use [architecture.md](architecture.md).
7. **Hundreds of open PRs** (378 on 10 Nov 2026, 318 of them into `develop`). Check for an existing PR before you start. Some are superseded: #802 by later work; #246, "PR J" and #984 possibly by #994; #859 and #140 possibly obsolete. TODO(confirm).

## Code

1. **`aiSettings.currentMonth` is a `publicProcedure`.** It should be platform-gated like the rest of `ai-settings`.
2. **Self-signed pharmacist review.** `pharmacyDispensing.decideReview` doesn't refuse a decider who is the same person as the requester ([auth-and-permissions.md §5](auth-and-permissions.md#5-separation-of-duties-sod)).
3. **Refund manager/owner PIN approval isn't built.** It's a product decision; refunds only need counter receipt access today.
4. **The narcotic flag isn't built.** It's a product decision. The existing controlled-medicine gate (pharmacist PIN + prescription or emergency reason) is unchanged.
5. **Some pharmacy areas are module-gated only, with no capability check:** catalogue edits and marketing (open PRs #995 and #996).
6. **The AI "deep" tier has no settings UI.** Opus is used only for the weekly summary, or where an organization has opted in by data.
7. **The tenant `audit_logs` table isn't append-only yet** (open PR #171).
8. **Cross-tenant isolation hasn't been tested end to end** with two real tenants. Only the RLS suites cover it.
9. **No camera hardware has passed acceptance** (`docs/pharmacy/hardware-acceptance-matrix.md`).
10. **Fixed in code but not re-tested by QA:** DEV-583, DEV-579 to DEV-581, and DEV-591. DEV-735 has no PR.
11. **Hotel is paused.** Its routers exist; don't extend them without a go-ahead.
