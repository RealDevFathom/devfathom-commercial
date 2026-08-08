# Administration Platform Changelog

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
