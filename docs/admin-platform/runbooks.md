# Operator Runbooks

## Onboard a new customer agency

1. Create/update the CRM account, lead, contacts, opportunity, proposal, and follow-up.
2. Mark the opportunity won and convert it, or create the organization manually.
3. Confirm slug, legal/display name, locale/timezone/currency, primary contact, package, seats, and deployment mode.
4. Create at least one active administrator.
5. Record the signed contract, dates, grace, modules, limits, value, billing interval, and renewal owner.
6. Add only necessary organization overrides.
7. For shared mode, queue shared provisioning. For dedicated mode, stop until an approved isolated AWS environment and rollout plan exist.
8. Configure and test brand, email, domain, SSO, and SCIM only as contracted.
9. Review the effective tenant license view.
10. Transition ONBOARDING → ACTIVE with the approved reason.
11. Log in on the customer host and complete the acceptance checklist.

## Suspend and resume an organization

Suspend:

1. Confirm organization and reason.
2. Review active support sessions, contracts, and customer communication.
3. Transition to SUSPENDED.
4. Verify `SUSPEND` job succeeds, deployment shows degraded/suspended, support sessions are revoked, and tenant access is blocked.

Resume:

1. Resolve the commercial/security cause.
2. Transition to ACTIVE.
3. Verify `RESUME` job succeeds and tenant authentication works.

## Contract expiry and grace

1. Review the dashboard renewal queue before end date.
2. Create/update the renewal record and follow-up owner.
3. If contractually allowed, set `graceUntil` and move organization/contract to GRACE.
4. Confirm effective modules and seats still reflect the grace window.
5. On renewal, record the new contract and restore ACTIVE.
6. If not renewed, follow the approved suspension/termination procedure.

## Failed job

1. Open `/platform/jobs`; inspect type, payload, attempts, error, provider IDs, and organization state.
2. Correct missing configuration or external provider state.
3. Do not create a duplicate if an idempotency/provider ID exists.
4. Retry the failed job.
5. For a stale RUNNING job, the worker recovers it after 15 minutes.
6. Cancel only when provider side effects are understood.
7. Verify result, deployment/domain/identity state, and audit.

## Dedicated provisioning

Status: **BLOCKED** until the AWS dedicated-environment topology and automation are implemented and verified.

1. Confirm a signed enterprise scope, explicit rollout approval, and named owner.
2. Validate the isolated AWS environment, separate database, IAM role, Secrets Manager, storage, network, backup, and observability plan.
3. Confirm the organization slug and planned custom host.
4. Run migrations, RLS isolation, identity, domain, support, and rollback acceptance in staging-equivalent infrastructure.
5. Queue dedicated provisioning only after the current AWS implementation is merged and verified.
6. Wait for READY; do not manually mark READY while provider state is pending/error.
7. Test organization resolution, login, module enforcement, support access, custom domain, and incident rollback.

## Domain verification failure

1. Show the customer the exact `_devfathom-verification.<host>` TXT name/value.
2. Check public DNS propagation and record quoting/splitting.
3. Retry verification.
4. Inspect `failureReason` and job error.
5. Confirm an approved AWS deployment exists and ingress allows domain attachment.
6. Keep the canonical slug host available.
7. Never mark a domain verified without independent proof and authorization.

## Identity failure

OIDC:

- confirm issuer/discovery URL, client ID/secret, callback URL, scopes, allowed domains, and role mappings;
- run the identity test job;
- verify IdP authorization, token, and JWKS endpoints.

SAML:

- compare generated metadata, entity ID, ACS/callback, IdP SSO URL, issuer, and signing certificate;
- check certificate validity/format, audience, clock skew, and signed assertion.

Before enforcing SSO, preserve an approved recovery path and test login with a non-production account.

## Rotate or revoke SCIM

1. Create a replacement token and copy it once.
2. Update the customer directory and verify a read.
3. Revoke the previous token.
4. Confirm the old token returns 401.
5. Review last-used time and SCIM events.

## Audited support

1. Open the organization record.
2. Enter a specific 10–500 character reason.
3. Select the shortest sufficient duration and start access.
4. Confirm the tenant banner shows actor/reason.
5. Perform only the approved actions.
6. End access immediately.
7. Verify start/launch/action/end evidence in audit.

If the launch fails, do not copy a ticket from logs. End/restart the session after correcting host/deployment/encryption configuration.

## Suspected tenant-isolation incident

1. Declare a security incident and stop affected writes/worker if necessary.
2. Preserve request IDs, audit, DB/provider logs, deployment version, and job evidence.
3. Suspend affected organizations without destroying data.
4. Revoke implicated tenant/API/SCIM/platform/support credentials.
5. Run read-only scope analysis on a restored clone.
6. Run the RLS verifier and inspect policy/composite-FK drift.
7. Coordinate legal/customer notification under policy.
8. Remediate, test against at least two tenants, deploy, and document the post-incident review.

## Export

1. Confirm authority, purpose, scope, and delivery recipient.
2. Verify private Blob integration and retention/expiry policy.
3. Queue `EXPORT_DATA`; monitor to success.
4. Distribute through an approved authenticated channel.
5. Record access and delete the artifact when required.

## Terminate and purge

1. Confirm contract, authorization, retention, and absence of legal hold.
2. Offer/complete required export.
3. Transition to TERMINATED.
4. Set the approved purge schedule.
5. At expiry, transition to PURGING and queue purge.
6. Verify job result/deleted row counts and final PURGED state.
7. Reconcile Blob, email, identity, DNS, AWS, and other provider-held data under policy.

## Restore drill

1. Restore a backup to an isolated database.
2. Deploy the matching application version.
3. Apply pending compatible migrations.
4. Run RLS verification.
5. Verify two organizations, platform login, tenant login, contracts, files, and jobs.
6. Record achieved RPO/RTO and defects.
7. Destroy the isolated copy securely.
