# Contributing and branching

> **Audience:** engineers and coding agents.
> **Based on:** `origin/main` @ `16a2a370` and CTO answers from 2026-10-22.
> Related: [onboarding.md](./onboarding.md) · [testing.md](./testing.md)

---

## The rules

1. **Every change reaches `main` through a pull request with review.**
2. **Never push directly to `main`.** No exceptions, including for agents and for "tiny" fixes.
3. Branch from `main` and keep branches short-lived. Delete them after merge (auto-delete is the target).
4. **Never commit secrets** (`.env`, `.env.local`, tokens, passwords, demo logins). Run `gitleaks` before opening a PR; there is no gitleaks CI workflow on `main` yet.
5. **Azure is DEPRECATED – never deploy to Azure.** See [below](#deployment-azure-is-deprecated).

## Branches

| Branch | Purpose |
|---|---|
| `main` | Integration branch. PR-only. |
| `feature/<short-name>` | Code changes. TODO(confirm): exact prefix convention (`feature/`, `feat/`, `fix/`). `fix/…` branches already exist, e.g. `fix/abac-deny-precedence`. |
| `docs/<short-name>` | Documentation-only changes, e.g. `docs/dev-onboarding-architecture` |
| `staging`, `develop` | **Planned, not created yet.** The target model is `main` + `staging` + `develop`. TODO(confirm): creation date. Until then, PRs target `main`. |
| `bots/post-hire-work` | Kept. Do not delete. |

The repo has many stale `backup/*` and `c-*` agent branches from before this model. Do not base new work on them. Cleanup is tracked separately.

## Pull request flow

```bash
git checkout main && git pull
git checkout -b feature/<short-name>      # or docs/<short-name>
# …work, commit…
git push -u origin feature/<short-name>
# open a PR against main
```

Before opening the PR:

- [ ] `bun run typecheck`, `bun run lint`, `bun run format:check`
- [ ] `bun run test`, plus `bun run test:rls` if you touched the schema, queries or migrations
- [ ] Schema changes go through a **migration** (never `db:push`), and new tenant-scoped tables have an RLS policy and test
- [ ] Pharmacy dispense, safety or catalogue-review changes follow [auth-and-roles.md § 4](./auth-and-roles.md#4-pharmacy-separation-of-duties)
- [ ] No secrets, credentials or logins in code, docs or screenshots
- [ ] Hotel code is out of scope. Don't extend it.

TODO(confirm): the required reviewers and approval count for code PRs.

### Docs PRs

- Branch `docs/<topic>` → PR into `main`.
- **The CTO approves docs PRs.**
- Docs-only PRs **skip the QA gate** but still need a secrets check (run `gitleaks` locally). A docs PR that touches code or config goes through the normal gate.
- Content about DRAP and the controlled register must be labelled **"DRAFT – pending legal review"**.
- Screenshots: use the `pharmacy-counter-e2e` demo org and the demo admin, and ping Inky before taking them (staging must be woken). **Never include logins.**

## CI

| Workflow | What it does | Status |
|---|---|---|
| `qa.yml` | QA gate, including RLS regressions | Triggers on push to `restaurantv2`, PRs into `integration/**`, and manual dispatch with a SHA. Not automatic on PRs into `main`. TODO(confirm): retargeting. |
| `image-build.yml` | Builds the container image on every pull request (no push, no deploy) | Active |
| `promote-production.yml` | Azure production promotion | **DEPRECATED – never deploy to Azure** |

Any other legacy Azure workflow is also **DEPRECATED**. Never run or dispatch it.

There is **no AWS CI workflow**. `infra/aws/buildspec.yml` exists, but it has not been verified as the live deploy path. TODO(confirm): the CTO will verify the AWS path before PR 5 documents it.

## Deployment: Azure is DEPRECATED

> 🚫 **DEPRECATED – never deploy to Azure.**

- Staging runs on **AWS, `ap-southeast-1`** (`infra/aws/`). There is **no production environment yet**.
- The Azure material (Bicep files under `infra/`, Azure workflows, Azure deploy and OIDC scripts, `docs/azure-deployment.md`) is **kept for reference only, not deleted**. Whether to archive or delete it is Saad's decision. Do not run, modify or "fix" it.
- `vercel.json` is unverified. Do not treat it as a deploy target. TODO(confirm).
- Deploying is not part of a normal PR. Staging and production procedures will be in `docs/deploy/` (PR 5), covering only what the CTO has verified.

## Coding agents

- Read `AGENTS.md` / `CLAUDE.md` at the repo root first.
- Follow the same rules: branch, PR, review, and no direct pushes.
- Don't create long-lived or `backup/*` branches.
