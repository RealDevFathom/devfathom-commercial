# Developer handbook

> **Audience:** engineers and coding agents working on DevFathom.
> **Checked against:** `develop` at `1906b530` (7 Nov 2026). Refreshed 10 Nov 2026 (PKT).
> **Replaces:** the drafts in PR #56 (`docs/dev-onboarding-architecture`, based on the old `main` at `16a2a370`).

Start with the architecture overview, then set up your machine, then read the permissions guide before you touch any pharmacy code.

| Read | For |
|---|---|
| [Architecture overview](architecture.md) | How the app is built: Next.js, tRPC, Prisma, Postgres, tenancy and request flow |
| [Repository map](repo-map.md) | Where things live in the repo |
| [Local setup](local-setup.md) | Running DevFathom on your machine (summary; the full steps are in [`../LOCAL_SETUP.md`](../LOCAL_SETUP.md)) |
| [Data model overview](data-model.md) | The main Prisma model groups and the rules every new table must follow |
| [Auth and permissions](auth-and-permissions.md) | Sign-in, roles, capabilities, branch scope and **separation of duties** (dispense, safety, catalogue review) |
| [Branching and releases](branching.md) | Feature → `develop` → `staging` → `main`, and who may promote |
| [Migrations and seeds](migrations-and-seeds.md) | Writing migrations under forced RLS, and what the seeds create |
| [Testing and CI](testing-and-ci.md) | Unit, database, RLS and end-to-end tests, and what CI does today |
| [Known issues](known-issues.md) | Open gaps a developer should know before building on an area |

**Not covered here:** infrastructure and access, running costs and the security summary. The CTO owns those; they live under [`../handover/`](../handover/) (added in PR #1436).

**Other technical references already in `docs/`:** the [admin platform handbook](../admin-platform/README.md) (tenancy/RLS, identity, entitlements, runbooks), [AI providers](../ai-providers.md), [deploy-develop notes](../deploy-develop.md) and the [living status ledger](../status-ledger.md). `docs/technical-overview.md` is outdated (it describes the retired Azure setup); use [architecture.md](architecture.md) instead.

**Feature lists:** the full feature inventory, with status and evidence paths, is under [`../features/`](../features/) (added in PRs #1433 and #1434).

## House rules

- Never push to `main`, `develop` or `staging` directly. Open a PR into `develop`.
- Never deploy, and never merge to `staging` or `main`, without Saad's explicit go-ahead.
- **Never deploy to Azure.** Azure files in the repo are deprecated and kept only for reference.
- Never put passwords, keys, tokens or login details in code, docs, PR bodies or screenshots.
- If you aren't sure something is true, write `TODO(confirm)` instead of guessing.
