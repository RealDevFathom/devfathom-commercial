# Contributing and branching

> **Audience:** engineers and coding agents.
> **Based on:** `origin/main` @ `16a2a370` and CTO answers from 2026-10-22; branch guidance updated for the `develop` PR base on 2026-10-30.
> Related: [onboarding.md](./onboarding.md) · [testing.md](./testing.md)

---

## The rules

1. **Every change reaches `develop`, `staging` or `main` through a pull request with review.**
2. **Never push directly to `develop`, `staging` or `main`.** No exceptions, including for agents and for "tiny" fixes.
3. Branch from `develop` for normal development and keep branches short-lived. Delete them after merge (auto-delete is the target).
4. **Never commit secrets** (`.env`, `.env.local`, tokens, passwords, demo logins). Run `gitleaks` before opening a PR; there is no gitleaks CI workflow on `main` yet.
5. **Azure is DEPRECATED – never deploy to Azure.** See [below](#deployment-azure-is-deprecated).

## Branches

| Branch | Purpose |
|---|---|
| `develop` | Integration branch for normal code and docs PRs. PR-only. |
| `staging` | Staging branch. Changes require a reviewed PR. |
| `main` | Release branch. Changes require a reviewed PR. |
| `fix/<short-name>` | Most code changes (the most common prefix), e.g. `fix/abac-deny-precedence` |
| `improve/<short-name>` | Improvements to existing features |
| `release/<name>` | Release branches |
| `docs/<short-name>` | Documentation-only changes, e.g. `docs/dev-onboarding-architecture` |
| `qa/<short-name>` | QA work |
| `codex/<short-name>` | Branches opened by the Codex agent |
| `bots/post-hire-work` | Kept. Do not delete. |

## Pull request flow

```bash
git checkout develop && git pull --ff-only
git checkout -b fix/<short-name>          # or improve/, docs/, qa/ …
# …work, commit…
git push -u origin fix/<short-name>
# open a PR against develop
```

Before opening the PR:

- [ ] `bun run typecheck`, `bun run lint`, `bun run format:check`
- [ ] `bun run test`, plus `bun run test:rls` if you touched the schema, queries or migrations
- [ ] Schema changes go through a **migration** (never `db:push`), and new tenant-scoped tables have an RLS policy and test
- [ ] Pharmacy dispense, safety or catalogue-review changes follow [auth-and-roles.md § 4](./auth-and-roles.md#4-pharmacy-separation-of-duties)
- [ ] No secrets, credentials or logins in code, docs or screenshots
- [ ] Hotel code is out of scope. Don't extend it.

Branch protection is not available on our GitHub plan, so review is required **by policy**: one CTO review on every PR, plus QA for code PRs. Never merge your own PR without it.

### Docs PRs

- Branch `docs/<topic>` → PR into `develop`.
- **The CTO approves docs PRs.**
- Docs-only PRs **skip the QA gate** but still need a secrets check (run `gitleaks` locally). A docs PR that touches code or config goes through the normal gate.
- Content about DRAP and the controlled register must be labelled **"DRAFT – pending legal review"**.
- Screenshots: use the `pharmacy-counter-e2e` demo org and the demo admin, and ping Inky before taking them (staging must be woken). **Never include logins.**

## CI

| Workflow | What it does | Status |
|---|---|---|
| `qa.yml` | QA gate, including RLS regressions | Triggers on push to `restaurantv2`, PRs into `integration/**`, and manual dispatch with a SHA. Not automatic on PRs into `develop`, `staging` or `main`. |
| `image-build.yml` | Builds the container image on every pull request (no push, no deploy) | Active |
| `promote-production.yml` | Azure production promotion | **DEPRECATED – never deploy to Azure** |
| `deploy-staging.yml` | Azure-only staging deploy, manual dispatch only | **DEPRECATED – never start it.** |

There is **no AWS CI workflow**. The AWS staging path matches `infra/aws` as of 2026-10-22: CloudFormation stacks (`infra/aws/shared.yaml`, `environment.yaml`, `certificate.yaml`, `dns.yaml`) plus CodeBuild (`infra/aws/buildspec.yml`) building from a source zip in S3 with `IMAGE_TAG` set to the commit SHA, then migrate, `prepare-runtime-role`, and an ECS service roll. No CDK and no GitHub Actions. Full procedure in [the AWS deployment guide](../deploy/aws.md).

## Deployment: Azure is DEPRECATED

> 🚫 **DEPRECATED – never deploy to Azure.**

- Staging runs on **AWS, `ap-southeast-1`** (`infra/aws/`). There is **no production environment yet**.
- The Azure material (Bicep files under `infra/`, Azure workflows, Azure deploy and OIDC scripts, `docs/azure-deployment.md`) is **kept for reference only, not deleted**. Whether to archive or delete it is Saad's decision. Do not run, modify or "fix" it.
- `vercel.json` is unverified. Do not treat it as a deploy target. TODO(confirm).
- Deploying is not part of a normal PR. Staging and production procedures will be in `docs/deploy/` (PR 5), covering only what the CTO has verified.

## Coding agents

- Read `AGENTS.md` / `CLAUDE.md` at the repo root first.
- Follow the same rules: branch, PR, review, and no direct pushes.
- Don't create long-lived branches.
