# Administration Platform Changelog

## 2026-11-01

### Security

- **SOP and back-office order approvals now verify identity on the server
  (H5).** SOP commands, evidence uploads and role-pool claims are recorded
  against the signed-in user's own staff profile. Client-supplied actor ids are
  ignored. SOP waivers and back-office order item voids/cancellations
  (`restaurantOrders.voidItem` / `cancel`) no longer accept an approver id on its
  own. The approver must present their own PIN or badge (`approvingCredential`
  on orders; `approvingType` / `approvingSecret` on waivers). The server checks
  it with a durable lockout and requires the approver's permission at the
  record's branch (`coauth:approve` for orders, `sop:verify` for waivers). The
  approver must be a different person. The one exception is the workspace's only
  active staff member, who must be an owner: they may approve their own request
  by re-entering their PIN, and the co-authorization record is stamped
  `[Owner PIN reauthentication]`.
- **Behaviour change: an active staff profile is now required to act.** SOP
  commands and back-office order voids/cancellations are recorded only as the
  signed-in user's own staff profile. A user with profiles at several branches
  acts as their profile for the record's branch. Organization-wide supervisors
  (`restaurant:configure` / `sop:verify`) with no active staff profile can still
  read SOP boards, but they can no longer record SOP work or void/cancel orders.
  Link them to a staff profile before rollout. The orders console no longer asks
  for an "acting staff member". When an approver is named, it asks for that
  approver's PIN or badge.
- **Known limitation.** Approver PIN failures share the terminal sign-in lockout
  counter, so repeated wrong guesses on the back-office path can lock a
  manager's PIN. There is no separate rate limit on that path yet.

## 2026-08-02

### Added

- Standard shared-host login. One host (`www` in production, `staging.devfathom.com`
  on staging) serves every standard tenant with no workspace slug and no
  `workspace=` parameter in the URL. Credentials are proven first; the eligible
  workspaces are revealed only afterwards. One workspace continues straight
  through, several render a selection screen, and the chosen organization travels
  in the session, never in the address bar. Standard tenants remain on the shared
  host after selection — see [ADR-003](adr/003-shared-host-login.md).
- `shared` host classification, checked before the base-domain suffix rule, with
  `www`, `admin`, `app`, `api` and `staging` reserved as non-assignable
  organization slugs.
- `PendingLoginIntent` — a control-plane, single-use, host-bound record of the
  candidate set the server computed when the password was proven. A submitted
  organization id is validated against it and is never authority on its own.
- `login-intent` Auth.js credentials provider, mirroring the enterprise SSO
  provider: a one-use handle exchanged for a normal JWT carrying `organizationId`.
- Anonymous endpoints for shared-host credentials (`/api/login`) and password
  reset (`/api/password-reset`), plus token-scoped anonymous access to the invite
  and reset tRPC procedures.
- `SHARED_APP_HOSTS` for naming a shared host that follows no reserved-label rule.

### Fixed

- **Session revocation was not enforced.** A token marked revoked could still read
  and write tenant data: the guard only fired when `status` was truthy, so a
  session carrying no status passed straight through. Revocation is now its own
  claim, `status` only ever holds a real `UserStatus`, and one fail-closed decision
  point is shared by the API, the page guard and the actor resolver. A revoked
  session is told its session ended and sent to sign in, not told to contact an
  administrator. (GitHub #16)
- **Mixed-case addresses could not sign in.** `users.email` is unique per
  organization on the raw string with no `citext` and no functional index, and the
  login query used the raw value. Emails are normalized at the schema layer and
  constrained to lower case in the database.
- **SSO JIT silently provisioned duplicates.** A returning user whose IdP asserted
  a different casing did not match the stored row and got a second account in the
  same organization. Every user-creation path now pre-checks the normalized
  address and reports a stated conflict.
- **Invite and password reset were unreachable anonymously.** The tRPC transport
  answered 401 before any router ran, and the forgot-password form swallowed the
  failure and showed its confirmation regardless, so no reset link was ever sent.
- **The shared apex resolved a random tenant.** Deployment-URL resolution used a
  substring match with no ordering, so a request for the bare apex matched every
  tenant deployment row.
- `safeCallbackUrl` moved server-side and hardened; traversal that resolves into a
  protocol-relative URL is now refused.
- `/forgot-password`, `/reset-password/[token]` and `/invite/[token]` had no `<h1>`;
  the login hero contributed a competing second one.

## 2026-07-28

### Added

- DevFathom Studio platform shell, responsive navigation drawer, tenant-aligned authentication,
  light/dark themes, reduced-motion behavior, and shared platform page primitives.
- Canonical repository-wide UI/UX contract with tokens, component/page recipes, accessibility,
  motion, responsive behavior, visual QA gates, and mandatory agent instructions.
- Seller-operated control desk with platform operators, MFA, capability checks, audit ledger, settings, and role-safe sessions.
- Manual customer-agency onboarding, lifecycle transitions, profile, package, deployment mode, activation validation, suspension, retention, and purge scheduling.
- Module catalog, packages, contract modules, organization overrides, limits, usage counters, seats, expiry, and grace handling.
- Sales accounts, leads, contacts, opportunities, stage history, proposals, follow-ups, conversion, contracts, invoices, payments, and renewals.
- Organization administration for members, passwords, custom roles, deny/allow permissions, profile, brand, domains, email, SCIM, and entitlement visibility.
- OIDC and SAML SSO with state/replay protection, PKCE/nonce, JIT, role mapping, allowed domains, and short-lived sign-in tickets.
- SCIM 2.0 Users, Groups, Schemas, ResourceTypes, ServiceProviderConfig, pagination, filtering, PATCH/PUT, token rotation, and event audit.
- Shared and dedicated provisioning jobs, DNS verification, brand application, identity validation, private export, suspension/resumption, and purge.
- One-use, encrypted, cross-domain support launch tickets for shared, custom, dedicated, and localhost hosts.
- Tenant-aware REST, file, upload, assistant, realtime, and tRPC boundaries.
- PostgreSQL RLS, scoped query facades, organization-scoped unique keys, and composite foreign-key integrity.
- Full migration baseline, configuration example, cron worker route, worker CLI, unit/security tests, RLS verifier, and this operating handbook.

### Fixed during QA

- Replaced the platform control plane's disconnected legacy admin theme with the same fog, paper,
  ink, coral, typography, rounded geometry, and navigation language as the tenant workspace.
- Removed a reduced-motion hydration mismatch by keeping page-transition markup deterministic and
  disabling motion through CSS media queries.
- Prevented admin-host redirects from intercepting Next.js assets and breaking hydration.
- Corrected public-origin reconstruction behind proxies for platform mutations, support redirects, SSO callbacks, SCIM locations, and REST specification URLs.
- Prevented interactive platform pages and APIs from being served on tenant/dedicated hosts.
- Added server-render prefetch fallback so an optional dashboard optimization cannot fail the authenticated page.
- Disabled Ably initialization when realtime is not configured.
- Removed platform and tenant login credential leakage through native GET form fallback.
- Fixed fixed-sidebar content overflow and null textarea rendering.
- Serialized both application calls and Prisma-emitted relation statements on transaction-bound PostgreSQL clients for `pg` 9 forward compatibility.
- Upgraded Next.js to 16.2.12, Auth.js to beta.32, Prisma to 7.9.1, and applied compatible Sharp/PostCSS security resolutions after the final dependency audit.

### Operational note

No live dedicated Azure environment, production DNS record, customer IdP, email sender, or payment provider was created by local QA. Those remain deployment-time integrations, not missing application code.
