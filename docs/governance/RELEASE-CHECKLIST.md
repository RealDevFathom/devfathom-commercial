# Release checklist

**Status:** Proposed process, effective immediately as the documented target; several gates cannot yet be evaluated because tests, CI, and migrations do not exist (see [quality and performance](../engineering/QUALITY-PERFORMANCE.md)).  
**Snapshot:** 2026-07-12

## Release policy

> **No production release proceeds while lint, tests, dependency audit, or migration checks are red — unless a signed risk acceptance exists.**

A risk acceptance uses the template in the [risk register](../executive/RISK-REGISTER.md): named business and technical owners, rationale, compensating controls, expiry date, and approver. "The gate doesn't exist yet" is itself a red state: until CI and tests exist, every production release implicitly relies on the standing acceptance of risks R-002, R-007, and R-009, and the releaser should know that.

Releases are currently manual (no CI). Record the evidence for each section below by hand — a filled copy of this checklist attached to the release note is the minimum.

## 1. Pre-merge

- [ ] `bunx tsc --noEmit` passes.
- [ ] `bun run lint` passes, or every new finding is justified in the PR (no new errors, ever).
- [ ] `bun run format:check` passes for touched files.
- [ ] Tests covering the change pass (once a test suite exists; until then, describe manual verification in the PR).
- [ ] The diff contains no secrets, credentials, tokens, private keys, or copied `.env` values.
- [ ] Two lockfiles were not both modified; dependency changes go through `bun` only.
- [ ] Documentation updated in the same PR when the change touches a business rule, integration, environment variable, API contract, or operational dependency ([maintenance contract](../README.md#documentation-maintenance-contract)).
- [ ] New/changed endpoints and tools declare authorization (ABAC and object-level), audit capture, and input validation.
- [ ] Material architecture choices are recorded in the [decision register](DECISION-REGISTER.md).

## 2. Preview validation

- [ ] Vercel Preview deployment is **Ready** (not just created).
- [ ] Preview environment variables cover every integration the change touches — Preview currently lacks Gemini and JaaS variables (Verified 2026-07-12), so assistant/video changes cannot be validated on Preview until parity is fixed.
- [ ] Smoke pass on Preview: login → dashboard → open a project board → move a task → send a chat message → open an invoice (admin) → confirm the assistant panel loads.
- [ ] Any schema change was applied to a Preview/staging database first, never directly to production.

## 3. Database changes

- [ ] Production backup/PITR confirmed **before** applying schema changes (see [business continuity](../operations/BUSINESS-CONTINUITY.md)).
- [ ] Change is expressed as a committed migration, not an ad-hoc `db push` (target state; today `db push` is the mechanism — treat every schema release as elevated risk until R-002 closes).
- [ ] Migration SQL reviewed for locks, rewrites of large tables, and data loss (`prisma migrate diff` output attached).
- [ ] Expand/contract used for renames and type changes so old and new application versions coexist during rollout.
- [ ] Backfill scripts are idempotent, transactional where possible, and leave audit evidence.
- [ ] Rollback stance recorded: roll-forward plan by default; rollback-safe migrations explicitly identified.

## 4. Security

- [ ] New routes/procedures/tools re-checked against the [security architecture](../architecture/SECURITY-ARCHITECTURE.md) layers: session, account status, ABAC capability, object-level guard, audit.
- [ ] REST changes: scope declared, finance admin-binding preserved, error contract unchanged.
- [ ] No widening of CSP, image remote patterns, or permissions policy without a decision-register entry.
- [ ] Secrets introduced only through Vercel environment variables; names added to the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md).
- [ ] `bun audit` clean, or advisories covered by a current signed exception.

## 5. Deployment

- [ ] Deploy the built artifact by promoting the validated Preview deployment; do not rebuild between validation and production (immutable promotion).
- [ ] Record the production deployment ID and the previous production deployment ID (this is the rollback target).
- [ ] Verify the canonical production alias points at the new deployment (`vercel inspect <alias>` / dashboard) — alias drift has been observed and is an open item in [deployment and environments](../operations/DEPLOYMENT-ENVIRONMENTS.md).

## 6. Post-deploy

- [ ] Re-run the smoke pass against production.
- [ ] Scan runtime logs for new errors in the first 15 minutes (manual today; error tracker once R-008 closes).
- [ ] Confirm background-ish behaviors that the release touched: webhook delivery rows, audit rows, notification creation.
- [ ] Announce the release (what changed, deployment ID, rollback target) in the operations channel.

## 7. Rollback evidence

Prepared **before** the release, not during the incident:

- [ ] Previous production deployment ID recorded and confirmed still promotable.
- [ ] Schema compatibility of the previous app version with the current database confirmed (expand/contract discipline makes this true by default).
- [ ] Rollback procedure owner named; steps in [runbooks — rollback](../operations/RUNBOOKS.md#2-rollback).

## Sign-off record

```text
Release:            <version/date/deployment ID>
Changes:            <PRs / summary>
Gates:              typecheck ✅/❌  lint ✅/❌  tests ✅/❌/absent  build ✅/❌  audit ✅/❌  migration ✅/❌/n-a
Risk acceptances:   <IDs + expiry, or "none">
Preview evidence:   <URL + smoke result>
Rollback target:    <deployment ID>
Released by:        <name>
Approved by:        <name>
Date/time:          <UTC>
```
