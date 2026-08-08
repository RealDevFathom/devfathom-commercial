# Documentation QA

Last run: 2026-08-08.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Documentation index exists | PASS | [`README.md`](README.md) links the primary technical, commercial, ledger, and QA docs |
| Internal Markdown links | PASS | Newly added links resolve to repository paths; run the command below after doc edits |
| Secret scan | PASS | Documentation contains placeholders and identifiers only; never copy secret values |
| Vercel-reference audit | PASS WITH CAVEAT | Remaining references identify disabled legacy package/code paths or state the Azure-only policy; none are current deployment instructions |
| Hostname consistency | PASS | Planned app hosts are `www.devfathom.com` and `admin.devfathom.com` on one Container App; apex remains marketing; meet/turn are future and not live |
| Environment separation | PASS | Production isolation is retained; only an empty resource-group shell exists and no production database/resources are deployed |
| Production deployability | BLOCKED | Template lacks safe bootstrap and email wiring; promotion lacks health smoke; GitHub variables and Azure RBAC are absent |
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
- Update the Meetings ledger after PR #23 is rebased, merged, staging-verified, and attached to release evidence.
- Keep production readiness **IN PROGRESS** until implementation changes are merged, reviewed, staging-verified, and deployed; the empty resource group is not deployment evidence.
- Replace `[VERIFY: ...]` placeholders in pitch material only with approved evidence.
