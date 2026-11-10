# DevFathom — Infrastructure and access handover

> **Repo copy, sanitized 10 Nov 2026 (PKT).** Before this file was committed, identifiers were removed or replaced with placeholders: the AWS account ID, EC2 instance, volume and Elastic IP IDs, the public IP address, the load balancer DNS name, IAM user and role names, Secrets Manager secret names, snapshot names, contact email addresses and personal account names. **A second pass after the CTO's review (10 Nov 2026)** also removed CloudFormation stack names, database and server names, the production image digest, secret name prefixes, every note on where credentials are kept, and an operational MFA note. The CTO holds the unredacted working copy.
>
> **Facts corrected 10 Nov 2026 (PKT), after the CTO's review against develop `1906b530`:** `main` branch protection (confirmed, with its two required checks), Saad's decision (10 Nov 2026) to protect both branches and turn the checks back on, the state of the deploy workflows, the Bedrock region and profiles, and the Azure code that still exists.

**Audience:** investors doing technical due diligence, and a new CTO taking over.  
**Written:** 2026-11-10 (Asia/Karachi).  
**Sources (read-only):** AWS account inventory + Cost Explorer; internal plan notes; repo `RealDevFathom/devfathom-commercial` (develop tip `1906b530`, 7 Nov 2026); GitHub repo settings read 10 Nov 2026.  
**Hard rules reflected here:** no secret values or credential locations; Azure is not used for new product work; never touch the separate plansmithy product's server.

---

## Plain-language summary

DevFathom runs on **one AWS account**. Customer-facing production (the SuperAdmin console and Abbasi Pharmacie) lives in **Singapore** (`ap-southeast-1`) on containers behind a load balancer, with a small encrypted Postgres database. Day-to-day engineering work and demo sites run on a **separate small server in Virginia** (`us-east-1`) with Caddy for HTTPS. DNS for `devfathom.com` is in **Cloudflare**. Source code is in the private GitHub org **RealDevFathom**. Tickets are in **Linear** (team `DEV`). Passwords and API keys are **not** in this document; the CTO hands the credential inventory over in person.

**Azure is not used for Ask Fathom or new deploys, but Azure code still exists in the repo** (an Azure AI provider, an Azure storage adapter, three Azure packages, and the staging and production deploy workflows, which point only at Azure). **Saad ordered Azure removed from all code on 10 Nov 2026.** The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437).

**GitHub Actions is still turned off for the repo (checked 10 Nov 2026, 06:00 PKT).** On 10 Nov 2026 Saad decided to protect both `main` and `develop` and turn the checks back on; the CTO is turning Actions on now. Deploys are done by hand.

Live since **2026-10-23 (Asia/Karachi):** `admin.devfathom.com` and `abbasi-pharmacie.devfathom.com`.

---

## 1. Environments map

| Environment | What it is | Where it runs | Main hostnames | Status (2026-11-10) |
|---|---|---|---|---|
| **Production** | Live SuperAdmin + live pharmacy tenant(s) | AWS `ap-southeast-1`, one CloudFormation stack (ECS Fargate Spot + ALB + RDS) | `admin.devfathom.com`, `abbasi-pharmacie.devfathom.com` | Live since 2026-10-23 |
| **Staging** | Pre-prod shared stack | Same region, its own stack | `admin.staging.devfathom.com`, `*.staging.devfathom.com` (incl. Abbasi and SehatCart domain stacks) | Running (DesiredCount 1) |
| **Develop** | Engineering / demo hosts | AWS `us-east-1` EC2 instance (`t4g.medium`), Caddy + Let's Encrypt, deploys via SSM | `develop.devfathom.com`, `demo-pharmacy.devfathom.com`, `sehatcart.pharmacy.develop.devfathom.com` (and related develop tenant hosts) | Running; one Elastic IP attached |
| **Shared build** | Image build + container registry | `ap-southeast-1`, a shared stack | n/a | Active (CodeBuild + ECR) |

**Intended future topology (decided direction, only partly built):** one ECS service + one Postgres DB per major setup (shared admin, Abbasi, SehatCart) on staging and production, with host-based ALB rules. Abbasi still sits on the **shared** production stack and database today.

**Branching (product):** `develop` is the day-to-day integration branch (GitHub default). Promotion path is develop → staging → main/production, with Saad's explicit go-ahead required for production. Docs PRs use `docs/*` branches.

---

## 2. AWS account and regions

| Item | Value | Notes |
|---|---|---|
| AWS account ID | *(removed from the repo copy; held by the CTO)* | Single account for DevFathom (+ some non-product spend) |
| Primary product region | `ap-southeast-1` (Singapore) | Chosen after `me-central-1` impairments; matches earlier Vercel `sin1` |
| Develop server region | `us-east-1` | Develop server only |
| Leftover / other | `me-central-1` (a leftover Route 53 staging-zone stack), `ap-east-1` (a small VPN instance), `eu-north-1` / `us-east-2` (episodic QA/agent Spot) | **Not** part of the customer product path; clean up / ownership **TO CONFIRM** |
| Do-not-touch | The plansmithy server (`t4g.small`) | Separate product; out of DevFathom handover scope |

### 2.1 Production stack — verified 2026-11-10

| Resource | Verified setting |
|---|---|
| ECS service | Desired 1, Running 1 |
| Capacity | `FARGATE_SPOT` |
| Task size | 512 CPU / 1024 MiB |
| Image | The Abbasi launch image from ECR (whether later promotes landed: **TO CONFIRM**) |
| ALB | One public Application Load Balancer, HTTPS |
| Default ACM cert | `admin.devfathom.com` |
| Extra SNI cert | `abbasi-pharmacie.devfathom.com` (separate domain stack) |
| RDS | Postgres **16.12**, `db.t4g.micro`, **20 GB**, **single-AZ**, storage **encrypted**, **not** publicly accessible, **deletion protection on**, backup retention **7 days** |
| Manual snapshot retained | A manual pre-launch snapshot (2026-10-23) plus rolling automated snapshots |
| App secrets | Kept outside the code; categories only in §4 |
| Uploads | Private per-environment S3 bucket (`StorageAdapter=s3`) |
| AI on this stack | Parameter `AiProvider=disabled` (Ask Fathom not wired on prod yet) |
| Email on this stack | `EmailDeliveryMode=capture` (outbound email not live-sending) |
| Jobs schedule | `EnableJobsSchedule=false` |
| Platform emails | Set as stack parameters (addresses removed from the repo copy) |

### 2.2 Staging stack — verified 2026-11-10

Same pattern: ECS service Desired/Running 1, its own ALB, its own RDS (`db.t4g.micro`, encrypted, backup retention **1 day**). Custom domain cert stacks exist for the Abbasi and SehatCart staging hosts.

### 2.3 Develop EC2 — verified 2026-11-10

| Item | Value |
|---|---|
| Instance | *(ID and name removed from the repo copy)* |
| Type / AZ | `t4g.medium` / `us-east-1b` |
| EIP | One Elastic IP attached *(address and allocation ID removed from the repo copy)* |
| Volume | Root EBS volume, **50 GB gp3**, **Encrypted: false** ← security gap |
| Access pattern | SSM Session Manager; **no SSH keys in this doc** |
| Edge | Caddy reverse proxy + Let's Encrypt |
| Deploy | Manual over SSM today. The OIDC + S3 + SSM auto-deploy workflow (`deploy-develop.yml`) **is merged into develop but disabled** (see §2.5) |

**Never operate on** the plansmithy server.

### 2.4 CloudFormation stacks (product-related, `ap-southeast-1`)

Seven product stacks: one shared build stack, staging plus its certificate stack, two staging custom-domain stacks (Abbasi, SehatCart), production, and one production custom-domain stack (Abbasi). Stack names are held by the CTO.

Route 53: public hosted zone `staging.devfathom.com` (NS delegated from Cloudflare). Parent zone `devfathom.com` is **Cloudflare**, not Route 53.

Leftover: a staging DNS stack is still present in `me-central-1`; an older, empty me-central environment is noted in plans for cleanup when Saad agrees.

### 2.5 CI/CD and branch protection — verified 2026-11-10

| Item | State |
|---|---|
| GitHub Actions | **Still turned off for the repo** (checked 06:00 PKT). Turning it on is **in progress** (CTO), per Saad's decision of 10 Nov 2026 |
| Deploy workflows | The three deploy workflows (`deploy-develop.yml`, `deploy-staging.yml`, `promote-production.yml`) are to stay **disabled before Actions is turned on**. Each one shows as disabled today (checked 06:00 PKT) |
| `deploy-develop.yml` | **Merged into develop but disabled.** Built to deploy develop over OIDC + S3 + SSM after the QA gate passes |
| `deploy-staging.yml` | Disabled. Manual-dispatch only, and it **points only at Azure** (retired Azure staging). Not usable for the AWS staging stack |
| `promote-production.yml` | Disabled. Manual-dispatch only, and it **points only at Azure**. Not usable for AWS production |
| Real AWS deploys | Done by hand (CodeBuild image + ECS update for Singapore; SSM for develop), only with Saad's go-ahead for production |
| `main` | **Protected**, with two required status checks: `verify / Lint, typecheck and formatting` and `verify / Tests, RLS, build and end-to-end`. These checks can only run once Actions is on |
| `develop` | **To be protected, per Saad's decision (10 Nov 2026), in two steps. Not applied yet** (checked 06:00 PKT). **Step one (planned for today):** no force pushes, no branch deletion, changes only through pull requests, plus the lint check as a required check if it passes. **Step two:** the `Tests, RLS, build and end-to-end` check becomes required once Codex fixes develop's failing unit tests (develop fails its own unit tests at `1906b530`). Until then, merges are held until every gate passes on the final commit |

---

## 3. Other accounts and services

| Service | What we use it for | Owner (if known) | Handover / rotate |
|---|---|---|---|
| **AWS** | All product infra | Saad authorizes `aws login` / IAM access. Two automation IAM users have long-lived access keys | Remove/rotate both automation users' access keys on CTO change; review the product IAM roles; prefer SSO/`aws login` for humans; transfer root/account ownership **TO CONFIRM** (billing contact, MFA devices) |
| **Cloudflare** | DNS for `devfathom.com` (and tenant CNAMEs/A records); optional proxy | **TO CONFIRM** (Saad) | Transfer Cloudflare account ownership; rotate any API tokens (scope **TO CONFIRM**); document zone settings (SSL Full/strict if proxied) |
| **GitHub org `RealDevFathom`** | Canonical private repo `devfathom-commercial` (default branch `develop`) | **TO CONFIRM** org owners | Transfer org ownership; revoke stale personal access tokens; **never commit tokens**. Actions is still off and being turned on (CTO, per Saad's decision of 10 Nov 2026); `main` is protected with two required checks; `develop` protection is planned in two steps. See §2.5 |
| **Linear** | Issue tracking — workspace team **DevFathom** (`DEV`) | Connected to this bot's Linear connector | Transfer workspace admin; rotate bot OAuth |
| **Anthropic (Claude)** | Ask Fathom first provider (budget cap $190/mo across pharmacies) | **TO CONFIRM** | Rotate the key in the provider console and in AWS; update spend alerts. Production wiring is still `AiProvider=disabled` |
| **OpenAI** | Ask Fathom second provider (budget cap $190/mo) | **TO CONFIRM** | Same as above |
| **Amazon Bedrock** | Ask Fathom last-resort provider (budget cap $300/mo). Uses Anthropic models through the **`global.anthropic.*` cross-region inference profiles, called from `ap-southeast-1`** (`src/lib/ai/model-defaults.ts`) | Same AWS account | Review which roles may call `bedrock:InvokeModel` (**TO CONFIRM**); set account spend limits / budgets in AWS Billing |
| **Meta / WhatsApp Business** | Pharmacy messaging (refill/khata reminders, campaigns) | **TO CONFIRM** Tech Provider app ownership | Per-org WhatsApp tokens are **decided** to be encrypted per org — build status **TO CONFIRM**. Rotate Meta tokens; transfer Business Manager; document Embedded Signup |
| **Email (Resend / Brevo / SMTP / SES)** | App email | Production is in **capture** mode (no live send). SES in-region exists but **ProductionAccessEnabled=false** (sandbox) | Decide production sender; move off capture; rotate provider keys |
| **Payment processors (cards / JazzCash / Easypaisa)** | **TO CONFIRM** — pharmacy POS today is oriented around counter cash / Khata; no live card-processor wiring verified in this pass | n/a | Confirm whether any merchant accounts exist outside the app |
| **Sentry / other APM** | **TO CONFIRM** if any | | |
| **Azure** | Not used for Ask Fathom or new deploys. **Azure code still exists on develop:** the Azure AI provider (`src/lib/ai/provider.ts`), the Azure storage adapter (`src/lib/storage.ts`), three packages (`@ai-sdk/azure`, `@azure/identity`, `@azure/storage-blob`), and the staging and production deploy workflows, which point only at Azure. Old migration archives exist in S3 | Must not be used | Do not grant new Azure access for this product. **Saad ordered Azure removed from all code on 10 Nov 2026.** The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437). |

---

## 4. Secrets and credentials inventory (categories only)

Listed 2026-11-10 (values **not** retrieved). Exact names and locations are held by the CTO.

### 4.1 Production app secrets

- Database credentials and connection URLs (master, app and admin)
- App keys: auth secret, platform encryption key, camera credential key, cron secret
- Bootstrap passwords for the tenant admin and the platform admin

### 4.2 Staging app secrets

Same pattern as production, plus staging-only entries for: the seed password, a demo access code, a pharmacy owner bootstrap password, and the Anthropic and OpenAI API keys.

### 4.3 Human / operator secrets

- SuperAdmin and pharmacy owner passwords
- MFA enrolments and recovery codes
- Cloudflare, GitHub, Linear, Meta, Anthropic and OpenAI logins
- AWS root / billing login and its MFA device (**TO CONFIRM** who holds it)

None of these may ever go into git, chat or plan files.

**Rotate on handover:** every app secret (new values + app restart/migrate as needed), every third-party API key, every human password, every MFA enrolment, every IAM access key on the two automation IAM users.

---

## 5. IAM principals (by purpose)

| Principal | Role |
|---|---|
| Ops automation IAM user | Ops automation on the shared ops machine (this inventory was taken as this user) |
| EC2 helper IAM user | EC2/SSM related |
| Product roles for production, staging and the shared build stack | ECS tasks, migrate, jobs, CodeBuild |
| A QA SSM role (created 8 Nov 2026) | QA SSM access |

---

## 6. How a new CTO should take access (checklist)

1. Become AWS account owner / billing contact; enrol root MFA; create a personal admin IAM Identity Center (or IAM) user; **disable** inherited automation keys after cutover.
2. Join GitHub org `RealDevFathom` as owner; confirm `gh` auth from your machine only; revoke old personal access tokens. Check that GitHub Actions and `main`'s required checks are running (see §2.5).
3. Take Cloudflare account ownership; rotate zone API tokens.
4. Take Linear workspace admin; invite yourself; remove departed bots if needed.
5. Get operator logins handed over by Saad; rotate SuperAdmin passwords; **re-enrol MFA for every SuperAdmin**; store recovery codes offline.
6. Confirm you can: SSM to the develop server (not plansmithy), `aws ecs`/`rds` describe in `ap-southeast-1`, Cloudflare DNS edit, GitHub push to a `docs/*` or feature branch, Linear issue create.
7. Read the security summary and running-costs docs next; do **not** deploy or merge without Saad's (or the board's) explicit approval process.

---

## 7. Known gaps / TO CONFIRM

See also the consolidated list in the running-costs and security docs. Infrastructure-specific:

1. Cloudflare account login owner and whether DNS is proxied vs DNS-only per hostname.  
2. GitHub org owner list.  
3. GitHub Actions turned back on, with the three deploy workflows disabled first; `develop` protection step one applied; step two once develop's unit tests pass.  
4. AWS root email, billing alerts, and credit expiry.  
5. Whether production has been promoted past the Abbasi launch image.  
6. Develop host: Postgres local vs remote; disk encryption should be turned on for new volumes.  
7. Owner of the small `ap-east-1` VPN instance and whether to terminate it.  
8. Cleanup approval for leftover me-central resources.  
9. Meta Tech Provider / WABA production status.  
10. Production email sender choice when leaving `capture` mode.  
11. Azure code removal (DEV-755 / #1437). Until it lands, the staging and production deploy workflows can't deploy to AWS.
