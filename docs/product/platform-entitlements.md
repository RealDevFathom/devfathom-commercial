# Platform & entitlements PRD

## Problem

Platform operators need one typed commercial catalog and a deterministic effective-entitlement view for onboarding and governing organizations without entering restaurant operations. The catalog sources are `src/lib/vertical-catalog.ts` and `src/lib/module-catalog.ts`; control-plane guidance is `docs/admin-platform/control-plane.md`.

## Users and roles

- Platform-admin identities authenticate to the platform console and exercise platform capabilities from `src/lib/platform/auth.ts`; they create organizations, assign packages/contracts/overrides, and support operations.
- Restaurant-admin identities authenticate through the application login and administer only their tenant. App login candidate selection is in `src/lib/auth/login-candidates.ts`; restaurant authorization is enforced by tenant routers and ABAC in `src/lib/abac/policies.ts`.
- These are separate auth realms and routes: platform login/session are `src/app/platform/(auth)/login/page.tsx` and `src/app/api/platform/session/route.ts`; application login is `src/app/login/page.tsx` and `src/app/api/login/route.ts`.

## Current behaviour

- The vertical catalog defines restaurant modules, mandatory Restaurant Core, limit keys, role templates, and three widening commercial packages. See exact tests `lists exactly the ten commercial modules`, `marks Restaurant Core as the single mandatory module (§6.1)`, and `package tiers widen: Essentials ⊆ Operations ⊆ Enterprise modules` in `src/lib/vertical-catalog.test.ts`.
- Route-to-module mapping is centralized in `src/lib/module-catalog.ts` and tested by `module catalog routing` in `src/lib/module-catalog.test.ts`.
- Effective entitlements combine package defaults, live contracts, and overrides; the organization console surfaces the effective source in `src/app/platform/(console)/organizations/[id]/page.tsx`, tested by `OrganizationDetailPage effective entitlement source` in its adjacent test.
- Onboarding is type-first: no vertical is preselected, and the operator chooses the organization type before its form. See `src/app/platform/(console)/organizations/new/page.tsx` and `NewOrganizationPage type-first choice` in its adjacent test.

## Data model

Organization vertical/type, package/subscription, module entitlement, limit and override records are defined in `prisma/schema.prisma`. Catalog constants remain typed in `src/lib/vertical-catalog.ts`; effective evaluation lives in `src/lib/entitlements.ts`.

## API surface

Platform console mutations use `src/app/api/platform/control/route.ts` and commands in `src/lib/platform/commands.ts`, guarded by `requirePlatformSession`/`assertPlatformCapability` from `src/lib/platform/auth.ts`. Tenant routes consume effective entitlement checks through `src/lib/entitlements.ts` and route mapping from `src/lib/module-catalog.ts`.

## Edge cases and failure modes

- Package/vertical mismatch is rejected server-side; see `assertPackageCompatibleWithVertical rejects a mismatch (server-side bypass guard)` in `src/lib/vertical-catalog.test.ts`.
- Vertical correction is restricted to early onboarding before activation/vertical-owned rows; see `src/lib/platform/commands.ts` and `offers the correction while onboarding, unactivated, and free of vertical rows` in `src/app/platform/(console)/organizations/[id]/page.test.tsx`.
- Organization suspension and disabled POS entitlement invalidate terminal trust; see `rejects a device whose organization is suspended with 401` and `rejects a trusted device with 403 when restaurant-pos is disabled` in `src/lib/restaurant/terminal-auth.test.ts`.

## Gaps

- Automated billing-provider synchronization and proration for entitlement changes: **NOT IMPLEMENTED**; current sources are internal package/contract/override records in `src/lib/entitlements.ts`.
- Cross-realm SSO federation and delegated restaurant-admin access from a platform session: **NOT IMPLEMENTED**; separate routes remain authoritative in `src/app/api/platform/session/route.ts` and `src/app/api/login/route.ts`.
