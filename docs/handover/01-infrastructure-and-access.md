# DevFathom — Infrastructure and access handover

> **Repo copy, sanitized 10 Nov 2026 (PKT).** Before this file was committed, identifiers were removed or replaced with placeholders: the AWS account ID, EC2 instance, volume and Elastic IP IDs, the public IP address, the load balancer DNS name, IAM user and role names, Secrets Manager secret names, snapshot names, contact email addresses, personal account names, and hints about where credentials are stored. Everything else, including every **TO CONFIRM** item, is unchanged. The CTO holds the unredacted working copy.

**Audience:** investors doing technical due diligence, and a new CTO taking over.  
**Written:** 2026-11-10 (Asia/Karachi).  
**Sources (read-only):** AWS account inventory + Cost Explorer; `/workspace/plan/**`; repo `RealDevFathom/devfathom-commercial` (develop tip observed locally as `1906b530`, pushed_at 2026-11-09).  
**Hard rules reflected here:** no secret values; Azure is not used for new product work; never touch the plansmithy EC2 instance (separate product).

---

## Plain-language summary

DevFathom runs on **one AWS account**. Customer-facing production (the SuperAdmin console and Abbasi Pharmacie) lives in **Singapore** (`ap-southeast-1`) on containers behind a load balancer, with a small encrypted Postgres database. Day-to-day engineering work and demo sites run on a **separate small server in Virginia** (`us-east-1`) with Caddy for HTTPS. DNS for `devfathom.com` is in **Cloudflare**. Source code is in the private GitHub org **RealDevFathom**. Tickets are in **Linear** (team `DEV`). Passwords and API keys are **not** stored in this document — they live in AWS Secrets Manager (app secrets) and in a human password manager (operator logins). **Azure is out of scope** for Ask Fathom and new deploys.

Live since **2026-10-23 (Asia/Karachi):** `admin.devfathom.com` and `abbasi-pharmacie.devfathom.com`.

---

## 1. Environments map

| Environment | What it is | Where it runs | Main hostnames | Status (2026-11-10) |
|---|---|---|---|---|
| **Production** | Live SuperAdmin + live pharmacy tenant(s) | AWS `ap-southeast-1`, CloudFormation stack `devfathom-production` (ECS Fargate Spot + ALB + RDS) | `admin.devfathom.com`, `abbasi-pharmacie.devfathom.com` | Live since 2026-10-23 |
| **Staging** | Pre-prod shared stack | Same region, stack `devfathom-staging` | `admin.staging.devfathom.com`, `*.staging.devfathom.com` (incl. Abbasi + SehatCart domain stacks) | Running (DesiredCount 1) |
| **Develop** | Engineering / demo hosts | AWS `us-east-1` EC2 instance (`t4g.medium`, Name=`devfathom-pharmacy`), Caddy + Let's Encrypt, deploys via SSM | `develop.devfathom.com`, `demo-pharmacy.devfathom.com`, `sehatcart.pharmacy.develop.devfathom.com` (and related develop tenant hosts) | Running; one Elastic IP attached |
| **Shared build** | Image build + ECR | `ap-southeast-1` stack `devfathom-shared` | n/a | Active (`devfathom-image` CodeBuild, ECR `devfathom-commercial`) |

**Intended future topology (decided direction, only partly built):** one ECS service + one Postgres DB per major setup (shared admin, Abbasi, SehatCart) on staging and production, with host-based ALB rules. Tonight-of-launch Abbasi still sits on the **shared** production stack/DB. See `/workspace/plan/post-release-backlog.md`.

**Branching (product):** `develop` is the day-to-day integration branch (GitHub default). Promotion path is develop → staging → main/production, with Saad's explicit go-ahead required for production. Docs PRs use `docs/*` branches.

---

## 2. AWS account and regions

| Item | Value | Notes |
|---|---|---|
| AWS account ID | *(removed from the repo copy; held by the CTO)* | Single account for DevFathom (+ some non-product spend) |
| Primary product region | `ap-southeast-1` (Singapore) | Chosen after `me-central-1` impairments; matches earlier Vercel `sin1` |
| Develop / pharmacy EC2 region | `us-east-1` | Develop server only |
| Leftover / other | `me-central-1` (Route 53 staging zone stack), `ap-east-1` (`wireguard-hk` nano), `eu-north-1` / `us-east-2` (episodic QA/agent Spot) | **Not** part of the customer product path; clean up / ownership **TO CONFIRM** |
| Do-not-touch | The plansmithy EC2 instance (`plansmithy-staging`, `t4g.small`) | Separate product; out of DevFathom handover scope |

### 2.1 Production stack (`devfathom-production`) — verified 2026-11-10

| Resource | Verified setting |
|---|---|
| ECS cluster / service | `devfathom-production` / `web` — Desired 1, Running 1 |
| Capacity | `FARGATE_SPOT` |
| Task size | 512 CPU / 1024 MiB (task definition `devfathom-production-web:3`) |
| Image | ECR `devfathom-commercial@sha256:b4599a59…` (Abbasi launch image; confirm whether later promotes landed) |
| ALB | `devfathom-production` (DNS name removed from the repo copy) |
| Default ACM cert | `admin.devfathom.com` |
| Extra SNI cert | `abbasi-pharmacie.devfathom.com` (stack `devfathom-production-abbasi-pharmacie-domain`) |
| RDS | `devfathom-production`, Postgres **16.12**, `db.t4g.micro`, **20 GB**, **single-AZ**, storage **encrypted**, **not** publicly accessible, **deletion protection on**, backup retention **7 days** |
| Manual snapshot retained | A manual pre-launch snapshot (2026-10-23) plus rolling automated snapshots |
| Secrets prefix | `devfathom/production/*` (Secrets Manager) — names only listed in §4 |
| Uploads | S3 `devfathom-production-uploads-<account-id>` (`StorageAdapter=s3`) |
| AI on this stack | Parameter `AiProvider=disabled` (Ask Fathom not wired on prod yet) |
| Email on this stack | `EmailDeliveryMode=capture` (outbound email not live-sending) |
| Jobs schedule | `EnableJobsSchedule=false` |
| Platform emails (identifiers only) | `PlatformAdminEmail` and `AdminEmail` are set as stack parameters (addresses removed from the repo copy) |

### 2.2 Staging stack (`devfathom-staging`) — verified 2026-11-10

Same pattern: ECS `web` Desired/Running 1, ALB `devfathom-staging`, RDS `devfathom-staging` (`db.t4g.micro`, encrypted, backup retention **1 day**), secrets under `devfathom/staging/*`. Custom domain cert stacks exist for Abbasi and SehatCart staging hosts. Staging also holds Secrets Manager entries for the Anthropic and OpenAI API keys — values not read.

### 2.3 Develop EC2 — verified 2026-11-10

| Item | Value |
|---|---|
| Instance | *(ID removed from the repo copy)* |
| Type / AZ | `t4g.medium` / `us-east-1b` |
| Name tag | `devfathom-pharmacy` |
| EIP | One Elastic IP attached *(address and allocation ID removed from the repo copy)* |
| Volume | Root EBS volume, **50 GB gp3**, **Encrypted: false** ← security gap |
| Access pattern | SSM Session Manager (via an SSM instance profile, per plan); **no SSH keys in this doc** |
| Edge | Caddy reverse proxy + Let's Encrypt |
| Deploy | Manual over SSM today; OIDC+S3+SSM auto-deploy PR was not merged as of the develop-pharmacy plan |

**Never operate on** the plansmithy EC2 instance.

### 2.4 CloudFormation stacks (product-related, `ap-southeast-1`)

- `devfathom-shared`
- `devfathom-staging`, `devfathom-staging-cert`
- `devfathom-staging-abbasi-pharmacie-domain`, `devfathom-staging-sehatcart-domain`
- `devfathom-production`, `devfathom-production-abbasi-pharmacie-domain`

Route 53: public hosted zone `staging.devfathom.com` (NS delegated from Cloudflare). Parent zone `devfathom.com` is **Cloudflare**, not Route 53.

Leftover: `me-central-1` stack `devfathom-staging-dns` still present; older empty me-central environment noted in plans for cleanup when Saad agrees.

---

## 3. Other accounts and services

| Service | What we use it for | Owner (if known) | Where credentials live | Handover / rotate |
|---|---|---|---|---|
| **AWS** | All product infra | Saad authorizes `aws login` / IAM; automation uses an ops IAM user and an EC2 helper IAM user | Long-lived IAM access keys exist for the automation users (location held by the CTO, not listed here); prefer SSO/`aws login` for humans | Remove/rotate both automation users' access keys on CTO change; review IAM roles `devfathom-*`; transfer root/account ownership **TO CONFIRM** (billing contact, MFA devices) |
| **Cloudflare** | DNS for `devfathom.com` (and tenant CNAMEs/A records); optional proxy | **TO CONFIRM** (Saad) | An API token may exist for automation (scope **TO CONFIRM**); human login in password manager | Transfer Cloudflare account ownership; rotate API tokens; document zone settings (SSL Full/strict if proxied) |
| **GitHub org `RealDevFathom`** | Canonical private repo `devfathom-commercial` (default branch `develop`) | **TO CONFIRM** org owners; Saad's personal GitHub account also used historically for device auth | Org SSO / personal PATs / `gh` auth on ops machines — **never commit tokens** | Transfer org ownership; revoke stale PATs; **OPEN SECURITY GAP:** `develop` has no branch protection, rulesets or required checks (verified 2026-11-10 05:20 PKT); `main` TO CONFIRM |
| **Linear** | Issue tracking — workspace team **DevFathom** (`DEV`) | Connected to this bot's Linear connector | Linear OAuth for bots; human login in password manager | Transfer workspace admin; rotate bot OAuth |
| **Anthropic (Claude)** | Ask Fathom provider (budget cap $190/mo across pharmacies) | **TO CONFIRM** | Staging Secrets Manager entry for the Anthropic key; production wiring still `AiProvider=disabled` | Rotate key in provider console + Secrets Manager; update spend alerts |
| **OpenAI** | Ask Fathom fallback (budget cap $190/mo) | **TO CONFIRM** | Staging Secrets Manager entry for the OpenAI key | Same as above |
| **Amazon Bedrock** | Ask Fathom last-resort fallback (budget cap $300/mo); prefer EU Anthropic profile per Ask Fathom plan | Same AWS account | IAM permissions on task roles / instance roles — **TO CONFIRM** which roles have `bedrock:InvokeModel` | Review IAM; set account spend limits / budgets in AWS Billing |
| **Meta / WhatsApp Business** | Pharmacy messaging (refill/khata reminders, campaigns) | **TO CONFIRM** Tech Provider app ownership | Env names `PHARMACY_WHATSAPP_*` in `.env.example`; per-org WABA tokens **decided** to be encrypted per org — build status **TO CONFIRM** | Rotate Meta tokens; transfer Business Manager; document Embedded Signup |
| **Email (Resend / Brevo / SMTP / SES)** | App email | Production currently **capture** mode (no live send). SES in-region exists but **ProductionAccessEnabled=false** (sandbox). Resend/Brevo keys referenced in `.env.example` | Secrets / env — **do not paste values here** | Decide production sender; move off capture; rotate provider keys |
| **Payment processors (cards / JazzCash / Easypaisa)** | **TO CONFIRM** — pharmacy POS today is oriented around counter cash / Khata; no live card-processor wiring verified in this pass | n/a | n/a | Confirm whether any merchant accounts exist outside the app |
| **Sentry / other APM** | **TO CONFIRM** if any | | | |
| **Azure** | Legacy / forbidden for Ask Fathom and new deploys | Must not be used | Historical migration buckets exist in S3 (`azure-migration-*`) — treat as archive | Do not grant new Azure access for this product |

---

## 4. Secrets and credentials inventory (categories only)

### 4.1 AWS Secrets Manager — production (`devfathom/production/`)

Listed 2026-11-10 (values **not** retrieved). Exact secret names are removed from the repo copy; the categories are:

- Database credentials and connection URLs (master, app and admin)
- App keys: auth secret, platform encryption key, camera credential key, cron secret
- Bootstrap passwords for the tenant admin and the platform admin

### 4.2 AWS Secrets Manager — staging (`devfathom/staging/`)

Same pattern as production, plus staging-only entries for: the seed password, a demo access code, a pharmacy owner bootstrap password, and the Anthropic and OpenAI API keys.

### 4.3 Human / operator secrets (not in AWS)

| Secret class | Where it should live | Notes |
|---|---|---|
| SuperAdmin and pharmacy owner passwords | Password manager (**which product: TO CONFIRM**) | Never in git, chat, or plan files |
| MFA TOTP seeds / recovery codes | Password manager + hardware/ authenticator app | Staging SuperAdmin MFA was enrolled; **production/staging MFA reset after screenshot exposure is still an open action** (see security summary) |
| Cloudflare, GitHub, Linear, Meta, Anthropic, OpenAI logins | Password manager | Transfer ownership on CTO change |
| AWS root / billing | Password manager + hardware MFA | **TO CONFIRM** root MFA device location |

**Rotate on handover:** every Secrets Manager secret (new values + app restart/migrate as needed), every third-party API key, every human password, every MFA enrollment, every IAM access key on the two automation IAM users.

---

## 5. IAM principals (by purpose)

| Principal | Role |
|---|---|
| Ops automation IAM user | Ops automation on the shared ops machine (this inventory was taken as this user) |
| EC2 helper IAM user | EC2/SSM related |
| Roles `devfathom-production-*`, `devfathom-staging-*`, `devfathom-shared-BuildRole-*` | ECS tasks, migrate, jobs, CodeBuild |
| A QA SSM role (created 8 Nov 2026) | QA SSM access |

---

## 6. How a new CTO should take access (checklist)

1. Become AWS account owner / billing contact; enroll root MFA; create a personal admin IAM Identity Center (or IAM) user; **disable** inherited box keys after cutover.
2. Join GitHub org `RealDevFathom` as owner; confirm `gh` auth from your machine only; revoke old PATs.
3. Take Cloudflare account ownership; rotate zone API tokens.
4. Take Linear workspace admin; invite yourself; remove departed bots if needed.
5. Open the password manager vault; rotate SuperAdmin passwords; **reset MFA** for any exposed enrollments; store recovery codes offline.
6. Confirm you can: SSM to develop EC2 (not plansmithy), `aws ecs`/`rds` describe in `ap-southeast-1`, Cloudflare DNS edit, GitHub push to a `docs/*` or feature branch, Linear issue create.
7. Read the security summary and running-costs docs next; do **not** deploy or merge without Saad's (or the board's) explicit approval process.

---

## 7. Known gaps / TO CONFIRM

See also the consolidated list in the running-costs and security docs. Infrastructure-specific:

1. Cloudflare account login owner and whether DNS is proxied vs DNS-only per hostname.  
2. GitHub org owner list and branch-protection settings.  
3. Password manager product and vault location.  
4. AWS root email, billing alerts, and credit expiry.  
5. Whether production image has been promoted past Abbasi launch digest `b4599a59…`.  
6. Develop host: Postgres local vs remote; disk encryption should be turned on for new volumes.  
7. Owner of `ap-east-1` `wireguard-hk` and whether to terminate.  
8. Cleanup approval for leftover me-central resources.  
9. Meta Tech Provider / WABA production status.  
10. Production email sender choice when leaving `capture` mode.
