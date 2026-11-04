# Azure deployment

## Architecture and cost posture

DevFathom uses native Azure resources in UAE North:

- `rg-devfathom-shared-uaenorth`: one Basic ACR shared by staging and a later production deployment.
- `rg-devfathom-staging-uaenorth`: Container Apps consumption environment, one scale-to-zero web app (0.5 CPU/1 GiB, max one replica), one manual migration/seed job, PostgreSQL Flexible Server `Standard_B1ms` with 32 GiB and seven-day backups, Key Vault, user-assigned identity, Blob Storage, VNet/private PostgreSQL DNS, Azure OpenAI, and a 30-day Log Analytics workspace capped at 0.1 GiB/day.
- `rg-devfathom-production-uaenorth`: isolated production Container Apps, migration, database, and supporting resources. Production remains isolated from the staging Container Apps environment and database; public custom domains are not attached.

ACR Basic and the running staging PostgreSQL server are the main current fixed costs. At the 2026-08-02 UAE North retail rates, PostgreSQL compute is about $14.60/month (`$0.02/hour`), its 32 GiB storage is about $4.42/month (`$0.138/GiB-month`), and ACR Basic is about $5/month. The current fixed baseline is therefore about $24/month before logs and request usage.

The retained production-isolation design adds an estimated fixed baseline of roughly $21/month for the isolated Container Apps load-balancer/public-IP path and roughly $18/month for PostgreSQL, before small services and usage. Production reuses the shared ACR rather than creating a second registry. These are planning estimates, not an invoice or a final price quote. Container Apps compute, Azure OpenAI, Blob, Key Vault, builds, and logs remain usage-based.

Live resource inventory (names intentionally omitted from this documentation):

- Shared: one Basic ACR reused by staging and the planned production environment.
- Staging: one Container App, migration job, isolated Container Apps environment, PostgreSQL server, Key Vault, managed identity, storage account, Azure OpenAI resource, Log Analytics workspace, and VNet.
- Production: isolated resources are provisioned and the approved `ffec57b4` build is deployed. One-time migration/bootstrap and a second credential-free migration succeeded. The production app is dark behind its Azure FQDN; public custom domains are not attached, and `www.devfathom.com` remains the existing marketing site.

## IaC and first deployment

`shared.bicep` creates the registry. `environment.bicep` creates one isolated environment. Operational secure parameters enter only through process environment variables and become Key Vault secrets; values are never committed. Key Vault is also the canonical source for the seed, tenant administrator, and platform administrator passwords. Only the migration job receives versionless Key Vault references for those initialization credentials; the web app never receives them.

> **Staging full deployment is review-gated (DEV-341).** Staging has known, unreviewed IaC drift. A full
> `az deployment group create` would apply every outstanding what-if change at once. `infra/deploy-staging.sh`
> now refuses, before any Azure command, unless an authorized operator has reviewed the current what-if and
> recorded an approval bound to the exact infrastructure files. That review is still outstanding. Follow
> [`docs/operations/staging-iac-drift-review.md`](operations/staging-iac-drift-review.md). Do not bypass it.

```bash
./infra/configure-github-oidc.sh
```

After the review procedure, an authorized operator runs `./infra/deploy-staging.sh` from the repository root.
The staging script creates only the two `rg-devfathom-*` groups above, builds one `linux/amd64` image, pushes it to ACR, provisions staging, sets the generated Container Apps hostname as a recognized default tenant host, and starts the migration/seed job. It discovers the environment Key Vault independently of deployment history, generates only confirmed-missing initialization credentials, and explicitly authorizes those writes. Existing Key Vault values always win. A lookup error or ambiguous vault match aborts without deployment. Use this guarded script for bootstrap; use the GitHub workflow for normal releases.

## Production deployment status — DARK / NOT PUBLICLY CUT OVER

Production-readiness PR #33 is merged to `main` at `ffec57b4`. The merged hardening includes safe create-only bootstrap, capture-mode email, production minimum replicas/probes, and promotion concurrency/health safeguards. The latest staging run passed build, migration/seed, deploy, and smoke in 7m40s; opaque run and image values are intentionally omitted.

The approved `ffec57b4` build is provisioned in isolated production. The one-time bootstrap succeeded, regular production parameters were redeployed, and a second credential-free migration succeeded. Production bootstrap must run through `./infra/deploy-production-bootstrap.sh`. The wrapper independently discovers the production Key Vault, generates only confirmed-missing administrator credentials, and explicitly authorizes only those writes. Existing Key Vault values always win; inherited initialization variables are ignored. A lookup error or ambiguous vault match aborts without deployment. Routine production deployments remain credential-free and configure the job for migrations only. Initial credential values are not documented.

```bash
./infra/deploy-production-bootstrap.sh
az containerapp job start -g rg-devfathom-production-uaenorth -n devfathom-prd-migrate
# Wait for a Succeeded execution before continuing.
az containerapp job execution list -g rg-devfathom-production-uaenorth \
  -n devfathom-prd-migrate -o table
az deployment group create -g rg-devfathom-production-uaenorth \
  --parameters infra/production.bicepparam --name production
```

Direct use of bootstrap parameter files is unsupported: their write gate defaults false, so stale credential environment variables cannot overwrite Key Vault. Guarded scripts enable the gate only after proving a vault or individual secret is missing. Later bootstrap runs resolve existing versionless Key Vault references; routine production deployments and promotions do not read or require initialization credentials.

## CI/CD and OIDC

`.github/workflows/deploy-staging.yml` authenticates through GitHub Actions OIDC, builds and pushes one immutable `${GITHUB_SHA}` image, updates and waits for the migration/seed job, deploys the same digest, then checks `/api/health`. The Entra service principal has Contributor only on the staging resource group and `AcrPush` only on the shared registry. GitHub stores subscription, tenant, client, resource-group, app, job, and registry IDs as variables; there is no client secret. `infra/configure-github-oidc.sh` reads GitHub's repository-specific OIDC subject prefix, including immutable owner/repository IDs when enabled, before creating or updating the federated credentials.

`.github/workflows/promote-production.yml` is manual, targets the protected `production` environment, accepts only a validated `sha256:` digest already present in the same ACR, refuses an initialization-configured migration job, runs production migrations without seed data, then updates production to that exact digest. It confirms the ready active revision uses the requested digest before checking `/api/health`. The approved production app has minimum one replica and its dark Azure FQDN `/api/health` returns OK; public custom domains remain unattached.
The staging workflow passed immutable image build, migration/seed, deployment, and smoke stages in 7m40s. Staging and production use the approved `ffec57b4` build; image digests, revision names, and workflow-run identifiers are intentionally omitted here.

The GitHub production environment has the seven required Azure variables and a custom deployment branch policy allowing only `main`.

Authentication is through a separate production-only Entra/GitHub OIDC service principal with no client secret. It has Contributor only on the production resource group and Reader plus `AcrPull` on the shared ACR; it has no staging role. No identifier or variable value belongs in this documentation. The production deployment has passed its dark-host health check, but public DNS/custom-domain cutover remains **BLOCKED** pending explicit release approval.

Repository mismatch: `infra/configure-github-oidc.sh` still models staging and production federation on one principal and disables custom deployment branch policies. It does not reproduce the current production identity or `main`-only policy and must be treated as **PARTIAL/BLOCKED** for production until the separate implementation workstream reconciles it.

## Secrets and email

The staging Key Vault contains the database URL, Auth.js secret, platform encryption key, cron bearer, seed password, tenant administrator password, and platform administrator password. Key Vault remains the single source of truth for initialization credentials. The migration job reads them through versionless Key Vault references with its managed identity; the Container App does not receive them. That identity has `AcrPull`, `Storage Blob Data Contributor`, `Key Vault Secrets User`, and `Cognitive Services OpenAI User` at resource scope. Production secret values are not copied into documentation; routine migration-only job configuration omits initialization secret references.

Staging and production set `EMAIL_DELIVERY_MODE=capture`, have no `BREVO_API_KEY`, and do not require a configured sender. Captures log only the recipient count; recipient addresses, subject, and body are excluded. No message leaves either environment. Production must remain in capture mode until Brevo Key Vault wiring, DNS, and sender verification are complete.

## Database migration, RLS, seed, and restore

The manual Container Apps job runs `prisma migrate deploy`; staging then runs the idempotent demo seed. The explicit one-time production initialization path instead follows migrations with a create-only bootstrap for the platform catalog, default organization, system roles and permission, brand, deployment, tenant administrator, and platform administrator. It creates no demo users, projects, invoices, or meetings. Regular production configuration and every promotion run migrations only. PostgreSQL is reachable only through the VNet-integrated Container Apps environment. RLS remains migration-owned; never use `prisma db push`.
Azure PostgreSQL's `azure.extensions` allow-list must cover every extension created by migrations and `prisma/prepare-extensions.sql`.
Both staging and production currently require `btree_gist` and `pg_trgm`; update the IaC and preparation step together when that set changes.

Runtime-role preparation omits `SUPERUSER` and `BYPASSRLS` attributes because PostgreSQL 16/Azure Flexible Server non-superuser admins cannot alter them.
Any pre-existing privileged runtime role fails the post-condition assertion and must not be repaired automatically.

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

`staging.devfathom.com` **is** the shared application host: it is the apex of the
configured `PLATFORM_BASE_DOMAIN`, which is what the `shared` host classification
matches. Standard tenants sign in there with no workspace slug in the URL, choose
a workspace when they belong to more than one, and remain on that host afterwards
— the organization travels in the session. Production uses `www.devfathom.com`
under `PLATFORM_BASE_DOMAIN=devfathom.com` by the same rule.

`AUTH_URL` and `NEXT_PUBLIC_APP_URL` must therefore be set to the shared host so
reset and invite links land there. Both feed `configuredDefaultHosts()`; the
shared classification short-circuits the `DEFAULT_ORGANIZATION_ID` fallback before
it can apply, which is what stops every shared-host login silently authenticating
against one organization. Do not retune `PLATFORM_BASE_DOMAIN` — it also derives
the admin host.

Enterprise subdomains, SSO, and dedicated deployments keep their own hosts and are
unaffected; enterprise SSO runs only on those hosts because its redirect URI and
audience are registered against them.

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
- OIDC/RBAC: staging and production use separate service principals. The production-only principal has Contributor only on the production resource group and Reader plus `AcrPull` on the shared ACR, with no staging role and no client secret.
- GitHub production environment: seven required Azure variables are configured, and the custom deployment branch policy allows only `main`. No values are recorded here.
- Configuration drift: the repository OIDC helper does not yet reproduce the separate production principal or `main`-only policy. Do not treat that helper as production-ready.
- DNS/TLS: GoDaddy records are live. `staging.devfathom.com` and `admin.staging.devfathom.com` are bound to the staging Container App with Azure-managed DigiCert certificates and both HTTPS routes return HTTP 200.
- Source baseline: current `main` is `ffec57b4` after production-readiness PR #33 merged. Meetings PR #23 is merged and its schema/reconciliation work is staging-verified.
- Production resources: isolated production resources are provisioned in the tagged resource group; the approved `ffec57b4` build is deployed with minimum one replica, one-time bootstrap and two migrations succeeded, and the dark Azure FQDN `/api/health` check is OK.
- Production configuration: the regular migration job is migration-only with only operational database references; initialization environment and secret references are absent. Canonical administrator credentials remain in Key Vault for explicit bootstrap reuse.
- Production public access: `admin.devfathom.com` remains DNS-unconfigured, `www.devfathom.com` still serves or redirects to the existing GoDaddy marketing site, and no public custom domain is attached. Production is **DARK / NOT PUBLICLY CUT OVER**.
