# Pharmacy tenant stacks

`../pharmacy-tenant.yaml` is a parameterised CloudFormation stack for a single,
isolated pharmacy tenant. It attaches one Fargate Spot service to an existing
shared HTTPS ALB and ECS cluster, and creates a private, single-AZ
`db.t4g.micro` PostgreSQL database. `DesiredCount` defaults to `0`, so creating
infrastructure does not start application tasks.

The JSON files here are examples for the `shared`, `abbasi-pharmacie`, and
`sehatcart` tenants in staging and production. Values beginning with `REPLACE_`
are deliberately non-secret interface stubs for shared-infrastructure outputs;
copy an example and replace them before using it. Hostnames must already resolve
to the shared ALB, and each listener priority must be unique on that listener.
No DNS records or certificates are created by this stack.

AI remains off because the task sets `AI_PROVIDER=disabled` and supplies no AI
provider credential. Enabling AI is a separate, server-validated organization
configuration change after its provider secret exists; do not add provider
secrets to these parameter files.

## Zero-data-loss migration

Database replacement takes a final snapshot, the generated database credential
and derived connection secret are retained, and production deletion protection
is enabled. Those safeguards are not a migration procedure: before changing a
tenant's database or moving it into this stack, take and verify a fresh snapshot,
restore/copy into the new database, run schema migrations as a separate one-off
task, validate tenant row counts and `org_id` isolation, then switch the ALB host
rule. Keep the old database and secrets intact until reconciliation and rollback
windows have passed. Never import by deleting or recreating the source database,
and never run old and new writers concurrently.

The module intentionally does not model application permissions, audit events,
or AI behavior. Those remain server-owned contracts (central `can()`, explicit
DENY precedence, exact grants for pharmacy operations, and audit logging); the
only infrastructure interface is the tenant slug and isolated database.
