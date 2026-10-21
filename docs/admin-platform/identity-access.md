# Identity, Authentication, and Authorization

## Platform operators

Platform authentication is separate from tenant Auth.js:

- password hashes use bcrypt;
- sessions are opaque random tokens stored only as hashes;
- cookies are HttpOnly, Secure in production, SameSite Strict, and eight-hour bounded;
- disabled operators and expired/revoked sessions fail closed;
- roles map to platform capabilities;
- password policy is enforced at creation/update;
- login and mutation attempts are rate limited;
- login forms use POST fallback and exact-origin JSON mutations.

### Platform MFA

Operators can enroll TOTP, confirm a valid code, receive one-time recovery codes, regenerate/revoke recovery state, and use TOTP or recovery code at login. Secrets are AES-256-GCM encrypted with `PLATFORM_ENCRYPTION_KEY`; recovery codes are stored as hashes. SUPER_ADMIN can reset another operator’s MFA through an audited command.

## Tenant authentication

Auth.js credentials sessions include organization ID/slug/status, role, department, title, account status, session validity, and token version.

Email addresses are normalized — trimmed and lower-cased — at the schema layer, so
every caller inherits one canonical form for both storage and lookup.

Controls include:

- constant-time/dummy bcrypt comparison against unknown accounts;
- per-IP and per-account rate limits;
- allow-list account status;
- organization lifecycle gate;
- tenant TOTP and single-use recovery codes;
- token-version revocation after password/reset/deactivation changes;
- periodic database revalidation, failing CLOSED on database errors;
- host-to-session organization match on tenant, custom and dedicated hosts;
  session-claim organization plus an explicit lifecycle gate on the shared host.

SSO enforcement disables password login only after the password is proven, avoiding account enumeration.

### Session validity

Session revocation is its own JWT claim (`sessionRevoked`, with a reason), never a
value written into `status`. `status` only ever holds a real `UserStatus`
(`ACTIVE | INACTIVE | ON_LEAVE | INVITED`). Overloading one field with two
orthogonal facts made a dead _session_ indistinguishable from a deactivated
_account_ — opposite remedies — and let one guard read a fact another guard did not.

`src/lib/auth/session-state.ts` is the single decision point, used by the tRPC
middleware, the `/(app)` page guard and the tenant actor resolver, so they cannot
disagree about one session. It fails CLOSED: a session whose status cannot be
proven active is rejected. A revoked, deleted or unverifiable session is told
"Your session has ended. Please sign in again." and redirected to sign-in; only a
genuinely inactive account is told to contact an administrator.

Revalidation fails closed on database errors. An unverifiable session is not an
authorized one, and the application cannot serve tenant data without the same
database anyway, so failing open would buy no availability — only an unrevocable
window. Recovery is a fresh sign-in, or the next successful revalidation.

### Standard shared-host sign-in

Standard customers sign in at one shared host (`www` in production,
`staging.devfathom.com` on staging). The URL carries no workspace slug and no
`workspace=` parameter at any point, and standard tenants remain on that host
after selection — see [ADR-003](adr/003-shared-host-login.md).

1. Email and password are submitted to `POST /api/login`.
2. Discovery runs in the explicitly privileged platform scope, with the normalized
   email as its only predicate, a hard field whitelist, and a cap of ten
   candidates. Beyond the cap the attempt is audited and treated as a failure.
3. The password is compared against EVERY candidate. Eligible means the password
   matched AND the account status is sign-in-allowed AND the organization
   lifecycle is accessible.
4. Zero candidates still performs one bcrypt compare against the dummy hash, so
   response time does not reveal existence. "No such address", "wrong password"
   and "no eligible organization" return one identical body with no cookie.
5. Exactly one eligible workspace continues straight through; more than one
   renders a selection screen.
6. Selection exchanges a single-use, host-bound login intent for a normal Auth.js
   session carrying the chosen `organizationId`. A submitted organization id is
   accepted only if it belongs to the candidate set the server computed in step 3,
   and a forged id does not consume the intent.
7. The second factor is enforced at selection, because the user is only known once
   a workspace is chosen. The intent is consumed after the code verifies, so a
   mistyped code does not force the password to be re-entered.
8. Sign-out clears organization-selection state as well as authentication.

An SSO-enforced workspace is shown on the picker, visibly non-selectable and
labelled, with a link to its own host where its SSO flow begins. It carries no
intent candidate, so there is no password path into it even if the client is
bypassed. If every eligible workspace enforces SSO, an SSO-only screen replaces
the picker.

Pre-selection failures are attributed to the candidate organizations' audit
ledgers; a failure with no candidates stays org-less rather than being guessed
into a tenant ledger.

## Tenant authorization

Baseline roles (`ADMIN`, `HR`, `EMPLOYEE`) remain supported. Organization custom roles add capability rules. User-specific overrides are final.

Rules use exact capabilities or namespace wildcards such as `projects:*`. Evaluation is deny-by-default and explicit `DENY` wins over `ALLOW`. Separation of duties: `pharmacy:dispense`, `pharmacy:safety` and `pharmacy:catalogue-review` are granted only by an exact `ALLOW` rule; neither `*` nor `pharmacy:*` grants them (so the administrator `*` and the pharmacy Owner `pharmacy:*` templates do not include them), while a wildcard `DENY` still revokes them. System administrator/member roles cannot be removed or edited through product commands.

tRPC procedures use protected/admin/capability/module middleware. REST uses user-bound API token scopes plus module checks. Files, uploads, assistant, and realtime resolve the same tenant actor.

## OIDC

Enterprise SSO runs on tenant, custom and dedicated hosts only. The redirect URI
is derived from the request host and registered at the customer IdP, and
`df_sso_ticket` is host-only with host → organization → `withTenantDb` → RLS as
its only tenant binding. The shared host therefore never starts an SSO flow; it
links out to the organization's own host.

An active licensed OIDC connection supports:

- issuer discovery;
- client ID and encrypted client secret;
- PKCE;
- nonce and one-use state;
- exact tenant public callback URL behind proxies;
- ID token claim validation through `openid-client`;
- allowed email domains;
- configurable role-claim mapping;
- JIT provisioning when allowed;
- active-user/seat checks;
- short-lived one-use ticket into Auth.js.

The platform identity “test” job validates discovery endpoints and records `ACTIVE` or `ERROR`.

## SAML 2.0

The ACS/recipient, issuer and audience are derived from the request host and
registered at the customer IdP, so SAML is likewise tenant/dedicated-host only.

An active licensed SAML connection supports:

- IdP SSO URL, issuer/entity ID, certificate;
- generated service-provider metadata;
- signed assertion requirement;
- audience, recipient/callback, clock skew, and request ID validation;
- database-backed request cache and one-use relay state;
- allowed email domains, role mapping, JIT, seats;
- short-lived one-use ticket into Auth.js.

IdP certificates and client secrets are encrypted or treated as sensitive configuration and are never returned in control-plane views.

## SCIM 2.0

Base path: `/api/scim/v2`.

Implemented resources:

- `ServiceProviderConfig`;
- `Schemas`;
- `ResourceTypes`;
- `Users` list/create and `Users/{id}` get/put/patch/delete;
- `Groups` list and `Groups/{id}` get/patch.

Features include bearer tokens, hashed storage, prefix-only display, expiry/revocation/last-used tracking, pagination, basic filtering, SCIM content types/errors, idempotent active-state changes, tenant role mapping, seat enforcement, and event audit.

Tokens are revealed once. Revocation immediately returns 401 on reuse.

## Audited support identity

Support access is not a forged tenant JWT. It uses its own database-backed session and one-use cross-domain launch ticket. The operator, impersonated tenant administrator, reason, organization, expiry, launch, actions, and end are auditable.

Access is limited to 60 minutes, shown in a banner, revoked on suspension, and preferred over any browser tenant JWT while active.

## Deployment acceptance

Before enabling enterprise identity for a customer:

1. configure a staging connection;
2. verify public callback/metadata URLs;
3. test valid, invalid, replayed, expired, wrong-audience, and wrong-domain identities;
4. confirm JIT role and seat behavior;
5. run SCIM create/update/deactivate/reactivate/group tests;
6. rotate and revoke a SCIM token;
7. verify audit entries;
8. confirm the customer signs in on their OWN host, not the shared host — SSO is
   host-bound and the shared picker only links out to it;
9. only then set SSO enforcement.

After enforcement, verify on the shared host that the workspace still appears on a
multi-workspace picker, is not selectable, and its SSO link reaches the customer
host. A member who cannot see their workspace at all will assume access was
removed.
