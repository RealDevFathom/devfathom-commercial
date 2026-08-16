# Documentation QA

Last run: 2026-08-08.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Documentation index exists | PASS | [`README.md`](README.md) links the primary technical, commercial, ledger, and QA docs |
| Internal Markdown links | PASS | Newly added links resolve to repository paths; run the command below after doc edits |
| Secret scan | PASS | Documentation contains placeholders and identifiers only; never copy secret values |
| Vercel-reference audit | PASS WITH CAVEAT | Remaining references identify disabled legacy package/code paths or state the Azure-only policy; none are current deployment instructions |
| Hostname consistency | PASS WITH CAVEAT | `www.devfathom.com` still serves/redirects the GoDaddy marketing site; `admin.devfathom.com` is DNS-unconfigured; no public custom domain is attached; meet/turn are future and not live |
| Environment separation | PASS | Production resources are isolated from staging; production and staging databases remain separate |
| Production identity isolation | PASS | Separate secretless production OIDC identity has scoped production/ACR roles and no staging role; IDs and values are omitted |
| GitHub production environment | PASS | Seven required Azure variables and a `main`-only deployment branch policy are configured; values are omitted |
| Repository/live OIDC parity | ACTION REQUIRED | Current helper still models a shared principal and disables custom branch policy; it does not reproduce live production configuration |
| Staging release evidence | PASS | Latest reported run passed immutable build, migration/seed, deploy, and smoke in 7m40s; opaque digest/revision/run values are omitted |
| Production dark deployment | PASS WITH CAVEAT | Approved `ffec57b4` build, one-time bootstrap, migrations, min replica, and dark Azure-FQDN health check passed; public DNS/custom-domain cutover has not occurred |
| Production public cutover | BLOCKED | `admin.devfathom.com` is DNS-unconfigured and `www.devfathom.com` remains the existing marketing site; no public custom domain is attached |
| Meetings Wave-1 browser QA | BLOCKED | Cowork login/dashboard/responsive checks passed, but `getAll` and both `getUpcoming` queries attendee-filter the admin; `canAccessMeeting`/`canManageMeeting` grant ADMIN org-wide access; five migrated meetings are undiscoverable by the staging admin |
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
- Keep production **DARK / NOT PUBLICLY CUT OVER** until public DNS/custom-domain attachment and explicit release approval are verified. A dark-host health check is not public availability evidence.
- Keep Meetings Wave-1 browser QA **BLOCKED** until admin discovery authorization matches the org-wide detail/manage policy and the relevant browser checks pass.
- Proposed repair: make ADMIN list/upcoming queries org-wide within tenant RLS, retain attendee/creator scope for ordinary users, and add cross-tenant tests. After repair, five past seeded meetings should appear under Past while Upcoming may remain zero. Track the RSC-prefetch 503 burst in issue #32; bad-ID retry-on-`NOT_FOUND` is nonblocking.
- Replace `[VERIFY: ...]` placeholders in pitch material only with approved evidence.
