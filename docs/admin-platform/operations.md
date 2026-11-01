# Azure Deployment and Operations

Azure is the current deployment platform. Provider-specific deployment records elsewhere are retained as legacy implementation evidence only, not deployment procedure.

## Process model

Web/API runs on Next.js Node.js in an Azure Container App. PostgreSQL is the durable source of truth. Platform jobs are durable database records processed by:

- an operator-triggered `POST /api/platform/jobs/process` request when a bearer secret is configured; or
- CLI: `bun run platform:jobs -- --max-jobs=<n>`.

The route requires `CRON_SECRET`. An Azure scheduler/recurring trigger is a production gate; do not claim five-minute processing until that trigger exists and is verified. The worker claims jobs with `FOR UPDATE SKIP LOCKED`, recovers 15-minute stale leases, increments attempts, and uses exponential backoff capped at 30 minutes.

`POST /api/cron/outbound-effects` drains every organization's pending outbox so a retry does not wait for that organization's next enqueue. Send `Authorization: Bearer <CRON_SECRET>`. The comparison is constant-time, and a missing or mismatched secret returns 401. Retries start at 30 seconds. Staging calls this route every minute from an EventBridge Scheduler, and `CRON_SECRET` is kept in Secrets Manager. That wiring will be added in the infra/aws pull request #110. A claim left in `PROCESSING` returns to the queue after 5 minutes. Dead-lettered email rows drop the recipient email, name, and HTML. Delivered and dead-lettered rows are deleted after 7 days.

## Job types

| Type                  | Behavior                                                 | Required external configuration            |
| --------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `PROVISION_SHARED`    | records/updates shared deployment state                  | Azure environment and approved base domain |
| `PROVISION_DEDICATED` | records a contracted dedicated deployment and polls      | approved Azure resources and rollout       |
| `CONFIGURE_DOMAIN`    | verifies TXT and attaches domain to the deployment       | DNS and Azure ingress                      |
| `APPLY_BRAND`         | records deterministic brand version in deployment health | none                                       |
| `SYNC_IDENTITY`       | validates OIDC discovery or SAML configuration           | reachable IdP metadata                     |
| `EXPORT_DATA`         | writes private JSON snapshot                             | `BLOB_READ_WRITE_TOKEN`                    |
| `PURGE_DATA`          | retention-gated tenant-row deletion                      | approved lifecycle state/time              |
| `SUSPEND` / `RESUME`  | deployment availability and support revocation           | none                                       |

Jobs are idempotency-keyed where commands can be retried. Operators can inspect payload/result/error, retry failed jobs, or cancel queued/running work.

## Shared deployment

Shared is the default. The worker records:

- provider `AZURE`;
- production environment;
- shared mode;
- project ID/region when configured;
- canonical `https://<slug>.<base-domain>` (HTTP for localhost);
- current commit/local version;
- READY/health timestamps.

All organizations share application compute and PostgreSQL while RLS isolates data.

## Dedicated deployment (enterprise gate)

Dedicated environments are not part of the current staging deployment. Define the Azure resource topology, tenant isolation proof, domain/SSO rollout, backup policy, and owner approval before implementing or advertising an enterprise environment. No dedicated production environment is currently verified.

## Configuration reference

Use `.env.example` as the machine-copyable template.

### Required runtime

| Variable                           | Sensitive | Purpose                                                                                 |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     | yes       | PostgreSQL application connection. Production requires `NOSUPERUSER` and `NOBYPASSRLS`. |
| `MIGRATION_DATABASE_URL`           | yes       | Migrations, extensions, and seed. The running server does not use this URL.             |
| `AUTH_SECRET`                      | yes       | Auth.js JWT encryption/signing secret                                                   |
| `AUTH_URL` / `NEXT_PUBLIC_APP_URL` | no        | canonical application URL — set to the SHARED host so reset and invite links land there |
| `PLATFORM_BASE_DOMAIN`             | no        | base domain; admin host is `admin.<value>`                                              |
| `SHARED_APP_HOSTS`                 | no        | optional comma-separated shared hosts that follow no reserved-label rule                |
| `PLATFORM_ENCRYPTION_KEY`          | yes       | encrypt SSO/email/MFA/support secrets                                                   |
| `CAMERA_CREDENTIAL_KEY`            | yes       | encrypt Restaurant camera credentials; must be a base64-encoded 32-byte key             |
| `CRON_SECRET`                      | yes       | bearer for the job worker and `POST /api/cron/outbound-effects`                         |
| `DEFAULT_ORGANIZATION_ID`          | no        | local/default-host tenant — see the warning below                                       |

> **`DEFAULT_ORGANIZATION_ID` is dangerous once a shared host exists.** It is a
> local-development convenience: any host in `configuredDefaultHosts()` that
> resolves no organization falls back to it. `configuredDefaultHosts()` is built
> from `NEXT_PUBLIC_APP_URL`, `AUTH_URL`, `VERCEL_URL` and `PLATFORM_BASE_DOMAIN`
> — and `AUTH_URL`/`NEXT_PUBLIC_APP_URL` must point at the shared host. Without
> the `shared` host classification short-circuiting that fallback, every
> shared-host login would silently authenticate against this organization instead
> of erroring. Do not remove the short-circuit, and do not add a production host
> here expecting the fallback to be harmless.

> **Do not retune `PLATFORM_BASE_DOMAIN` to point at the shared host.** It
> simultaneously derives the admin host (`admin.<value>`), feeds
> `configuredDefaultHosts()`, sets the `df_support_session` cookie domain, and is
> re-derived independently in `src/proxy.ts`. Changing it relocates the admin host
> and locks platform operators out.

### Bootstrap/seed only

`PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_DEPARTMENT`, `ADMIN_TITLE`, and `SEED_PASSWORD`. Do not retain bootstrap passwords in deployment config after controlled initialization unless the script is intentionally rerunnable.

### Optional integrations

- private files/exports: `BLOB_READ_WRITE_TOKEN`;
- realtime: `ABLY_API_KEY`;
- email: `RESEND_API_KEY`, `BREVO_*`, `EMAIL_*`;
- Edge Config: `EDGE_CONFIG`;
- Google/Microsoft: OAuth variables in `.env.example`;
- AI: `GROQ_MODEL`, `GEMINI_MODEL` plus provider credentials already used by the app;
- meetings: `NEXT_PUBLIC_JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY`.

## Observability

Operational evidence is available in:

- platform overview status cards;
- deployments and health JSON;
- jobs with attempts/result/error/timestamps;
- lifecycle events;
- platform audit ledger;
- tenant audit and SCIM events;
- provider deployment logs.

Azure platform logs are available in staging through capped Log Analytics. Application error tracking, request metrics, and production alerting are not implemented; add and verify them before production launch.

## Backup and recovery

Staging currently has managed PostgreSQL backups with seven-day retention. Before production:

1. enable managed PostgreSQL point-in-time recovery;
2. define RPO/RTO;
3. back up Blob/export objects according to classification;
4. restore into an isolated environment;
5. run migrations and RLS verification on the restored copy;
6. validate at least two organizations, login, files, contracts, and jobs;
7. record drill time and evidence.

## Secret rotation

Rotate platform/bootstrap passwords, `AUTH_SECRET`, cron secret, Blob token, email keys, SCIM tokens, IdP client secrets/certificates, and `PLATFORM_ENCRYPTION_KEY` under a documented schedule.

Changing the encryption key without re-encrypting stored ciphertext makes encrypted values unreadable. Use an expand/rotate/reencrypt/retire procedure before production key rotation.
