# Branching and releases

> Checked 10 Nov 2026 (PKT). `develop` is at `1906b530`; `staging` and `main` are both at `08a247c1`. Replaces `docs/dev/contributing.md` from PR #56.

## The flow

```
feature branch ──PR──▶ develop ──PR──▶ staging ──PR──▶ main
 (fix/…, improve/…,     integration     pre-release      production
  docs/…, codex/…)      (PR-only)       (PR-only)        (PR-only)
```

| Branch | Purpose | Who moves it |
|---|---|---|
| `develop` | Integration branch. Every normal code and docs PR targets it. | Reviewed PRs only |
| `staging` | What runs on staging. Promoted from `develop`. | Reviewed PR, with Saad's go-ahead |
| `main` | Release and production branch. Promoted from `staging`. | Reviewed PR, with **Saad's explicit go-ahead**. Production is promoted by image digest (`promote-production.yml`, manual). |
| `fix/<topic>` / `improve/<topic>` / `feat/<topic>` | Code changes | You |
| `docs/<topic>` | Documentation-only changes | You |
| `codex/…`, `cloud/…`, `inky/…` | Branches opened by agents (the most common prefixes on open PRs today) | Agents |
| `integration/<name>` | Long-running integration branches (for example `integration/consolidation-20261019`) | Leads |
| `bots/post-hire-work` | Kept. Don't delete it. | — |

## Rules

1. **Never push directly to `develop`, `staging` or `main`.** That includes agents and "tiny" fixes.
2. Branch from an up-to-date `develop`. Keep branches short-lived and delete them after merge.
3. **Review is policy, not enforced.** `develop` is **unprotected, by Saad's decision (10 Nov 2026)**, and GitHub Actions is off, also by his decision. Before every merge, the deterministic checks (lint, typecheck, unit tests, build, Prisma generate and the Docker check) run on the AWS worker on the exact final commit, and nothing merges until they all pass. Nothing technically stops a direct push or a self-merge, so the rules here are what hold the line. `main`'s protection is unchanged: it requires two `verify / …` checks, which can't run while Actions is off. Get a CTO review on every PR and QA on code PRs, and never merge your own PR.
4. **"Merged to develop" isn't "released".** A feature is only on production once `main` has been promoted.
5. **Never deploy to Azure.** `deploy-staging.yml` and `promote-production.yml` point only at Azure, are manual-dispatch only, and are disabled. Don't run them. Saad ordered Azure removed from all code on 10 Nov 2026. The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437).
6. **Never commit secrets** (`.env*`, tokens, passwords, demo logins). Run `gitleaks` locally before opening a PR.

## Making a PR

```bash
git fetch origin && git switch -c fix/<topic> origin/develop
# …work, commit…
git push -u origin fix/<topic>
gh pr create --base develop
```

Checklist:

- [ ] `bun run typecheck`, `bun run lint`, `bun run format:check`
- [ ] `bun run test`, plus `bun run test:rls` if you touched the schema, queries or migrations
- [ ] Schema changes go through a **migration**, and new tenant tables have an RLS policy and a test ([migrations-and-seeds.md](migrations-and-seeds.md))
- [ ] Pharmacy dispense, safety, catalogue-review or purchasing changes keep the SoD rules ([auth-and-permissions.md §5](auth-and-permissions.md#5-separation-of-duties-sod))
- [ ] No secrets, credentials or logins in code, docs or screenshots
- [ ] Hotel is paused: don't extend it without a go-ahead

To run CI on a PR, add the `ci-ready` label; see [testing-and-ci.md](testing-and-ci.md).

### Docs PRs

- Use a `docs/<topic>` branch with a PR into `develop`. The CTO approves docs PRs.
- Docs-only PRs don't need the full QA gate, but still need a secrets check.
- DRAP and controlled-register content must be labelled **"DRAFT – pending legal review"**.
- Feature lists live in `docs/features/`, and CTO-owned handover docs in `docs/handover/`.
