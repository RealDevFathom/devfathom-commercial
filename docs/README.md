# DevFathom documentation

This directory is the source-backed documentation index for DevFathom Commercial. It describes the current web product, the seller-operated control plane, and the Azure operating model. It does not authorize deployment, commercial promises, or capability claims that are not evidenced in the repository.

## Status vocabulary

Use one status on every capability claim:

- **IMPLEMENTED** — present in the current repository and covered by a cited verification or source path.
- **IN PROGRESS** — an identified implementation workstream is active, but has not yet cleared merge, verification, and deployment gates.
- **PARTIAL** — some code or design exists, but a production dependency, integration, or release gate remains.
- **PLANNED** — an accepted design or ADR exists; implementation is not complete.
- **BLOCKED** — work cannot proceed until a named external decision, credential, environment, or owner action exists.
- **FUTURE** — intentionally outside the current web scope or roadmap horizon.

“Complete” in an older document is not sufficient evidence for a production claim; the current status ledger wins when documents disagree.

## Start here

| Audience | Document | Purpose |
| --- | --- | --- |
| Everyone | [Technical overview](technical-overview.md) | Product boundaries, architecture, tenancy, and operating model |
| Developers | [Local setup](LOCAL_SETUP.md) | Local environment and verification |
| Operators | [Azure deployment](azure-deployment.md) | Staging, production gate, backups, and rollback |
| Platform team | [Admin platform handbook](admin-platform/README.md) | Control-plane architecture and runbooks |
| Product and sales | [Product and commercial pack](product-pack.md) | ICP, positioning, feature status, packaging, and customer lifecycle |
| Product and engineering | [POS & terminal module PRD](product/modules/pos-terminal.md) | Evidence-linked register, terminal, checkout, and branch-boundary scope |
| Partners and customers | [Pitch-deck source](pitch-deck.md) | Evidence-safe slide narratives and speaker notes |
| Release owners | [Living status ledger](status-ledger.md) | Evidence, blockers, owners, and next gates |
| Documentation owners | [Documentation QA](qa.md) | Link, stale-reference, and consistency checks |

## Module PRDs

- [Kitchen Display System (KDS)](product/modules/kds.md) — station queue, ticket lifecycle, actions, permissions, and acceptance criteria

## Technical reference

- [Tenant/RLS architecture](admin-platform/architecture-tenancy.md)
- [Identity and access](admin-platform/identity-access.md)
- [Platform control desk](admin-platform/control-plane.md)
- [Platform API inventory](admin-platform/api.md)
- [Data model](admin-platform/data-model.md)
- [Entitlements](admin-platform/entitlements.md)
- [Lifecycle and migration](admin-platform/lifecycle.md)
- [Operations and jobs](admin-platform/operations.md)
- [Runbooks](admin-platform/runbooks.md)
- [Testing and release evidence](admin-platform/testing-release.md)
- [Security threat model](admin-platform/security-threat-model.md)
- [Meetings scope](meetings/000-product-scope.md), [join flow](meetings/004-join-flow.md), and [self-hosted meetings ADR](admin-platform/adr/005-self-hosted-meetings.md)

## Working rules

Documentation changes should cite repository paths and line ranges where practical, distinguish current code from decisions, avoid secret values and customer data, and preserve the web-only boundary. Azure is the deployment platform; no Vercel deployment instructions belong in current operating guidance. Mobile apps are future work; responsive mobile web is part of the current web surface where implemented.

Last reconciled: 2026-08-08.

## Data migrations under forced RLS

Prisma migration files must explicitly bracket cross-tenant data changes and their
transaction-local platform scope. Do not rely on a migration runner to preserve
scope across statements, or put `set_config` in the write's CTE:

```sql
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
-- Idempotent INSERT ... ON CONFLICT DO NOTHING, or a narrowly guarded UPDATE/DELETE.
-- Validate expected rows here, while the same scope is still active.
COMMIT;
```

Keep `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` intact. Never use
session-level platform scope as a workaround. A single `DO` statement may set local
scope internally for its own work; `BEGIN` inside PL/pgSQL is not a SQL transaction.
Do not change applied migrations: add a uniquely timestamped repair migration.
Verify from an empty database owned by a `NOSUPERUSER NOBYPASSRLS` role, then use
populated fixtures to assert changed row counts, a second replay, and tenant
visibility after commit. Empty tables alone cannot prove a backfill worked.

The #218 regression check is `TZ=UTC MIGSWEEP_DATABASE_URL=<disposable-owner-url>
bun run test tests/migration-rls-sweep.db.test.ts --maxWorkers=1`. Its URL must point
to a disposable database after `prisma migrate deploy`; it inserts test fixtures.
