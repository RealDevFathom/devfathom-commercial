# Support impersonation authority

Support uses a tenant administrator's identity for authorized tenant reads, with the original platform operator retained for audit attribution. The identity never grants write authority. Both the support identity and the session marker trigger the restriction; the earlier absolute expiry applies. Non-finite session durations are rejected and the existing five-to-sixty-minute duration bounds remain in force.

The shared active-user and capability guards reject support mutations and subscriptions before resolvers run. The public procedure guard also rejects support mutations, including invitation acceptance and password reset. This covers `organizationAdmin.createMember`, `updateMember`, `resetMemberPassword`, `createScimToken`, `team.inviteMember`, both password-reset paths, API token creation for self or others, and device/operator credential issuance. Normal administrator behavior remains available.

Route-handler tracing found these authentication boundaries:

- `/api/trpc/*` passes the effective actor to the shared procedure guards, including POST queries and batched mutations. Context creation preserves that actor over an ambient Auth.js session.
- Tenant HTTP adapters resolve the actor directly or through `createTRPCContext`: upload, assistant, browser enrollment, print bridge, receipt layout, report exports, SOP evidence, pharmacy print and prescription files, camera streams and private file delivery. Support receives no actor on unsafe HTTP methods. The Ably GET token issuer also receives no support actor because its credentials permit publish/presence and have an independent lifetime.
- Restaurant terminal and pharmacy counter handlers require independent device/session secrets; support cannot issue those credentials through the protected tenant mutations or browser enrollment. Demo device/reset paths also resolve the actor and cannot gain support write authority.
- REST `/api/v1`, SCIM, platform control, wallet enrollment, SSO, callbacks, cron and webhooks use separate bearer credentials, platform authentication, verification or public flows. They do not turn a support cookie into tenant ADMIN authority. Public meeting admission receives no impersonated actor on POST. Support launch and end retain their separate, bounded lifecycle service.

A rejected support cookie cannot fall back to a normal tenant JWT on a tenant host, including server-component resolution. Shared-host behavior continues to ignore the tenant support cookie.

# Validation

The following targeted regression command passed 454 tests across 24 files, without skips:

```sh
node_modules/.bin/vitest run \
  src/server/trpc.test.ts \
  src/server/trpc-error-formatter.test.ts \
  src/lib/tenancy/tenant-actor.test.ts \
  src/lib/tenancy/support-access.test.ts \
  tests/support-session-hardening.test.ts \
  tests/support-session-api.test.ts \
  src/server/routers/organization-admin.members.test.ts \
  src/server/routers/organization-admin.departments.test.ts \
  src/server/routers/organization-admin.overview.test.ts \
  src/server/routers/organization-admin.profile.test.ts \
  src/server/routers/organization-admin.ask-fathom.test.ts \
  src/server/routers/team.invite.test.ts \
  src/app/api/trpc/anonymous-transport.test.ts \
  src/app/api/trpc/revoked-session-seam.test.ts \
  src/app/api/trpc/transaction-boundary.test.ts \
  src/app/api/upload \
  src/app/api/restaurant/devices/browser-enroll \
  src/app/api/restaurant/receipt-layout \
  src/app/api/restaurant/print-bridge \
  src/app/api/restaurant/sop/evidence \
  src/app/api/pharmacy/print \
  src/app/api/assistant
```

Actual local PostgreSQL integration:

```sh
node scripts/run-support-security-postgres.mjs
```

The runner requires a local `DATABASE_URL` with permission to create a disposable database and restricted login. It clones schema only, passes the disposable connection through `DATABASE_URL` and `TEST_DATABASE_URL`, and runs:

```sh
node_modules/.bin/vitest run tests/support-read-only.db.test.ts tests/support-session-hardening.db.test.ts
```

All nine tests passed, without skips, using `NOSUPERUSER NOBYPASSRLS`. Real actor resolution, support launch/expiry/revocation, ABAC, routers, hashing and RLS are exercised; only outbound email is replaced. The tests compare database state after blocked support calls and positively verify normal admin token creation, SCIM, invitation, elevation and temporary password reset. The runner removes its database and login in `finally`; it does not print connection secrets.

`node_modules/.bin/tsc --noEmit`, targeted ESLint, Prettier verification and `git diff --check` also passed. Existing tests were retained unchanged except for additive regression coverage.
