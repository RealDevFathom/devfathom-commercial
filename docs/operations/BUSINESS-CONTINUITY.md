# Business continuity and disaster recovery

**Snapshot:** 2026-07-12  
**Honest status:** almost everything in this document is **Proposed**. No backup ownership, restore drill, RPO/RTO measurement, or continuity exercise is currently evidenced anywhere in the repository or platform configuration (risk R-003). The verified facts are the dependency and failure-mode statements.

## Service tiers (Proposed)

| Tier                   | Services                                                            | Rationale                                                |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 0 — Core               | PostgreSQL, authentication (NextAuth/`AUTH_SECRET`), Vercel runtime | Without these the Hub does not function at all           |
| 1 — Primary workflows  | Projects/tasks, finance, team/HR, notes, meetings records           | The reasons the Hub exists; hours-level outage tolerance |
| 2 — Live collaboration | Ably realtime, JaaS video, AI assistant, Brevo delivery             | Degraded-mode acceptable: the app works without them     |
| 3 — Automation         | REST API, webhooks, connected mailboxes (currently disabled)        | Consumers must tolerate gaps and replay                  |

## RPO / RTO targets (Proposed — not yet measured or committed)

| Tier           | RPO target                                     | RTO target                     | Current reality                                                                                      |
| -------------- | ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 0              | ≤ 15 min (PITR)                                | ≤ 4 h                          | Unknown — provider backup posture undocumented                                                       |
| 1              | Same as Tier 0 (same database)                 | ≤ 4 h                          | Unknown                                                                                              |
| Uploaded files | ≤ 24 h                                         | ≤ 8 h                          | **Effectively infinite RPO** — files on function-local disk are lost on instance replacement (R-001) |
| 2              | Vendor-managed                                 | ≤ 1 h to confirm degraded mode | No monitoring to detect the outage (R-008)                                                           |
| 3              | Webhook events: none (single-attempt delivery) | Consumer-dependent             | Lost deliveries are visible in `WebhookDelivery` rows but not replayable (R-023)                     |

These numbers become real only when an owner signs them and a restore drill measures them.

## Backup matrix (Proposed)

| Asset                         | Method                                                                                                                                                 | Frequency  | Retention                | Owner                          | Restore evidence required                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------ | ------------------------------ | -------------------------------------------------------------------------- |
| PostgreSQL                    | Provider automated backups + PITR                                                                                                                      | Continuous | ≥ 30 days                | **TBD — Operations**           | Quarterly restore to an isolated environment, timed                        |
| Uploaded files                | Blocked on D-012 (durable object storage); then versioning + lifecycle rules                                                                           | Continuous | ≥ 30 days                | **TBD — Platform**             | Restore sample objects + ownership metadata                                |
| Environment variables/secrets | Vercel is the store of record; recovery inventory is the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md) (names only) + issuer consoles | On change  | n/a                      | **TBD — Platform**             | Reconstruction drill: rebuild a working Preview from issuer consoles alone |
| Audit evidence                | Included in database backup; export/archive policy needed for tamper resistance                                                                        | With DB    | **TBD — Legal/Security** | Export and replay verification |
| Source and migrations         | GitHub repository, protected branch, release tags                                                                                                      | On push    | Indefinite               | Engineering lead               | Fresh-clone rebuild succeeds (`bun install && bun run build`)              |

## Database restore procedure (Proposed)

1. Declare the incident and severity ([runbooks](RUNBOOKS.md)); stop writes if corruption is spreading (pause the Vercel deployment or set the app to maintenance).
2. Identify the restore point: last known-good timestamp from audit rows, user reports, and provider logs.
3. Restore via the provider's PITR into a **new** database instance — never in place.
4. Validate the restored instance: row counts on key tables (`User`, `Task`, `Invoice`, `Message`, `AuditLog`), spot-check the most recent known-good records, run the app against it in Preview.
5. Switch `DATABASE_URL` in Vercel Production and redeploy; verify login and the smoke path.
6. Reconcile the gap window: identify writes lost between restore point and incident (audit table on the old instance if readable) and repair per the [data repair runbook](RUNBOOKS.md#14-data-repair).
7. Record measured RPO (data lost) and RTO (time to recovery) in the evidence log below.

## Continuity / degraded-mode matrix

Failure behaviors are **Verified** from code; workarounds are **Proposed**.

| Outage                                | Immediate effect (verified)                                                                                       | Degraded mode                   | Manual workaround                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| PostgreSQL                            | App effectively down; JWT claim refresh fails open so sessions linger with stale claims (R-020)                   | None                            | Communicate; restore per above                              |
| Vercel / `sin1` region                | Full outage                                                                                                       | None (single region, D-011)     | Await platform recovery; multi-region is a future decision  |
| Ably                                  | App loads; chat/typing/presence stop updating live; server emit helpers are silent no-ops so writes still persist | Refresh-to-see-messages         | Tell the team to refresh; watch Ably status page            |
| Google AI                             | Assistant returns errors; everything else unaffected                                                              | Full app minus assistant        | Use the UI directly                                         |
| Brevo                                 | Invites, password resets, invoice sends, HR notices fail to deliver (in-app records still created)                | In-app notifications still work | Re-trigger sends after recovery; never hand-copy raw tokens |
| 8x8 JaaS                              | Call join fails with a precondition error; meeting records unaffected                                             | Meetings as calendar records    | Fall back to an external meeting link                       |
| Uploaded-file loss (instance recycle) | Attachment/document links 404; database rows survive                                                              | None until D-012                | Ask owners to re-upload; inventory broken references        |
| Webhook receiver down                 | Delivery attempt fails once, recorded in `WebhookDelivery`; event is not retried                                  | Consumers poll REST instead     | Manual replay after R-023 tooling exists                    |
| Connected mailboxes                   | Feature is disabled by configuration today                                                                        | n/a                             | Keep disabled until R-005 closes                            |

## Vendor dependency register

| Vendor              | Tier       | Continuity question to resolve with owner                                                             |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| PostgreSQL provider | 0          | Backup/PITR contract, region, encryption, access list — **the single most important unresolved item** |
| Vercel              | 0          | Rollback discipline, alias control, support path                                                      |
| Ably                | 2          | Quota/limit alerts; observed timeout signals need follow-up                                           |
| Google AI           | 2          | Spend caps, data-retention terms                                                                      |
| Brevo               | 2          | Delivery/bounce monitoring, sender reputation                                                         |
| 8x8 JaaS            | 2          | Key rotation procedure                                                                                |
| GitHub              | 0 (source) | Branch protection, access review                                                                      |

## Disaster-recovery exercise schedule (Proposed)

| Exercise                                            | Cadence                             | First run                                         | Output                                          |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Database restore drill (full procedure above)       | Quarterly                           | Within 30 days of backup ownership being assigned | Timed evidence-log entry with measured RPO/RTO  |
| Secret-reconstruction drill                         | Semi-annual                         | After the environment catalogue is validated      | Working Preview built from issuer consoles only |
| Incident tabletop (pick a scenario from the matrix) | Semi-annual                         | Within 60 days                                    | Postmortem-format writeup with action items     |
| Continuity review of this document                  | Quarterly + after any vendor change | —                                                 | Updated matrix and register                     |

## Ownership (placeholders until accepted)

| Role                 | Responsibility                                 | Owner   |
| -------------------- | ---------------------------------------------- | ------- |
| Continuity owner     | This document, exercise schedule, evidence log | **TBD** |
| Database owner       | Backups, PITR, restore drills                  | **TBD** |
| Platform owner       | Vercel, secrets, storage migration             | **TBD** |
| Security owner       | Session/secret compromise response             | **TBD** |
| Communications owner | Incident announcements                         | **TBD** |

## Evidence log template

Append one entry per drill or real event; this log is the proof the plan works.

```text
Date:               YYYY-MM-DD
Type:               Restore drill | Secret drill | Tabletop | Real incident
Scenario:           <what was simulated or happened>
Participants:       <names>
Restore point:      <timestamp targeted>
Measured RPO:       <data window lost>
Measured RTO:       <time to service restored>
Gaps found:         <what didn't work>
Actions:            <owner → action → due date>
Artifacts:          <links to logs, screenshots, tickets>
```

## Related documents

- [Runbooks](RUNBOOKS.md) — the per-incident procedures this plan invokes.
- [Deployment and environments](DEPLOYMENT-ENVIRONMENTS.md) — rollback and environment mechanics.
- [Data architecture](../architecture/DATA-ARCHITECTURE.md) — backup requirements per asset.
- [Risk register](../executive/RISK-REGISTER.md) — R-001, R-003, R-008, R-015, R-020, R-023, R-029, R-030.
- [Ownership and RACI](../governance/OWNERSHIP-RACI.md) — accountable roles and acceptance record.
