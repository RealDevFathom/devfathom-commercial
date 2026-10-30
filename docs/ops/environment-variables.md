# Environment variables

> **Names and purposes only. Never put values in this file, in PRs or in chat.**
> Names come from `.env.example`, the code (`process.env.*` in `src/`, `prisma/`) and the ECS task definitions in `infra/aws/environment.yaml` on `origin/main` 6e425380. No value, hostname, account ID or ARN is copied here.

**Audience:** engineers, ops and security reviewers.
**Related:** [AWS staging](aws-staging.md) · [Runbook](runbook.md) · [Security overview](security-overview.md) · [Local setup](../LOCAL_SETUP.md)

---

## Database

| Name | Purpose |
|---|---|
| `DATABASE_URL` | The connection the **running app** uses. It must be the restricted app login (not `SUPERUSER`, not `BYPASSRLS`); a production process refuses to start otherwise. In the AWS **migration task** the same name holds the admin connection. |
| `APP_DATABASE_URL` | Migration task only: names the app login that `prisma/prepare-runtime-role.ts` provisions and supplies its password. The script validates the URL's username and target, not app-login authentication. Must be the same server and database as `DATABASE_URL`. |
| `MIGRATION_DATABASE_URL` | Local: the role Prisma CLI and the seed use for migrations. Falls back to `DATABASE_URL`. |
| `SHADOW_DATABASE_URL` | Local: Prisma's shadow database for `migrate dev`. |
| `EXTENSION_ADMIN_DATABASE_URL` | Used only by `prisma/prepare-extensions.ts`; must be a superuser or extension owner. |
| `TEST_DATABASE_URL` | Enables the database-backed test suites and `test:rls`. Disposable databases only. |

## Auth, URLs and tenancy

| Name | Purpose |
|---|---|
| `AUTH_SECRET` | Session signing secret (next-auth) |
| `AUTH_URL`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | The app's public base URL. `NEXT_PUBLIC_APP_URL` is inlined at build time (a build argument). |
| `AUTH_TRUST_HOST` | Set on AWS so next-auth trusts the load balancer's host header |
| `PLATFORM_BASE_DOMAIN` | Base domain for tenant subdomains and the platform console |
| `SHARED_APP_HOSTS` | Hosts that are not tenant subdomains |
| `DEFAULT_ORGANIZATION_ID` | The default organization for local single-tenant use |
| `PLATFORM_ENCRYPTION_KEY` | Encrypts stored secrets such as MFA and SSO data. **Losing it makes that data unrecoverable.** |
| `RATE_LIMIT_HMAC_SECRET` | Keys the rate-limit buckets; falls back to `AUTH_SECRET`. Production refuses to start if both are unset. |
| `CLIENT_IP_HEADER`, `TRUSTED_PROXY_CIDRS`, `TRUSTED_PROXY_HOPS` | How to find the real client address behind proxies. Production refuses to start unless one is set; AWS sets `TRUSTED_PROXY_HOPS`. |

## Initial accounts (seed and bootstrap only)

`SEED_PASSWORD`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_TITLE`, `ADMIN_DEPARTMENT`, `DEMO_ACCESS_CODE`, `DEMO_SEATS`. On AWS the password secrets reach only the migration task, and only in `seed` or `bootstrap` mode.

## Jobs and integrations

| Name | Purpose |
|---|---|
| `CRON_SECRET` | Bearer secret for `/api/platform/jobs/process` and the `/api/cron/*` and WhatsApp reminder routes |
| `ABLY_API_KEY` | Realtime (server key used to mint client tokens at `/api/ably-token`) |
| `STORAGE_ADAPTER`, `S3_UPLOADS_BUCKET` | File storage (`s3` on AWS; `local` only in dev and test). `AZURE_STORAGE_ACCOUNT_NAME` and `AZURE_STORAGE_CONTAINER` are the DEPRECATED Azure adapter. |
| `EMAIL_DELIVERY_MODE`, `EMAIL_CAPTURE_FILE`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `EMAIL_LOGO_URL` | Outbound email. Staging stays in capture mode, so nothing is sent. `RESEND_API_KEY` and `EMAIL_SERVER_HOST` are also in `.env.example`. TODO(confirm): whether they are still used. |
| `EMAIL_TOKEN_ENC_KEY`, `GOOGLE_OAUTH_*`, `MS_OAUTH_*` | Connecting users' Gmail and Outlook mailboxes (agency Email) |
| `CAMERA_CREDENTIAL_KEY` | Encrypts stored camera credentials |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL` | Meetings. Not ported to AWS yet. |
| `RESTAURANT_TERMINAL_WEBHOOK_SECRET` | Verifies restaurant terminal payment webhooks |
| `AI_PROVIDER`, `AI_MODEL`, and the provider keys in `.env.example` (`GOOGLE_*`, `GROQ_API_KEY`, `AZURE_OPENAI_RESOURCE_NAME`) | Assistant and AI features. AI is disabled on AWS staging. |

## AWS deploy only

| Name | Purpose |
|---|---|
| `IMAGE_TAG` | CodeBuild: the full 40-character commit SHA. The build fails otherwise. |
| `ECR_REPOSITORY_URI` | CodeBuild: where the image is pushed (set by the stack) |
| `DEPLOY_ENV`, `STAGING_DB_ENDPOINT` | Guard rails that let `scripts/seed-staging-demo.ts` run only against the staging database |
| `AWS_REGION` | Region for the app's AWS SDK calls |

The `VERCEL_*`, `BLOB_READ_WRITE_TOKEN` and `EDGE_CONFIG` entries in `.env.example` belong to the old Vercel setup. TODO(confirm): whether they can be removed.

## Where values live

| Context | Where values come from |
|---|---|
| Local development | Your own `.env.local`, copied from `.env.example`. Never commit it. See [LOCAL_SETUP.md](../LOCAL_SETUP.md). |
| AWS staging | **Secrets Manager** under `devfathom/<env>/…`, generated when the stack is created and injected into the ECS task definitions. Non-secret settings are plain task-definition environment variables. |
| CI (`qa.yml`) | Throwaway `postgres:16` service containers with CI-only test settings |

## Rules

- Write names only. No values, partial values, example passwords, hostnames or account IDs.
- Don't paste connection strings anywhere, including issues, PRs, chat and logs.
- Adding a variable: add the name to `.env.example` with a placeholder, add a row here, wire it in `infra/aws/environment.yaml` if AWS needs it, and note it in the PR.
- Run gitleaks locally before every push. There is no CI secrets scan.
