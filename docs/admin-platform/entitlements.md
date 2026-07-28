# Modules, Capabilities, and Entitlements

## Planned contract

Catalog modules (for example CRM, Finance, HR, Chat, API, SSO) independently from fine-grained capabilities (`finance.invoice.write`, `api.token.manage`). Effective permission is the intersection of organization plan, explicit grant/revocation, membership role, resource policy, and lifecycle state.

Capability checks should remain server-side at every mutation and sensitive read. Client-side visibility is presentation only. `src/server/trpc.ts:128-169` already provides a baseline capability-procedure concept; it must be extended with tenant-scoped entitlement resolution rather than trusting a UI flag.

Usage limits are evaluated atomically against durable counters/events, with clear responses and auditable override grants. Cache only bounded, invalidatable authorization snapshots.
