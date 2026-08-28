# Platform and entitlements PRD

## Problem

DevFathom needs a seller-operated control plane that onboards the correct organization type and computes tenant capabilities from one catalog, packages, contracts, and explicit overrides without confusing platform authority with tenant login.

## Users and roles

- **Platform admin/operator:** authenticates as `PlatformUser`, receives a `PlatformSession`, and operates `/platform` organization, package/module, contract, lifecycle, jobs, and audit controls according to platform permissions. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`src/lib/platform/auth.ts`](../../src/lib/platform/auth.ts), [`src/app/platform/(console)`](../../src/app/platform/%28console%29).
- **Restaurant/tenant admin:** authenticates through the app/NextAuth realm as an organization `User`; it can use granted tenant modules but cannot become a platform operator. Evidence: [`src/lib/auth.ts`](../../src/lib/auth.ts), [`src/server/trpc.ts`](../../src/server/trpc.ts).
- **Terminal operator:** is a staff profile in a third, device-authenticated realm and is neither of the above. Evidence: [`src/lib/restaurant/terminal-auth.ts`](../../src/lib/restaurant/terminal-auth.ts), [`tests/restaurant-m2-contract.test.ts`](../../tests/restaurant-m2-contract.test.ts).

## Current behaviour

- The server-owned module catalog maps tRPC procedures, API scopes, and routes to module keys; the restaurant vertical catalog owns restaurant modules, mandatory modules, roles/capabilities, and limits. Evidence: [`src/lib/module-catalog.ts`](../../src/lib/module-catalog.ts), [`src/lib/vertical-catalog.ts`](../../src/lib/vertical-catalog.ts), [`src/lib/module-catalog.test.ts`](../../src/lib/module-catalog.test.ts) — `dispatches the dashboard route by organization vertical`.
- Effective entitlements resolve organization vertical, enabled modules, limits, and seats from mandatory vertical modules, active same-vertical package links, contract modules, and time/status-valid organization overrides. Explicit disable/zero overrides take precedence; onboarding no longer copies package modules into override rows. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`src/lib/platform/commands.package-inheritance.test.ts`](../../src/lib/platform/commands.package-inheritance.test.ts), [`tests/production-bootstrap.test.ts`](../../tests/production-bootstrap.test.ts) — `creates the foundation once and preserves deliberate account and entitlement changes`.
- Type-first onboarding requires an explicit AGENCY or RESTAURANT selection, preselects neither, filters packages server-side to that vertical, stamps the vertical, and creates restaurant branch foundations only for RESTAURANT. The command rechecks a crafted mismatch. Evidence: [`src/app/platform/(console)/organizations/new/page.tsx`](../../src/app/platform/%28console%29/organizations/new/page.tsx), [`src/lib/platform/commands.ts`](../../src/lib/platform/commands.ts), [`src/app/platform/(console)/organizations/new/page.test.tsx`](../../src/app/platform/%28console%29/organizations/new/page.test.tsx) — `requires an explicit type choice and preselects neither vertical` and `filters packages server-side by the chosen vertical and submits it explicitly`; [`tests/agency-onboarding-regression.test.ts`](../../tests/agency-onboarding-regression.test.ts) — `creates the organization without touching restaurantBranch or restaurantBranchAssignment`.
- Platform-console login uses `/api/platform/session` and a platform cookie; app login uses the tenant authentication path and may resolve organization candidates. These are distinct authentication realms, not two screens over one session. Evidence: [`src/app/api/platform/session/route.ts`](../../src/app/api/platform/session/route.ts), [`src/app/platform/(auth)/login/page.tsx`](../../src/app/platform/%28auth%29/login/page.tsx), [`src/lib/auth/login-candidates.ts`](../../src/lib/auth/login-candidates.ts).

## Data model

`PlatformModule`, `PlatformPackage`, package-module links, contracts/contract modules, `Organization.vertical`, `OrganizationModule`, limits, `PlatformUser`, `PlatformSession`, and tenant `User`/membership models are canonical. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma).

## API surface

- Platform realm: `/platform/*`, `/api/platform/session`, `/api/platform/control`, `/api/platform/mfa`, `/api/platform/support`, and jobs processing. Evidence: [`src/app/platform`](../../src/app/platform), [`src/app/api/platform`](../../src/app/api/platform).
- Tenant realm: entitlement context/provider, middleware/route and tRPC procedure gates, organization settings display. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`src/components/entitlements-provider.tsx`](../../src/components/entitlements-provider.tsx), [`src/lib/module-catalog.ts`](../../src/lib/module-catalog.ts).

## Edge cases and failure modes

- Missing/disabled/expired module, wrong vertical package/module, explicit zero limits, seat exhaustion, inactive organization, and attempted late vertical correction fail closed. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`src/lib/platform/commands.ts`](../../src/lib/platform/commands.ts), [`src/app/platform/(console)/organizations/[id]/page.test.tsx`](../../src/app/platform/%28console%29/organizations/%5Bid%5D/page.test.tsx) — `withdraws the correction once a vertical-owned branch exists`.
- A platform session does not silently grant tenant membership; support access is separately scoped and attributed. Evidence: [`src/lib/tenancy/support-session.ts`](../../src/lib/tenancy/support-session.ts), [`src/lib/tenancy/tenant-actor.ts`](../../src/lib/tenancy/tenant-actor.ts).

## Gaps

- **NOT IMPLEMENTED:** a claim that every module has a complete end-user surface merely because it exists in the catalog; catalog presence is licensing metadata, not feature acceptance.
- **NOT IMPLEMENTED:** unified platform/app login or session interchange; the required behavior is separation.
- **PARTIAL:** external provisioning, deployment, identity-provider, and commercial integrations depend on configured environments/providers and are not proven live by local code alone. Evidence: [`src/lib/platform/jobs.ts`](../../src/lib/platform/jobs.ts).
