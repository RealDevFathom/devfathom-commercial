# Agency Admin Control Plane

## Planned surfaces

Agency administrators manage organizations, lifecycle state, plan assignments, identity connections, domains, branding, commercial accounts, usage, support sessions, exports, and audit investigations. Tenant admins manage only their organization’s users, configuration and enabled capabilities.

Control-plane actions must be separate from tenant application routes. Every mutation needs actor, target agency/organization, request/correlation ID, before/after summary, reason where sensitive, and outcome. The UI must expose read-only state before destructive actions and use confirmation for suspend, purge, key rotation, and impersonation.

## Not implemented claim

There is no evidence in the baseline inspected here of agency-level organization management routes. Existing `ADMIN` is an application role, not proof of a platform-wide agency-admin boundary.
