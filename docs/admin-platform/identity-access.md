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

Auth.js credentials sessions include organization ID/slug/status, role, department, title, account status, and token version.

Controls include:

- constant-time/dummy bcrypt comparison against unknown accounts;
- per-IP and per-account rate limits;
- allow-list account status;
- organization lifecycle gate;
- tenant TOTP and single-use recovery codes;
- token-version revocation after password/reset/deactivation changes;
- periodic database revalidation;
- host-to-session organization match.

SSO enforcement disables password login only after the password is proven, avoiding account enumeration.

## Tenant authorization

Baseline roles (`ADMIN`, `HR`, `EMPLOYEE`) remain supported. Organization custom roles add capability rules. User-specific overrides are final.

Rules use exact capabilities or namespace wildcards such as `projects:*`. Evaluation is deny-by-default and explicit `DENY` wins over `ALLOW`. System administrator/member roles cannot be removed or edited through product commands.

tRPC procedures use protected/admin/capability/module middleware. REST uses user-bound API token scopes plus module checks. Files, uploads, assistant, and realtime resolve the same tenant actor.

## OIDC

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
8. only then set SSO enforcement.
