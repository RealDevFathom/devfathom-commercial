# DevFathom on AWS

This is the target architecture for running DevFathom on AWS beside the existing Azure Container Apps deployment. Azure stays the live platform. Nothing in this repository deploys to a real AWS account: `cdk synth` is offline, and the workflows assume a role only after a human has bootstrapped the account and set the GitHub variables.

“Bun POS” in the brief is the process runtime. The production command is `bun server.js`. There is no separate point-of-sale service in this repository.

## Decision

Run the app on **ECS on Fargate** in **ap-south-1 (Mumbai)**, behind one public Application Load Balancer, with RDS Postgres in isolated subnets. Evolution API (WhatsApp) is a second Fargate service on a private Cloud Map name. Prisma migrations are a one-off task, not a container that starts with the web service.

### ECS Fargate, App Runner, and ECS Express Mode

| | ECS Fargate (this design) | App Runner | ECS Express Mode |
| --- | --- | --- | --- |
| New accounts | Available | Closed to new customers on 30 April 2026. Existing customers can keep using it. AWS is not adding features. | Available. AWS points new App Runner users here. |
| What you get | Cluster, services, task definitions, ALB, security groups, and a one-off task, all in the account. | One public service per image. The ALB and network are hidden. | One API call creates a Fargate service, its own ALB, scaling, and a VPC. |
| Private companion service | Evolution stays off the internet. The web tasks reach it on Cloud Map. | A second service is public unless extra VPC ingress is bolted on. | Each service gets its own public ALB. Sharing one ALB and hiding Evolution is the full ECS model, which is what this stack already is. |
| One-off migration | `RunTask` on a separate image, then roll the services. | No task primitive. A release would migrate inside the app container or from a laptop. | No separate migrate task. |
| RDS isolation | App and Evolution security groups are the only ingress to Postgres. | Possible with a VPC connector, with less control over the path. | Possible, but the Express ALB and network are not the shape this stack needs. |

Express Mode is the simple successor to App Runner. It does not fit a private Evolution service, a migrate-then-rollout task, one shared ALB, and security-group isolation of RDS. Those are ordinary ECS resources, so the stack uses Fargate directly.

### Region

**ap-south-1** is the default. Mumbai is the closest region that has the full set of services this stack uses (Fargate, RDS Postgres 16, ECR, Secrets Manager, ACM, Cloud Map) at the lower of the two price lists. **me-central-1** is the other supported value (`-c region=me-central-1` or `DEVFATHOM_AWS_REGION`). Use it when the data has to sit next to the existing Azure UAE North footprint. This design did not measure round trips from Karachi or Lahore; both regions are a few tens of milliseconds away on common paths, and the choice is service coverage and price. The VPC uses two availability zones in the chosen region.

## Topology

```text
Internet
  │  443 (80 redirects)
  ▼
Application Load Balancer (public subnets, TLS via ACM)
  │  /api/health
  ▼
ECS web service  ── Cloud Map http://evolution.devfathom.local:8080 ──►  ECS Evolution service
  │  private subnets, no public IP                                      one task, Redis sidecar
  │                                                                     on 127.0.0.1, not published
  ▼
RDS Postgres 16 (isolated subnets, encrypted, force_ssl=1)
  databases: devfathom, evolution

S3 uploads bucket (private, TLS-only)     Secrets Manager
ECR: web, migrate, evolution              CloudWatch logs, alarms, dashboard
```

Staging uses one NAT gateway. Tasks in the other availability zone send egress through it and pay the cross-AZ data charge. Production uses one NAT gateway per zone. An S3 gateway endpoint keeps bucket traffic off the NAT. VPC flow logs record rejected traffic only.

| | Staging | Production |
| --- | --- | --- |
| Stacks | `DevFathom-staging`, `DevFathom-staging-cicd` | `DevFathom-production`, `DevFathom-production-cicd` |
| Web task | 0.5 vCPU, 1 GB, desired 1, scale 1–2 at 60% CPU | 1 vCPU, 2 GB, desired 2, scale 2–4 |
| Evolution | 0.5 vCPU, 2 GB, exactly one task | same |
| RDS | db.t4g.micro, single-AZ, 20–100 GB gp3, 7-day backup, final snapshot on delete | db.t4g.small, Multi-AZ, 50–200 GB, 14-day backup, deletion protection, Performance Insights |
| Removal | Buckets and repositories can be destroyed when empty | Retain |
| Names | prefix `devfathom-stg` | prefix `devfathom-prd` |

Both stages use Fargate platform 1.4, X86_64, a deployment circuit breaker with rollback, and container insights. The web service keeps at least one healthy task (`minHealthyPercent` 100). Evolution uses `minHealthyPercent` 0 and `maxHealthyPercent` 100 so a replacement does not run a second WhatsApp session.

## Application image

`Dockerfile` (repository root) is a multi-stage build:

1. `oven/bun:1.3.14-slim` installs dependencies.
2. `node:22-trixie-slim` runs `prisma generate`, `next typegen`, `tsc`, and `next build`. Bun 1.3.14 segfaults inside `next build` (oven-sh/bun#36866), so the build stage stays on Node. `AUTH_SECRET=container-build-only` exists only for that build.
3. `migrate` (built with `--target migrate`) installs production dependencies, creates the `evolution` database when `PREPARE_EVOLUTION_DATABASE=true`, then runs `bunx prisma migrate deploy`. It does not seed.
4. The default final stage runs `bun server.js` as user `bun`.

`docker/aws-entrypoint.sh` leaves `DATABASE_URL` alone when it is already set, so Azure is unchanged. On ECS the task receives `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD` from the RDS secret. The entrypoint builds `postgresql://…?sslmode=verify-full&sslrootcert=/etc/ssl/rds-global-bundle.pem` and does not print the URL. The CA bundle is the public Amazon RDS global bundle vendored at `docker/rds/global-bundle.pem`.

`GET /api/health` runs `SELECT 1`. The load balancer and the container health check both use it, so a task with no database stays out of service.

## Postgres

The instance is not publicly accessible. `rds.force_ssl=1`. Storage is encrypted. Backups run 19:30–20:30 UTC. Maintenance is Sunday 21:00–22:00 UTC. The master user is `devfathomadmin` and the application database is `devfathom`. The migration task creates a second database named `evolution` before `prisma migrate deploy`. Evolution uses the same master user. A dedicated database role is a follow-up.

The app reads `DATABASE_URL` only (`src/lib/db.ts`). ECS never sets that variable itself; the entrypoint does.

## Uploads

The stack creates a versioned, TLS-only, public-access-blocked S3 bucket and grants the web task role read/write on it. The task environment includes `UPLOADS_BUCKET`, `UPLOADS_PREFIX=uploads`, and `AWS_REGION`.

`src/lib/storage.ts` still writes to Azure Blob when `AZURE_STORAGE_ACCOUNT_NAME` is set, and otherwise to a local `private-uploads` directory. Fargate disk is ephemeral, so uploads on AWS are not durable until an S3 adapter exists. This change does not add that adapter.

## Secrets

Secrets Manager generates these values (48 characters, no punctuation). Read them in the console when a human needs them. Do not print them in CI logs.

| Secret name | Injected as |
| --- | --- |
| `devfathom/stg/auth-secret` (prod: `devfathom/prd/…`) | `AUTH_SECRET` |
| `…/platform-encryption-key` | `PLATFORM_ENCRYPTION_KEY` (the app SHA-256s any long string) |
| `…/cron-secret` | `CRON_SECRET` |
| `…/evolution-api-key` | `AUTHENTICATION_API_KEY` on Evolution |
| RDS-managed secret | `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` |

Rotation is not enabled. Rotating `AUTH_SECRET` or the database password invalidates sessions and forces a task restart. Staging secrets are destroyed with the stack. Production secrets are retained.

These are not created, because the app can boot without them and the values are not ones we should invent: Ably, model-provider keys, Brevo or Resend, Google or Microsoft OAuth, and Jitsi/JAAS. `EMAIL_DELIVERY_MODE` is `capture` on both stages so a first boot does not send mail.

Plaintext task environment is limited to non-secrets: `NODE_ENV`, ports, `AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `PLATFORM_BASE_DOMAIN`, the Evolution base URL, and the uploads bucket name. `DEFAULT_ORGANIZATION_ID` is intentionally unset.

| Stage | Tenant host | Admin host | `PLATFORM_BASE_DOMAIN` |
| --- | --- | --- | --- |
| staging | `staging.devfathom.com` | `admin.staging.devfathom.com` | `staging.devfathom.com` |
| production | `www.devfathom.com` | `admin.devfathom.com` | `devfathom.com` |

## TLS

TLS is on by default. ACM requests a certificate for the stage domain and the admin SAN and validates it by DNS. Without a Route 53 hosted zone, deploy waits until the CNAMEs exist at the DNS host (GoDaddy today). Pass `-c hostedZoneId=… -c hostedZoneName=…` together when the zone is in Route 53. Pass `-c enableTls=false` for an HTTP-only bring-up. HTTP redirects to HTTPS when TLS is on. The listener uses the ELB recommended TLS policy (`ELBSecurityPolicy-TLS13-1-2-2021-06`).

## Evolution API

The image is `evoapicloud/evolution-api:v2.3.1`, wrapped by `docker/evolution/Dockerfile`. Build context is `docker/` so the wrapper and the CA bundle are both visible. The wrapper builds `DATABASE_URL` for the `evolution` database, points Redis at `redis://127.0.0.1:6379`, and deletes the upstream `Database URL:` echo in `deploy_database.sh` before starting the server. Redis is `public.ecr.aws/docker/library/redis:7.4-alpine` with persistence disabled, and it has no host port.

Evolution is not attached to the load balancer. Web tasks call `http://evolution.devfathom.local:8080`. Baileys makes outbound connections to WhatsApp. Sessions may live on the task disk; EFS is deferred, so a replacement task can drop the WhatsApp login.

## Releases

Images are immutable and scanned on push. ECR keeps the newest 30. Three repositories per stage: `devfathom-stg-web`, `devfathom-stg-migrate`, `devfathom-stg-evolution` (and `devfathom-prd-…`).

The environment stack takes a CloudFormation parameter `ImageTag` (default `bootstrap`). A `cdk deploy` that omits it resets the services to that tag. Steady state:

1. CI pushes the three images tagged with the git SHA.
2. `infra/aws/scripts/rollout.sh` copies the current task definitions, swaps the `migrate`, `web`, and `evolution` images (Redis stays), registers new revisions, and runs the migrate task on the private subnets with no public IP.
3. After migrate exits 0, it updates the web and Evolution services, then writes `/devfathom/<stage>/deployed-image-tag` in SSM.
4. A human infra change uses `infra/aws/scripts/deploy-compute.sh`, which reads that parameter and deploys only `DevFathom-<stage>` with `ImageTag` set.

CI does not run `cdk deploy`. The GitHub role cannot assume the CDK bootstrap roles. The first deploy is a human `cdk deploy` after the images exist. The services stay unhealthy until migrate has run, because `/api/health` needs the schema.

Platform jobs are not scheduled. `POST /api/platform/jobs/process` expects `Authorization: Bearer <CRON_SECRET>`. EventBridge cannot add the `Bearer ` prefix to a generated secret without another component. The in-image CLI path is also unverified. Scheduling is a follow-up.

## Observability

Log groups: `/devfathom/stg/web`, `/migrate`, `/evolution`, and `/vpc-flow` (production uses `prd`). Retention is 30 days in staging and 90 in production.

Alarms publish to an SNS topic that requires TLS. Pass `-c alarmEmail=ops@example.com` to subscribe an address (the subscription email must be confirmed).

| Alarm | Threshold |
| --- | --- |
| Target 5xx | more than 5 in 5 minutes |
| Unhealthy web hosts | at least 1 for 3 minutes |
| Web CPU | over 80% |
| RDS CPU | over 80% |
| Free storage | under 2 GB staging, 5 GB production |
| Connections | over 60 staging, 120 production |

A dashboard named `devfathom-stg` or `devfathom-prd` graphs web CPU, target 5xx, Postgres CPU, and connections.

## CI and access

No static AWS keys. GitHub Actions assumes a role with OIDC.

The staging stack creates the GitHub OIDC provider (thumbprints pinned so synth does not fetch them). Production imports `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com` in the same account. A second provider in one account would fail; pass `-c createOidcProvider=true` only for the stack that should own it.

| Role | Who can assume it | What it can do |
| --- | --- | --- |
| `devfathom-stg-gha-deploy` | This repo’s `aws-staging.yml` on `refs/heads/infra/aws` or `refs/heads/staging`, subject `environment:staging` or those refs. Pull-request refs are not trusted. | Push the three staging images, register task definitions, run migrate, update the two services, read the environment stack outputs, read migration logs, read and write the deployed-tag parameter. |
| `devfathom-prd-gha-deploy` | `aws-production.yml` on `refs/heads/main` with subject `environment:production`. | The same for production, plus pull from the staging repositories so a release copies an image that already ran. |

Trust also checks `job_workflow_ref`, so a different workflow file in the repo cannot assume the role. The role does not get `AdministratorAccess` and does not get the CDK deploy roles (`cdk-hnb659fds-*`).

Workflows:

| File | When |
| --- | --- |
| `.github/workflows/aws-ci.yml` | Every pull request: lint, typecheck, unit tests, `cdk synth --strict` for staging and production. |
| `.github/workflows/aws-staging.yml` | Push to `infra/aws` or `staging`, and manual dispatch. Runs the same verify job, then builds and rolls out staging. If `AWS_STAGING_DEPLOY_ROLE_ARN` is unset, deploy is skipped with a warning so a push does not fail red before the account exists. |
| `.github/workflows/aws-production.yml` | `workflow_dispatch` only. Copies the three staging images of a given tag into the production repositories and rolls production. |

GitHub Environments `staging` and `production` are required for the role trust to see `environment:staging` and `environment:production`. Required reviewers and deployment branch policies are set in GitHub, not in the workflow file. Before the production role is useful, environment `production` needs required reviewers and a branch policy of `main` only. Environment `staging` should allow `infra/aws` and `staging`.

The existing Azure workflows (`deploy-staging.yml`, `image-build.yml`, `promote-production.yml`) are unchanged. A push to `main` still deploys Azure and does not deploy AWS.

`cdk synth` uses account `000000000000` unless `-c account=<12 digits>` or `DEVFATHOM_AWS_ACCOUNT` is set, and it ignores `CDK_DEFAULT_REGION` / `AWS_REGION` so a laptop or this VM cannot silently synth `us-east-1`. The placeholder account’s availability zones are pinned in `infra/aws/bin/app.ts` because a concrete account would otherwise call EC2. A real-account synth looks up the real zones once; commit the `cdk.context.json` entries that lookup writes.

## Rough monthly cost

Planning figures for ap-south-1, on-demand, 730 hours, October 2026. Confirm in the AWS Pricing Calculator before budgeting. These are not a quote. Fargate planning rates used here are about $0.04256 per vCPU-hour and $0.004655 per GB-hour. NAT is about $0.045 per hour per gateway. ALB is about $0.0225 per hour plus LCUs. Data transfer, cross-AZ traffic on the single staging NAT, and RDS backup storage above the free allowance are extra. No Fargate Spot.

| | Staging | Production, low traffic |
| --- | --- | --- |
| NAT | 1 × ~$33 | 2 × ~$33 |
| ALB | ~$21 including light LCU | ~$25 |
| Web Fargate | ~$19 | two tasks × ~$36 |
| Evolution + Redis | ~$22 | ~$22 |
| RDS | db.t4g.micro + 20 GB gp3 ~$16 | db.t4g.small Multi-AZ + 50 GB ~$70 |
| Secrets, S3, ECR, logs | ~$10 | ~$15 |
| **Planning total** | **about $120–160** | **about $280–420** |

Excluded: Ably, email, model tokens, WhatsApp, domains, and the existing Azure bill.

## First deploy

Do this once, from a human with administrator credentials. CI cannot bootstrap the account.

1. `cdk bootstrap aws://<account>/ap-south-1` from `infra/aws`.
2. In GitHub, create environments `staging` (branches `infra/aws` and `staging`) and `production` (required reviewers, `main` only).
3. Build and push the first three images to the staging repositories (or let the staging workflow do it after step 5). Tag them with the git SHA.
4. Deploy, with the tag of an image that already exists. Omit `ImageTag` and the services point at `bootstrap`, which is not a real image.

   ```bash
   cd infra/aws
   npx cdk deploy DevFathom-staging DevFathom-staging-cicd \
     -c account=<12 digits> -c region=ap-south-1 \
     --parameters DevFathom-staging:ImageTag=<git-sha>
   ```

   Add `-c enableTls=false` until the ACM CNAMEs are in DNS. Add `-c alarmEmail=…` to subscribe alarms.
5. Copy the `DeployRoleArn` output into the GitHub variable `AWS_STAGING_DEPLOY_ROLE_ARN`. After production exists, set `AWS_PRODUCTION_DEPLOY_ROLE_ARN`.
6. Run `infra/aws/scripts/rollout.sh` (the staging workflow does this) so migrate creates the schema and the `evolution` database, then rolls both services.
7. Point `staging.devfathom.com` and `admin.staging.devfathom.com` at the `AlbDnsName` output.

Later infrastructure changes go through `infra/aws/scripts/deploy-compute.sh` so `ImageTag` stays on the SHA stored in SSM. Production is the same shape with `-c stage=production`, and only after the staging images for that SHA exist. The production workflow copies them; it does not rebuild.

Optional, and only if humans will deploy with the CDK deploy role rather than an admin user: `cdk bootstrap --trust <that-role> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess`. Do not add that trust for the GitHub rollout role.

## Open questions

- Uploads still use Azure Blob or local disk. The bucket and task role are ready; the S3 adapter is not written.
- Evolution (Baileys) versus the official WhatsApp Cloud API: session loss on task replacement, WhatsApp terms, and ban risk are product decisions. The image tag is `v2.3.1`; a maintainer called v2.3.7 current in April 2026. Pin a digest before production.
- Redis is the floating tag `7.4-alpine`. Pin a digest with the Evolution image.
- Postgres 16 matches the live Azure Flexible Server. CI’s disposable database is Postgres 17.
- Baileys sessions have no EFS volume.
- The database user is the RDS master. A restricted `evolution` role and a restricted app role are not created.
- Secret rotation is manual.
- Platform job processing has no schedule.
- No WAF on the load balancer.
- Production Redis is still a sidecar, not ElastiCache.
- Mumbai versus UAE was not measured from Pakistan.
- Production is the same account, importing the staging OIDC provider. A separate production account needs its own provider (`-c createOidcProvider=true`) and a cross-account image copy.
- Azure seeds staging. The AWS migrate task does not.
- The load balancer certificate will not match the raw ALB DNS name. The smoke check uses the ALB URL and skips hostname verification. Real clients use the stage hostname after DNS is pointed.
- `EMAIL_DELIVERY_MODE=capture` until email-provider secrets are added on purpose.
