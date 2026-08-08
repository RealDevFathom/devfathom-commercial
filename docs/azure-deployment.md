# Azure deployment

## Architecture and cost posture

DevFathom uses native Azure resources in UAE North:

- `rg-devfathom-shared-uaenorth`: one Basic ACR shared by staging and a later production deployment.
- `rg-devfathom-staging-uaenorth`: Container Apps consumption environment, one scale-to-zero web app (0.5 CPU/1 GiB, max one replica), one manual migration/seed job, PostgreSQL Flexible Server `Standard_B1ms` with 32 GiB and seven-day backups, Key Vault, user-assigned identity, Blob Storage, VNet/private PostgreSQL DNS, Azure OpenAI, and a 30-day Log Analytics workspace capped at 0.1 GiB/day.
- `rg-devfathom-production-uaenorth`: an empty tagged resource-group shell. It contains no billable resources. Production remains isolated from the staging Container Apps environment and database.

ACR Basic and the running staging PostgreSQL server are the main current fixed costs. At the 2026-08-02 UAE North retail rates, PostgreSQL compute is about $14.60/month (`$0.02/hour`), its 32 GiB storage is about $4.42/month (`$0.138/GiB-month`), and ACR Basic is about $5/month. The current fixed baseline is therefore about $24/month before logs and request usage.

The retained production-isolation design adds an estimated fixed baseline of roughly $21/month for the isolated Container Apps load-balancer/public-IP path and roughly $18/month for PostgreSQL, before small services and usage. Production reuses the shared ACR rather than creating a second registry. These are planning estimates, not an invoice or a final price quote. Container Apps compute, Azure OpenAI, Blob, Key Vault, builds, and logs remain usage-based.

Live resource inventory (names intentionally omitted from this documentation):

- Shared: one Basic ACR reused by staging and the planned production environment.
- Staging: one Container App, migration job, isolated Container Apps environment, PostgreSQL server, Key Vault, managed identity, storage account, Azure OpenAI resource, Log Analytics workspace, and VNet.
- Production: only the empty tagged resource-group shell exists. There is no production app, database, Key Vault, storage account, AI resource, DNS record, certificate, or RBAC assignment.

## IaC and first deployment

`shared.bicep` creates the registry. `environment.bicep` creates one isolated environment. Secure parameters enter only through process environment variables and become Key Vault secrets; values are never committed.

```bash
./infra/deploy-staging.sh
./infra/configure-github-oidc.sh
```

The staging script creates only the two `rg-devfathom-*` groups above, builds one `linux/amd64` image, pushes it to ACR, provisions staging, sets the generated Container Apps hostname as a recognized default tenant host, and starts the migration/seed job. Re-running the full script generates new bootstrap credentials; use the GitHub workflow for normal releases.

### Production template status — BLOCKED

The current production template is **not deployable** and must not be run. It has no safe first-tenant/platform-administrator bootstrap, configures `EMAIL_DELIVERY_MODE=send` without production Brevo API/sender wiring, and is paired with a promotion workflow that has no post-deploy health smoke. Production GitHub variables and Azure RBAC are also absent.

Minimal readiness fixes are **IN PROGRESS** in a separate implementation workstream. Keep that status until the fixes are merged, reviewed against the audited main baseline, exercised in staging, and deployed. An approved image digest alone is not a production gate.

## CI/CD and OIDC

`.github/workflows/deploy-staging.yml` authenticates through GitHub Actions OIDC, builds and pushes one immutable `${GITHUB_SHA}` image, updates and waits for the migration/seed job, deploys the same digest, then checks `/api/health`. The Entra service principal has Contributor only on the staging resource group and `AcrPush` only on the shared registry. GitHub stores subscription, tenant, client, resource-group, app, job, and registry IDs as variables; there is no client secret. `infra/configure-github-oidc.sh` reads GitHub's repository-specific OIDC subject prefix, including immutable owner/repository IDs when enabled, before creating or updating the federated credentials.

`.github/workflows/promote-production.yml` is manual, targets the protected `production` environment, accepts only a `sha256:` digest already present in the same ACR, runs production migrations without seed data, then updates production to that exact digest. It currently lacks a post-deploy health smoke. Production resource variables and Azure RBAC are absent, so the workflow is defined but not executable as a safe production promotion.

## Secrets and email

Key Vault contains the database URL, Auth.js secret, platform encryption key, cron bearer, seed password, tenant administrator password, and platform administrator password. Container Apps reads versionless Key Vault references with its managed identity. The same identity has `AcrPull`, `Storage Blob Data Contributor`, `Key Vault Secrets User`, and `Cognitive Services OpenAI User` at resource scope.

Staging sets `EMAIL_DELIVERY_MODE=capture`, has no `BREVO_API_KEY`, and does not require a configured sender. Captures log only the recipient count; recipient addresses, subject, and body are excluded. No message leaves staging. Production sender remains unconfigured. The current template's `EMAIL_DELIVERY_MODE=send` setting is a blocker: send mode must not be enabled until the Brevo API integration, sender domain, and delivery smoke are configured and verified.

## Database migration, RLS, seed, and restore

The manual Container Apps job runs `prisma migrate deploy`; staging then runs the idempotent seed. The current production configuration would run migrations only and leave application tables empty, with no safe first tenant or platform administrator. That is a release blocker, not an acceptable bootstrap path. PostgreSQL is reachable only through the VNet-integrated Container Apps environment. RLS remains migration-owned; never use `prisma db push`.

Verification commands:

```bash
az containerapp job execution list -g rg-devfathom-staging-uaenorth -n devfathom-stg-migrate -o table
bun run test:rls # local test DB, or set ALLOW_REMOTE_RLS_TEST=true intentionally for staging
```

For point-in-time recovery, create a new server rather than overwriting staging:

```bash
az postgres flexible-server restore --resource-group rg-devfathom-staging-uaenorth \
  --name <new-server-name> --source-server <source-resource-id> --restore-time <UTC-ISO-time>
```

Validate the restored database, rotate the `database-url` Key Vault secret, then create a new app revision. Keep the old server until rollback expires.

## Ask Fathom providers

Runtime, diagnostics, and evaluations all call `src/lib/ai/provider.ts`. `AI_PROVIDER` and `AI_MODEL` are the only call-site-neutral selector values. Provider-specific credentials stay inside the factory.

```dotenv
# Azure OpenAI deployment; Entra/managed identity only
AI_PROVIDER=azure
AI_MODEL=ask-fathom-gpt-5-mini
AZURE_OPENAI_RESOURCE_NAME=<resource-name>

# Groq
AI_PROVIDER=groq
AI_MODEL=openai/gpt-oss-120b
GROQ_API_KEY=<secret>

# Google Gemini Developer API
AI_PROVIDER=google
AI_MODEL=gemini-2.5-flash
GOOGLE_GENERATIVE_AI_API_KEY=<secret>

# Vertex AI with Application Default Credentials
AI_PROVIDER=vertex
AI_MODEL=gemini-2.5-flash
GOOGLE_VERTEX_PROJECT=<project>
GOOGLE_VERTEX_LOCATION=global

# Vertex express mode alternative
GOOGLE_VERTEX_API_KEY=<secret>
```

Azure staging uses Global Standard `gpt-5-mini` version `2025-08-07`, deployment `ask-fathom-gpt-5-mini`, capacity 10. `gpt-5.4-mini` was rejected because the subscription reports zero UAE North quota/capacity. The AI SDK's native `tokenProvider` uses `DefaultAzureCredential`; local evals use Azure CLI credentials and Container Apps uses its managed identity. No Azure OpenAI key is enabled.

Run diagnostics and the accuracy/authorization suite against any configured provider:

```bash
bun run assistant:diag -- "List employees"
bun run assistant:eval
```

The eval reports tool calls, authorization/failure behavior, total latency, input tokens, and output tokens. Explicit role-bypass injection may be rejected by Azure Prompt Shield before inference; the annotated security case accepts that provider refusal only while still asserting zero restricted tools and no finance leakage. Streaming, tool selection, six-step runtime cap, approval protocol, and in-tool authorization checks remain unchanged.

## Storage and legacy provider code

Authenticated uploads use private Azure Blob Storage when `AZURE_STORAGE_ACCOUNT_NAME` is set; local development keeps the existing private filesystem fallback. Downloads still enforce tenant session and private-channel membership before reading a blob.

The platform data-export and old dedicated-provisioning paths still import `@vercel/blob` and `@vercel/sdk`. They are disabled legacy code paths, are not part of Azure staging or production guidance, and must not be represented as available Azure operations. Any replacement requires a separate reviewed Azure implementation.

## DNS, custom domains, and rollback

GoDaddy remains authoritative. The staging records are live and both names point directly to the Container App; no Front Door is used. The record shape is shown without generated values:

```text
CNAME  staging              <staging-container-app-fqdn>
TXT    asuid.staging        <azure-verification-value>
CNAME  admin.staging        <staging-container-app-fqdn>
TXT    asuid.admin.staging  <azure-verification-value>
```

Tenant routing uses `staging.devfathom.com`; platform routing uses `admin.staging.devfathom.com`. The planned production app uses one Container App with `www.devfathom.com` for the tenant workspace and `admin.devfathom.com` for the platform control desk. The apex domain remains the existing marketing site. Enterprise subdomains, SSO, and dedicated deployments remain later work.

`meet.devfathom.com` and `turn.devfathom.com` are reserved future media endpoints. They are not live, are not production dependencies for the current app, and must not be presented as deployed.

Rollback application incidents by redeploying the prior healthy ACR digest; do not rebuild it. Inspect revisions and logs first:

```bash
az containerapp revision list -g rg-devfathom-staging-uaenorth -n devfathom-stg -o table
az containerapp logs show -g rg-devfathom-staging-uaenorth -n devfathom-stg --type system --tail 100
az containerapp update -g rg-devfathom-staging-uaenorth -n devfathom-stg --image <prior-digest-uri>
```

Database migrations are forward-only; restore to a new server for a data/schema rollback. Rotate a compromised secret in Key Vault, restart the app revision, and revoke affected sessions/credentials.

## Current status

- Deployment: staging is provisioned in UAE North; its generated Azure hostname is intentionally omitted. App configuration is 0.5 CPU/1 GiB with zero-to-one replicas.
- Public health: `/api/health` returns HTTP 200 with `{"status":"ok"}`. Tenant login and authenticated routes pass desktop and mobile browser smoke QA. Admin-host routing, platform administrator login/session validation, and test-session revocation also pass through the generated endpoint with the forwarded Azure-validated host.
- Database: all 11 Prisma migrations, clean idempotent seed, and tenant RLS isolation check pass on staging.
- Ask Fathom: Azure managed identity calls Global Standard deployment `ask-fathom-gpt-5-mini`; diagnostics pass. Final Azure suite passes 46/46 cases with 856,849 ms aggregate model latency, 459,782 input tokens, and 28,092 output tokens.
- Email: capture-only, no sender/API key, no outbound delivery, and no captured message PII in logs.
- OIDC: main-branch and production-environment federated credentials exist. Staging principal has Contributor only on the staging group and AcrPush only on ACR. GitHub plan rejects required-reviewer configuration, so production remains a manual workflow without an enforceable reviewer until the plan supports protected-environment reviewers.
- DNS/TLS: GoDaddy records are live. `staging.devfathom.com` and `admin.staging.devfathom.com` are bound to the staging Container App with Azure-managed DigiCert certificates and both HTTPS routes return HTTP 200.
- Source baseline: the latest reported audited `main` was commit `89f75459` from PR #24. PR #23 remains the final Meetings Wave-1 schema PR pending rebase and staging verification.
- Production resource shell: the tagged production resource group exists and is empty, with no billable resources.
- Production readiness: minimal fixes are **IN PROGRESS** outside this documentation change. The current template and promotion path remain **BLOCKED** for the bootstrap, email, health-smoke, GitHub-variable, and RBAC gaps above.
- Production services: no app, database, Key Vault, storage, AI, DNS, certificate, or RBAC exists. No production cutover has occurred.
