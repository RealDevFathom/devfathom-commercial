# Organization Lifecycle, Export, and Purge

## Planned state machine

`trial → active → suspended → pending_deletion → purged`, with explicit reactivation rules. Suspension blocks new sessions/mutations according to policy while retaining audit visibility. Pending deletion starts a retention clock and export window. Purge is asynchronous, idempotent, auditable and covers database records, blobs, search/cache material, credentials and provider-held data according to the data-processing agreement.

Exports are authorization-gated jobs with a snapshot boundary, encryption, expiry, download audit event and tenant isolation test. Legal holds override automated purge. No production retention period is defined by this baseline; obtain policy approval before setting one.
