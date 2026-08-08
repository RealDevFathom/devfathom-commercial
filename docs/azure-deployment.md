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

`shared.bicep` creates the registry. `environment.bicep` creates one isolated environment. Operational secure parameters enter only through process environment variables and become Key Vault secrets; values are never committed. Initialization passwords are temporary Container Apps job secrets and are never available to the web app.

```bash
./infra/deploy-staging.sh
./infra/configure-github-oidc.sh
```

The staging script creates only the two `rg-devfathom-*` groups above, builds one `linux/amd64` image, pushes it to ACR, provisions staging, sets the generated Container Apps hostname as a recognized default tenant host, and starts the migration/seed job. Re-running the full script generates new bootstrap credentials; use the GitHub workflow for normal releases.

## Production deployment status — NOT LIVE

Production-readiness PR #33 is merged to `main` at `ffec57b4`. The merged hardening includes safe create-only bootstrap, capture-mode email, production minimum replicas/probes, and promotion concurrency/health safeguards. The post-merge staging workflow is currently **IN PROGRESS / AWAITING FINAL RESULT**; no production deployment or DNS cutover has occurred.

After final staging approval and explicit cutover authorization, production uses the same Bicep with `infra/production.bicepparam`, `seedDatabase = false`, `bootstrapDatabase = false`, and an approved staging image digest. The first approved deployment instead uses `infra/production.bootstrap.bicepparam`, which requires initial tenant and platform administrator passwords and configures the manual job to run migrations plus the create-only production bootstrap. This is documented procedure only and has not been run.

```bash
az deployment group create -g rg-devfathom-production-uaenorth \
  --parameters infra/production.bootstrap.bicepparam --name production-bootstrap
az containerapp job start -g rg-devfathom-production-uaenorth -n devfathom-prd-migrate
# Wait for a Succeeded execution before continuing.
az containerapp job execution list -g rg-devfathom-production-uaenorth \
  -n devfathom-prd-migrate -o table
az deployment group create -g rg-devfathom-production-uaenorth \
  --parameters infra/production.bicepparam --name production
```

After that regular redeployment, verify that the job retains only its operational `database-url` secret. If the Container Apps resource provider still reports any initialization secret, remove it explicitly after confirming no job environment variable references it:

```bash
az containerapp job secret list -g rg-devfathom-production-uaenorth -n devfathom-prd-migrate -o table
az containerapp job secret remove -g rg-devfathom-production-uaenorth -n devfathom-prd-migrate \
  --secret-names admin-password platform-admin-password --yes
```

Unset the initialization password environment variables after verification. Routine production deployments and promotions do not read or require them.

## CI/CD and OIDC

`.github/workflows/deploy-staging.yml` authenticates through GitHub Actions OIDC, builds and pushes one immutable `${GITHUB_SHA}` image, updates and waits for the migration/seed job, deploys the same digest, then checks `/api/health`. The Entra service principal has Contributor only on the staging resource group and `AcrPush` only on the shared registry. GitHub stores subscription, tenant, client, resource-group, app, job, and registry IDs as variables; there is no client secret. `infra/configure-github-oidc.sh` reads GitHub's repository-specific OIDC subject prefix, including immutable owner/repository IDs when enabled, before creating or updating the federated credentials.

`.github/workflows/promote-production.yml` is manual, targets the protected `production` environment, accepts only a validated `sha256:` digest already present in the same ACR, refuses an initialization-configured migration job, runs production migrations without seed data, then updates production to that exact digest. It confirms the ready active revision uses the requested digest before checking `/api/health`. Production identity and GitHub environment configuration exist, but no production resources or DNS cutover exist.

## Secrets and email

Key Vault contains the database URL, Auth.js secret, platform encryption key, and cron bearer. Container Apps reads versionless Key Vault references with its managed identity. One-time seed/bootstrap passwords are job-local secrets supplied only when initialization is explicitly enabled; the always-on web app has neither those secrets nor their environment variables. The same identity has `AcrPull`, `Storage Blob Data Contributor`, `Key Vault Secrets User`, and `Cognitive Services OpenAI User` at resource scope.

Staging and production set `EMAIL_DELIVERY_MODE=capture`, have no `BREVO_API_KEY`, and do not require a configured sender. Captures log only the recipient count; recipient addresses, subject, and body are excluded. No message leaves either environment. Production must remain in capture mode until Brevo Key Vault wiring, DNS, and sender verification are complete.

## Database migration, RLS, seed, and restore

The manual Container Apps job runs `prisma migrate deploy`; staging then runs the idempotent demo seed. The explicit one-time production initialization path instead follows migrations with a create-only bootstrap for the platform catalog, default organization, system roles and permission, brand, deployment, tenant administrator, and platform administrator. It creates no demo users, projects, invoices, or meetings. Regular production configuration and every promotion run migrations only. PostgreSQL is reachable only through the VNet-integrated Container Apps environment. RLS remains migration-owned; never use `prisma db push`.

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
- Database: all 12 Prisma migrations, clean idempotent seed, and tenant RLS isolation check pass on staging.
- Ask Fathom: Azure managed identity calls Global Standard deployment `ask-fathom-gpt-5-mini`; diagnostics pass. Final Azure suite passes 46/46 cases with 856,849 ms aggregate model latency, 459,782 input tokens, and 28,092 output tokens.
- Email: capture-only, no sender/API key, no outbound delivery, and no captured message PII in logs.
- OIDC: main-branch and production-environment federated credentials exist. Staging principal has Contributor only on the staging group and AcrPush only on ACR. GitHub plan rejects required-reviewer configuration, so production remains a manual workflow without an enforceable reviewer until the plan supports protected-environment reviewers.
- DNS/TLS: GoDaddy records are live. `staging.devfathom.com` and `admin.staging.devfathom.com` are bound to the staging Container App with Azure-managed DigiCert certificates and both HTTPS routes return HTTP 200.
- Source baseline: current `main` is `ffec57b4` after production-readiness PR #33 merged. Meetings PR #23 is merged and its schema/reconciliation work is staging-verified.
- Production resource shell: the tagged production resource group exists and is empty, with no billable resources.
- Post-merge staging: the production-readiness validation workflow is **IN PROGRESS / AWAITING FINAL RESULT**.
- Production services: no app, database, Key Vault, storage, AI, secret, deployment, DNS, certificate, or billable resource exists. `www.devfathom.com` still serves or redirects to the existing GoDaddy marketing site; `admin.devfathom.com` is absent. No production cutover has occurred.
