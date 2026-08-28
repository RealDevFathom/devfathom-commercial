# ADR-006: "Workspace" Means Organization

Status: Accepted and implemented, 2026-08-28. Issue WHA-276.

## Context

The tenant chrome shows an organization name, logo and palette under the fixed
subtitle "Company workspace" (`src/components/layout/topbar.tsx`,
`src/components/layout/sidebar.tsx`), and the sidebar's primary navigation group
is labelled "Workspace". Nothing in the product defined what a workspace _is_,
so two readings were live at once:

- **Organization.** A workspace is the tenant. There is exactly one per session
  and it is `session.user.organizationId`.
- **Presentation-only.** A workspace is a view or grouping inside an
  organization, in which case roles, settings and staff are organization-shared
  and the chrome's company identity is decorative — and misleading.

The two readings imply opposite work. Under the first, any switch must re-scope
the authenticated session and every org-scoped read. Under the second, the false
company identity has to come out of the chrome and org-shared surfaces have to
disclose that they are shared.

The repository already answers the question, but only implicitly:

- `Organization` is the tenant boundary and every tenant table is RLS-forced to
  it (ADR-001). There is no sub-organization scope in the schema.
- `resolveTenantActor` (`src/lib/tenancy/tenant-actor.ts`) resolves exactly one
  organization per request and refuses any request where the host and the
  session disagree (`409 This session belongs to a different workspace`).
- `createTRPCContext` (`src/server/trpc.ts`) derives the effective tenant as
  `organization?.id ?? session.user.organizationId`, so all org-scoped data
  already follows the session.
- There is no workspace switcher anywhere in the product. Changing organization
  is only possible by re-authenticating; on the shared host a member whose email
  exists in several organizations chooses one at login
  (`src/lib/auth/login-candidates.ts`, `src/lib/auth/shared-login.ts`, ADR-003).

So the _data_ plane already behaves as if workspace means organization. Only the
_presentation_ plane was unpinned, and it had a real gap.

### The gap

The shell's brand is a server prop, resolved once when the `/(app)` layout
renders, from the organization in the session cookie at that instant. The
effective tenant is re-resolved from the _current_ cookie on every subsequent
request. The App Router keeps a shared layout mounted across client navigation,
so the two can drift apart:

1. A member of both Acme and Borealis signs into Acme on the shared host. The
   shell renders with Acme's name, logo and brand palette.
2. In a second tab the member signs into Borealis. The Auth.js JWT is host-wide,
   so this rewrites the cookie for the first tab too.
3. The first tab keeps its mounted layout. Every tRPC query, mutation and route
   handler it issues now resolves Borealis — but the topbar, sidebar, logo and
   brand colours still say Acme.

`SessionProvider` was mounted with `refetchOnWindowFocus={false}`, so the stale
tab never re-read `/api/auth/session` and never had the chance to notice.

This is not an RLS failure — the data returned is correctly Borealis's. It is an
identity failure: the user is shown one company's branding over another
company's data, which is precisely the confusion a multi-tenant product must
never create.

## Decision

**A workspace is an organization.** The terms are synonymous in the product,
the schema and the UI. Specifically:

- **D1.** There is exactly one workspace per authenticated session, and its
  identity is `session.user.organizationId`. No sub-organization workspace scope
  exists or may be introduced without superseding this ADR.
- **D2.** Switching workspace means re-authenticating. There is no in-app
  switcher, because a switch is a new JWT carrying a new `organizationId`, which
  re-scopes every org-scoped read through the existing tenant context. Login-time
  organization selection on the shared host (ADR-003) is the switch.
- **D3.** The chrome's "Company workspace" subtitle and the "Workspace"
  navigation group are truthful under D1 and stay. Roles, settings and staff are
  organization-scoped, not shared across some wider scope, so no
  "organization-shared" disclosure is owed.
- **D4 — the invariant.** _Displayed workspace identity may never diverge from
  `session.user.organizationId`._ Chrome that cannot prove which organization it
  describes, or that describes a different one than the live session, must not
  render.

D4 is enforced structurally rather than by convention:

- `TenantBrand` carries the `organizationId` it was resolved for, so a brand is
  always attributable. The `/(app)` layout populates it from
  `actor.organization.id`, which `resolveTenantActor` has already proven equal to
  the session's organization.
- `isTenantIdentityMismatch` (`src/lib/tenant-brand.ts`) compares that against
  the live session. It fails closed on an unattributable brand, and treats an
  absent session organization as "not yet hydrated" rather than a mismatch, so
  it never blanks the app during hydration.
- On mismatch, `AppShell` renders neither the chrome, nor the brand palette, nor
  `children` — only an interstitial offering a reload, which re-runs the layout
  against the current cookie and self-heals.
- `SessionProvider` refetches on window focus, which is the moment a user
  returns to a stale tab, so the mismatch is actually observed.

## Consequences

Benefits:

- The invariant is a property of the render path, not a rule contributors must
  remember. A brand cannot be displayed without an organization to attribute it
  to, because the type requires one.
- The safe state shows _no_ tenant identity, so the failure mode of the guard is
  an obviously broken page rather than a quietly wrong company name.
- No new tenancy concept, schema change, or migration; the data plane was
  already correct.

Costs:

- `SessionProvider` now issues a `/api/auth/session` request when a tab regains
  focus. This was previously suppressed for cost; the invariant cannot be
  observed client-side without it.
- The mismatch window is closed at focus and at reload, not instantly. A
  background tab that is never focused again can still hold stale chrome — but
  it also cannot be read or acted on without being focused first.
- Adding a genuine multi-workspace switcher later requires superseding D2, not
  merely adding UI.

## Rejected alternatives

- **Workspace as a presentation-only grouping.** Rejected: nothing in the schema
  or the request path supports a scope between user and organization (ADR-001),
  so this reading would have required inventing a tenancy concept in order to
  then label it as shared. It would also have meant removing truthful company
  identity from the chrome.
- **Render the workspace name from the session instead of the server brand.**
  Rejected: the session carries `organizationId`, `organizationSlug` and
  `organizationStatus`, but not the organization's display name, logo or brand
  colours. This would trade a stale-but-rich identity for a live-but-degraded
  one, and would still leave the logo and palette stale.
- **Re-resolve the brand on every navigation.** Rejected: it fights the App
  Router's layout model for a narrower guarantee. It would refresh the name on
  navigation but still leave a tab that is merely focused, not navigated,
  showing the wrong company.
- **Sign the stale tab out on mismatch.** Rejected: the session is valid, just
  for a different organization. Destroying it would also sign out the tab the
  user deliberately switched in.
- **Accept the divergence as cosmetic.** Rejected: showing one customer's
  branding over another customer's data is a tenancy-confusion defect, and the
  shared host makes it reachable without any attacker.

## Evidence

`src/lib/tenant-brand.ts`, `src/app/(app)/layout.tsx`,
`src/components/layout/app-shell.tsx`, `src/components/tenant-session-boundary.tsx`.

Tests: `src/lib/tenant-brand.test.ts` and
`src/components/layout/app-shell.tenant-identity.test.tsx`. The divergence tests
fail against the pre-change shell (the stale organization's name renders, and its
brand palette is applied) and pass after it.
