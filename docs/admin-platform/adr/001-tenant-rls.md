# ADR-001: Tenant Isolation with Database RLS

Status: Proposed (2026-07-28)

Context: the baseline application has application-layer authorization but no documented organization boundary/RLS. Decision proposed: tenant-owned records receive `organization_id`; user-facing queries run with a transaction-local organization context; PostgreSQL RLS default-denies cross-tenant data.

Consequences: stronger defense in depth and migration/test complexity. Alternatives considered: application predicates alone (rejected as insufficient defense) and database-per-tenant (not selected without operational justification). Acceptance requires schema, policies, isolation tests and restore/migration evidence.
