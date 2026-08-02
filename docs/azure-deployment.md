# Azure deployment

## Architecture and cost posture

DevFathom uses native Azure resources in UAE North:

- `rg-devfathom-shared-uaenorth`: one Basic ACR shared by staging and a later production deployment.
- `rg-devfathom-staging-uaenorth`: Container Apps consumption environment, one scale-to-zero web app (0.5 CPU/1 GiB, max one replica), one manual migration/seed job, PostgreSQL Flexible Server `Standard_B1ms` with 32 GiB and seven-day backups, Key Vault, user-assigned identity, Blob Storage, VNet/private PostgreSQL DNS, Azure OpenAI, and a 30-day Log Analytics workspace capped at 0.1 GiB/day.
- `rg-devfathom-production-uaenorth`: defined by `production.bicepparam`; it does not exist and must not be deployed before explicit cutover approval.

ACR Basic and the running PostgreSQL server are the main fixed costs. At the 2026-08-02 UAE North retail rates, PostgreSQL compute is about $14.60/month (`$0.02/hour`), its 32 GiB storage is about $4.42/month (`$0.138/GiB-month`), and ACR Basic is about $5/month. Fixed baseline is therefore about $24/month before logs and request usage. Container Apps scales to zero; Azure OpenAI, Blob, Key Vault, ACR builds, and logs are usage-based. PostgreSQL has no public endpoint or open firewall rule. Front Door, Redis, NAT Gateway, HA, geo-backups, dedicated Container Apps compute, and a second registry are intentionally absent.

Live resource inventory:

- Shared: ACR `dfacrrz2qg5k5ucouy` in `rg-devfathom-shared-uaenorth`.
- Staging: Container App `devfathom-stg`, migration job `devfathom-stg-migrate`, environment `df-stg-7azfl6tid4bb4-cae`, PostgreSQL `df-stg-7azfl6tid4bb4-pg`, Key Vault `df-stg-7azfl6tid4bb4-kv`, identity `df-stg-7azfl6tid4bb4-id`, storage `dfstg7azfl6tid4bb4st`, Azure OpenAI `df-stg-7azfl6tid4bb4-ai`, Log Analytics `df-stg-7azfl6tid4bb4-logs`, and VNet `df-stg-vnet` in `rg-devfathom-staging-uaenorth`.

## IaC and first deployment

`shared.bicep` creates the registry. `environment.bicep` creates one isolated environment. Secure parameters enter only through process environment variables and become Key Vault secrets; values are never committed.

```bash
./infra/deploy-staging.sh
./infra/configure-github-oidc.sh
```

The staging script creates only the two `rg-devfathom-*` groups above, builds one `linux/amd64` image, pushes it to ACR, provisions staging, sets the generated Container Apps hostname as a recognized default tenant host, and starts the migration/seed job. Re-running the full script generates new bootstrap credentials; use the GitHub workflow for normal releases.

Production uses the same Bicep with `infra/production.bicepparam`, `seedDatabase = false`, and an approved staging image digest. Never run it until cutover is explicitly initiated.

## CI/CD and OIDC

`.github/workflows/deploy-staging.yml` authenticates through GitHub Actions OIDC, builds and pushes one immutable `${GITHUB_SHA}` image, updates and waits for the migration/seed job, deploys the same digest, then checks `/api/health`. The Entra service principal has Contributor only on the staging resource group and `AcrPush` only on the shared registry. GitHub stores subscription, tenant, client, resource-group, app, job, and registry IDs as variables; there is no client secret. `infra/configure-github-oidc.sh` reads GitHub's repository-specific OIDC subject prefix, including immutable owner/repository IDs when enabled, before creating or updating the federated credentials.

`.github/workflows/promote-production.yml` is manual, targets the protected `production` environment, accepts only a `sha256:` digest already present in the same ACR, runs production migrations without seed data, then updates production to that exact digest. Production resource variables and Azure RBAC are deliberately absent until cutover.

## Secrets and email

Key Vault contains the database URL, Auth.js secret, platform encryption key, cron bearer, seed password, tenant administrator password, and platform administrator password. Container Apps reads versionless Key Vault references with its managed identity. The same identity has `AcrPull`, `Storage Blob Data Contributor`, `Key Vault Secrets User`, and `Cognitive Services OpenAI User` at resource scope.

Staging sets `EMAIL_DELIVERY_MODE=capture`, has no `BREVO_API_KEY`, and does not require a configured sender. Captures log only the recipient count; recipient addresses, subject, and body are excluded. No message leaves staging. Production sender remains unconfigured and must use `EMAIL_DELIVERY_MODE=send` only after Brevo DNS and sender verification pass.

## Database migration, RLS, seed, and restore

The manual Container Apps job runs `prisma migrate deploy`; staging then runs the idempotent seed. Production configuration runs migrations only, leaving application tables empty. PostgreSQL is reachable only through the VNet-integrated Container Apps environment. RLS remains migration-owned; never use `prisma db push`.

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

## Storage and Vercel-only paths

Authenticated uploads use private Azure Blob Storage when `AZURE_STORAGE_ACCOUNT_NAME` is set; local development keeps the existing private filesystem fallback. Downloads still enforce tenant session and private-channel membership before reading a blob.

The platform data-export job still uses `@vercel/blob` and Vercel provisioning jobs still use `@vercel/sdk`. They are not required by staging deployment or smoke QA and remain disabled because staging has neither `BLOB_READ_WRITE_TOKEN` nor Vercel credentials. Migrate those jobs only when platform export or dedicated Vercel provisioning is explicitly brought into Azure scope.

## DNS, custom domains, and rollback

GoDaddy remains authoritative. It has not been changed. Add these Azure-generated records when ready; both names point directly to the Container App and no Front Door is used:

```text
CNAME  staging              devfathom-stg.bravewater-2487da89.uaenorth.azurecontainerapps.io
TXT    asuid.staging        108E74DBE11F6BAD0E9150B33EBDD2EA0EE3CC8939F1C951D2B253D49109D667
CNAME  admin.staging        devfathom-stg.bravewater-2487da89.uaenorth.azurecontainerapps.io
TXT    asuid.admin.staging  108E74DBE11F6BAD0E9150B33EBDD2EA0EE3CC8939F1C951D2B253D49109D667
```

After DNS resolves, add both Container Apps hostnames and free managed certificates. Tenant routing uses `staging.devfathom.com`; platform routing uses `admin.staging.devfathom.com`. Standard production tenants later use `www.devfathom.com` plus organization selection in session. Enterprise subdomains, SSO, and dedicated deployments remain later work.

Rollback application incidents by redeploying the prior healthy ACR digest; do not rebuild it. Inspect revisions and logs first:

```bash
az containerapp revision list -g rg-devfathom-staging-uaenorth -n devfathom-stg -o table
az containerapp logs show -g rg-devfathom-staging-uaenorth -n devfathom-stg --type system --tail 100
az containerapp update -g rg-devfathom-staging-uaenorth -n devfathom-stg --image <prior-digest-uri>
```

Database migrations are forward-only; restore to a new server for a data/schema rollback. Rotate a compromised secret in Key Vault, restart the app revision, and revoke affected sessions/credentials.

## Current status

- Deployment: staging is provisioned in UAE North at `https://devfathom-stg.bravewater-2487da89.uaenorth.azurecontainerapps.io`; app configuration is 0.5 CPU/1 GiB with zero-to-one replicas.
- Public health: `/api/health` returns HTTP 200 with `{"status":"ok"}`. Tenant login and authenticated routes pass desktop and mobile browser smoke QA. Admin-host routing, platform administrator login/session validation, and test-session revocation also pass through the generated endpoint with the forwarded Azure-validated host.
- Database: all 11 Prisma migrations, clean idempotent seed, and tenant RLS isolation check pass on staging.
- Ask Fathom: Azure managed identity calls Global Standard deployment `ask-fathom-gpt-5-mini`; diagnostics pass. Final Azure suite passes 46/46 cases with 856,849 ms aggregate model latency, 459,782 input tokens, and 28,092 output tokens.
- Email: capture-only, no sender/API key, no outbound delivery, and no captured message PII in logs.
- OIDC: main-branch and production-environment federated credentials exist. Staging principal has Contributor only on the staging group and AcrPush only on ACR. GitHub plan rejects required-reviewer configuration, so production remains a manual workflow without an enforceable reviewer until the plan supports protected-environment reviewers.
- DNS/TLS: GoDaddy records are live. `staging.devfathom.com` and `admin.staging.devfathom.com` are bound to the staging Container App with Azure-managed DigiCert certificates and both HTTPS routes return HTTP 200.
- Production: IaC and digest-promotion workflow are defined. No production resource group, RBAC, deployment, database, or DNS change exists.
