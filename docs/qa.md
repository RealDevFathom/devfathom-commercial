# Documentation QA

Last run: 2026-08-08.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Documentation index exists | PASS | [`README.md`](README.md) links the primary technical, commercial, ledger, and QA docs |
| Internal Markdown links | PASS | Newly added links resolve to repository paths; run the command below after doc edits |
| Secret scan | PASS | Documentation contains placeholders and identifiers only; never copy secret values |
| Vercel-reference audit | ACTION REQUIRED | Historical admin-platform docs still contain Vercel-specific implementation evidence; Azure operating docs must remain authoritative |
| Hostname consistency | PASS WITH CAVEAT | Shared production join host is `www.devfathom.com`; staging app host is `staging.devfathom.com`; Meetings docs include enterprise host shape |
| Environment separation | PASS | Azure deployment doc states staging and production databases/resources are separate and production is not cut over |
| Status vocabulary | PASS | New pack uses IMPLEMENTED, PARTIAL, PLANNED, BLOCKED, and FUTURE |
| Pricing/claims safety | PASS | No final price, limit, customer, savings, compliance, SLA, or benchmark claim added |

## Repeatable local checks

```bash
rg -n -i 'password|connection string|api[_-]?key|secret|token|customer data' docs --glob '*.md'
rg -n -i 'vercel' docs README.md
rg -n '\[[^]]+\]\(([^)#]+\.md)(#[^)]+)?\)' docs --glob '*.md'
```

The Vercel result is not automatically a defect: `docs/admin-platform/` records historical/provider-specific code paths that remain in the repository. It is a defect when a current deployment or sales document presents Vercel as the platform. Keep Azure deployment and this QA note explicit about that distinction.

## Known reconciliation items

- Reconcile older `docs/admin-platform/` claims that call dedicated provisioning “Complete” with the current Azure-only commercial posture; retain them as historical code evidence and mark the production dependency.
- Update the Meetings ledger only after the Wave 1 PR is present and its tests/release evidence are verified.
- Replace `[VERIFY: ...]` placeholders in pitch material only with approved evidence.
