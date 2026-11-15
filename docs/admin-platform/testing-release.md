# Testing and Release Gates

## Automated suites

| Command                            | Coverage                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| `bun run typecheck`                | TypeScript across app, platform, routes, scripts                      |
| `bun run lint -- --max-warnings=0` | Next/React/TypeScript lint                                            |
| `bun run test`                     | Vitest unit/security/component tests                                  |
| changed-file Prettier check        | formatting of every file changed by this implementation               |
| `bunx prisma validate`             | Prisma schema/config                                                  |
| `bunx prisma migrate status`       | migration/database agreement                                          |
| `bun run test:rls`                 | forced policy and cross-tenant adversarial checks                     |
| `bun run build`                    | production route compilation/static generation                        |
| `bun run test:e2e`                 | repository Playwright suite when its target environment is configured |
| `git diff --check`                 | whitespace/conflict markers                                           |

Current unit coverage includes:

- module-to-page/procedure/API mapping;
- RFC TOTP vector, recovery-code hashing, and invalid input;
- ABAC wildcard, explicit deny, override, inactive/fail-closed behavior;
- host routing/normalization, including shared-host classification, the base-domain
  apex, reserved labels, explicitly configured shared hosts, and unrecognised hosts;
- platform password and exact-origin controls;
- public proxy origin reconstruction;
- platform-vs-tenant proxy boundaries and framework assets;
- platform command-form null handling;
- session usability: every revocation reason, the legacy sentinels, and the
  fail-closed missing-status case, plus a table-driven pass over every procedure
  builder (protected, admin, hr, capability) on a representative read AND write;
- email normalization (mixed case, whitespace, unicode) and a duplicate pre-check
  on every user-creation path — tenant invite, platform onboarding, SCIM create and
  replace, SSO JIT, and the assistant tool;
- login candidate discovery: one privileged transaction, the email as the only
  predicate, a hard field whitelist, and cap behaviour;
- login intent: creation, five-minute expiry, single-use consumption, replay
  rejection, host-binding rejection, and tampered/forged organization id rejection;
- shared-host resolution: one compare per candidate, the zero-candidate timing
  defence, per-organization password matching, every `OrganizationStatus`, the
  candidate cap, SSO-enforced marking, and audit attribution;
- the shared login endpoint: host gating, origin/CSRF gating, byte-identical
  failures with no cookie, single/select/SSO-only outcomes, and server-side
  callback-URL validation;
- `safeCallbackUrl` against a hostile-input table (encoded protocol-relative,
  authority-looking first segments, control characters, absolute and scheme URLs,
  and traversal that resolves into a protocol-relative URL);
- anonymous tenant resolution from a globally unique invite or reset token.

## RLS matrix

The verifier:

1. confirms PostgreSQL and refuses unsafe remote execution unless explicitly allowed;
2. discovers all `organizationId` tables;
3. asserts RLS enabled and forced;
4. creates two isolated organizations/users;
5. validates same natural keys can coexist;
6. validates tenant A cannot read/write tenant B;
7. validates missing session settings fail closed;
8. validates control tables require platform scope;
9. validates SSO state/ticket isolation and composite FK rejection;
10. validates that a tenant scope can neither read nor write a pending login
    intent, and that the by-email lookup login discovery performs returns nothing
    for another organization's member from a tenant scope;
11. rolls back fixture data.

Run it only against a disposable or approved test database:

```bash
TEST_DATABASE_URL='postgresql://...' bun run test:rls
```

## Browser QA matrix

Platform:

- login/hydration;
- all navigation routes;
- responsive horizontal containment;
- organization module/limit/role/domain/deployment forms;
- settings/MFA state;
- no framework-asset redirects.

Shared host (`www` / `staging`):

- the login URL carries no workspace slug and no `workspace=` parameter at any step;
- a wrong password and an unknown address produce identical responses and no cookie;
- one eligible workspace continues straight to the dashboard;
- several render the selection screen, and the chosen workspace never appears in the URL;
- an SSO-enforced workspace renders non-selectable with a working link to its own host;
- an all-SSO account gets the SSO-only screen rather than an empty picker;
- sign-out clears the pending selection as well as the session;
- `/login`, the session-ended notice, `/forgot-password` and the workspace picker
  at 375/768/1024/1440 in light and dark, plus `prefers-reduced-motion: reduce`;
- exactly one `<h1>` and no document horizontal overflow on every one of those.

The matrix is automated in `tests/e2e/visual-qa.spec.ts`, which writes screenshots
to `test-results/visual-qa/`. Run it in a FOREGROUND tab: a backgrounded tab
freezes `requestAnimationFrame` and makes Motion-driven panels look broken. Note
that `emulateMedia({colorScheme})` alone does NOT switch this app's theme — an
inline script in the root layout reads `localStorage` and stamps `data-theme`.

Tenant:

- credential login and dashboard;
- a differently-cased address reaches the same account;
- organization administration sections;
- profile mutation;
- effective modules and seats;
- module disable hides navigation and blocks direct route;
- inherited state restores;
- SCIM token issue/request/revoke;
- support launch/banner/end;
- console and server error review.

## Worker smoke

Create a disposable shared-provisioning job, then:

```bash
bun run platform:jobs -- --max-jobs=1
```

Expected result contains one claimed/succeeded job and a READY shared deployment. Dedicated AWS automation is not provider-verified and remains blocked until a controlled isolated environment reaches READY and passes acceptance.

## Fresh database gate

Do not rely only on a developer database:

1. create empty app/shadow databases;
2. apply all migrations;
3. seed temporary data;
4. run RLS, unit, lint, type, build;
5. inspect migration status;
6. delete the databases after evidence is captured.

The full-repository `bun run format:check` is not currently a clean baseline: it reports 49 legacy source files that predate this work. The release gate therefore checks every changed file and records the legacy debt in [STATUS](STATUS.md); do not silently mass-format unrelated modules in a feature release.

## Final release checklist

- [x] Type, lint, unit tests, changed-file formatting, and Prisma validation pass.
- [x] Fresh migrations and RLS pass.
- [x] Production build has no error/deprecation requiring action.
- [x] Browser smoke passes on admin and tenant hosts.
- [x] Shared worker smoke passes.
- [ ] Dedicated/IdP/DNS/email/Blob provider acceptance passes for enabled features.
- [ ] Required secrets are present and rotated from bootstrap values.
- [ ] SUPER_ADMIN MFA is enrolled.
- [ ] Backup/restore drill is current.
- [ ] Retention, support, and incident policies are approved.
- [x] Documentation status/changelog match the release.
- [x] No test credentials, tokens, exports, or environment files are committed.

## Evidence policy

Record command, date, environment, result, and any intentionally skipped external integration in [STATUS](STATUS.md). Never convert a local build into a claim that DNS, AWS resources, Blob, email, IdP, or production backup is configured.
