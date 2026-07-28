# Operations Runbooks

## Incident: suspected tenant isolation failure

1. Declare incident; stop affected write paths or suspend impacted tenant access.
2. Preserve request IDs, audit records, DB logs and deployment version.
3. Identify affected organization IDs and time window; do not mutate evidence.
4. Revoke implicated tokens/sessions and rotate secrets if indicated.
5. Validate scope using read-only queries and isolation tests; notify security/legal owners per policy.
6. Remediate, verify, document customer communication and publish post-incident actions.

## Restore drill

Restore a production-like backup to an isolated environment; measure restore point and time; verify tenant boundaries, application login and file references; record evidence. Never test restoration into production.

## Domain verification failure

Mark domain pending/failed, keep canonical host available, show actionable DNS requirements, and never route unverified hosts to a tenant.

## Purge job failure

Pause/retry idempotently, preserve job/audit state, identify remaining data stores, and do not mark completion until reconciled.
