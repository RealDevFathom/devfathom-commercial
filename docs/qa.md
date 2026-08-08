# Documentation QA

Last run: 2026-08-08.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Documentation index exists | PASS | [`README.md`](README.md) links the primary technical, commercial, ledger, and QA docs |
| Internal Markdown links | PASS | Newly added links resolve to repository paths; run the command below after doc edits |
| Secret scan | PASS | Documentation contains placeholders and identifiers only; never copy secret values |
| Vercel-reference audit | PASS WITH CAVEAT | Remaining references identify disabled legacy package/code paths or state the Azure-only policy; none are current deployment instructions |
| Hostname consistency | PASS WITH CAVEAT | `www.devfathom.com` still serves/redirects the GoDaddy marketing site; `admin.devfathom.com` is absent; planned app hosts remain future; meet/turn are future and not live |
| Environment separation | PASS | Production isolation is retained; only an empty resource-group shell exists and no production database/resources are deployed |
| Production identity isolation | PASS | Separate secretless production OIDC identity has scoped production/ACR roles and no staging role; IDs and values are omitted |
| GitHub production environment | PASS | Seven required Azure variables and a `main`-only deployment branch policy are configured; values are omitted |
| Repository/live OIDC parity | ACTION REQUIRED | Current helper still models a shared principal and disables custom branch policy; it does not reproduce live production configuration |
| Staging release evidence | PASS | Latest reported workflow passed immutable build, migration/backfill plus seed, deploy, and smoke in 8m01s; opaque digest/revision/run values are omitted |
| Production deployability | BLOCKED | Draft PR #33 is open and unmerged; template lacks safe bootstrap and email wiring; promotion lacks health smoke; no production resources or deployment exist |
| Status vocabulary | PASS | New pack uses IMPLEMENTED, PARTIAL, PLANNED, BLOCKED, and FUTURE |
| Pricing/claims safety | PASS | No final price, limit, customer, savings, compliance, SLA, or benchmark claim added |

## Repeatable local checks

```bash
rg -n -i 'password|connection string|api[_-]?key|secret|token|customer data' docs --glob '*.md'
rg -n -i 'vercel' docs README.md
rg -n '\[[^]]+\]\(([^)#]+\.md)(#[^)]+)?\)' docs --glob '*.md'
```

The Vercel result is not automatically a defect when it names a disabled legacy package/code path or states the Azure-only policy. It is a defect when a current deployment, runbook, or sales document presents Vercel as the platform.

## Known reconciliation items

- Keep dedicated provisioning **BLOCKED/PARTIAL** until an isolated Azure path is implemented and verified.
- Keep the Meetings schema/reconciliation row **IMPLEMENTED**, while tracking media rollout separately as **PLANNED / PARTIAL**.
- Keep production readiness **IN PROGRESS** while draft PR #33 is unmerged; require merge, review, staging verification, and deployment evidence. The empty resource group is not deployment evidence.
- Replace `[VERIFY: ...]` placeholders in pitch material only with approved evidence.
