# API Reference

## Conventions

- Public URLs are reconstructed from `x-forwarded-host`/`host` and `x-forwarded-proto`; internal runtime origins are never returned.
- Tenant authority comes from an authenticated credential. On tenant, custom and dedicated hosts the host resolves the organization and the session must agree with it. On the shared host there is no host organization, so the organization comes from the session claim and the lifecycle gate is applied explicitly.
- A submitted organization ID is never authority on its own. The one endpoint that accepts one — shared-host workspace selection — validates it against a server-side, single-use, host-bound login intent that records the candidate set the server itself computed when the password was proven. An id outside that set is refused and does not consume the intent.
- JSON mutations validate input with Zod and return structured errors.
- Tenant REST and tRPC activity is audited; platform commands use the platform audit ledger; SCIM has its own event ledger.
- API tokens, SCIM tokens, sessions, and launch tickets are stored as hashes.

## Platform HTTP API

Interactive platform endpoints are available only on the admin host.

| Method/path | Authentication | Purpose |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| `POST /api/platform/session` | email/password plus MFA if enrolled; exact origin | create operator session |
| `DELETE /api/platform/session` | operator cookie; exact origin | revoke current session |
| `POST /api/platform/control` | operator cookie/capability; exact origin | execute typed platform command |
| `GET /api/platform/mfa` | operator cookie | enrollment/status |
| `POST /api/platform/mfa` | operator cookie; exact origin | enroll/confirm/regenerate/disable MFA |
| `POST /api/platform/support` | `support:write`; exact origin | create one-use audited support launch |
| `DELETE /api/platform/support` | `support:write`; exact origin | platform-side revocation when cookie is present |
| `GET                           | POST /api/platform/jobs/process` | `Authorization: Bearer <CRON_SECRET>` | recover/claim/process jobs |

`/api/platform/jobs/process` is a bearer-secret-protected worker endpoint. AWS scheduling (the `platform-jobs` schedule) is a production gate; it does not use a platform cookie.

### Platform command envelope

```json
{
  "action": "organization.transition",
  "payload": {
    "organizationId": "org_...",
    "status": "ACTIVE",
    "reason": "Signed contract and onboarding checklist completed"
  }
}
```

Commands return an action-specific result or a structured error. Capability mapping and schemas live in `src/lib/platform/commands.ts`.

## Tenant tRPC

Endpoint: `/api/trpc`.

The handler resolves tenant/support actor, validates the request host, opens one tenant transaction, and creates `TRPCContext`. Procedure middleware enforces:

- authenticated/active user;
- tenant administrator or required capability;
- module entitlement;
- audit behavior.

The organization administration router exposes:

| Procedure                             | Purpose                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `organizationAdmin.overview`          | organization, entitlements, brand, members, roles, domains, identity, SCIM, usage |
| `updateProfile`                       | display name, timezone, locale, contacts                                          |
| `updateBrand`                         | organization brand values                                                         |
| `updateEmail`                         | provider/sender/config and optional new encrypted key                             |
| `upsertRole` / `removeRole`           | manage non-system roles and permission rules                                      |
| `updateMember`                        | role/status/department/custom role                                                |
| `resetMemberPassword`                 | set a policy-valid password and revoke existing sessions                          |
| `addDomain` / `retryDomain`           | add DNS proof and queue verification                                              |
| `createScimToken` / `revokeScimToken` | rotate directory credentials                                                      |

All existing product routers remain available through the same tenant context.

## REST v1

Authentication: `Authorization: Bearer df_<token>`.

Token authentication resolves the bound organization in platform scope, then returns to a tenant-scoped database. It checks user/organization status, token expiry, rate limits, API module entitlement, scope, and admin role for finance.

| Resource | Paths |
| -------- | ----- |
| API reference | `GET /api/v1/spec` |
| projects | `GET /api/v1/projects`, `POST /api/v1/projects`, `GET /api/v1/projects/{id}`, `DELETE /api/v1/projects/{id}` |
| clients | `GET /api/v1/clients`, `POST /api/v1/clients`, `GET /api/v1/clients/{id}`, `DELETE /api/v1/clients/{id}` |
| tasks/boards/comments | `/api/v1/tasks`, `/api/v1/tasks/{id}`, `/comments`, `/boards/{id}` |
| invoices | `/api/v1/invoices`, `/api/v1/invoices/{id}` |
| transactions | `/api/v1/transactions`, `/api/v1/transactions/{id}` |
| finance summary | `GET /api/v1/finance/summary` |
| meetings | `GET                                                               | POST /api/v1/meetings` |
| team | `GET /api/v1/team` |

Scopes are documented by the live Markdown response at `/api/v1/spec`. Write scope implies read scope for the same resource; `*` grants all token scopes but never bypasses module, tenant, lifecycle, or finance-role checks.

## SCIM 2.0

Authentication: `Authorization: Bearer scim_<token>`. Responses use `application/scim+json`.

| Method/path | Behavior |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- | ------------------------------- | -------------------------------- |
| `GET /api/scim/v2/ServiceProviderConfig` | supported patch/filter/bulk/auth metadata |
| `GET /api/scim/v2/Schemas` | User and Group schemas |
| `GET /api/scim/v2/ResourceTypes` | resource metadata |
| `GET                                     | POST /api/scim/v2/Users` | paginated/filterable list and create/JIT-like provisioning |
| `GET                                     | PUT                                       | PATCH                                                      | DELETE /api/scim/v2/Users/{id}` | read, replace, patch, deactivate |
| `GET /api/scim/v2/Groups` | organization role list |
| `GET                                     | PATCH /api/scim/v2/Groups/{id}` | read and member patch |

The bearer token determines organization. The host must resolve to the same organization.

## SSO HTTP endpoints

| Path                                         | Purpose                                     |
| -------------------------------------------- | ------------------------------------------- |
| `GET /api/sso/oidc/{connectionId}/start`     | discovery, PKCE/nonce/state, IdP redirect   |
| `GET /api/sso/oidc/{connectionId}/callback`  | code grant, claims/JIT, SSO ticket          |
| `GET /api/sso/saml/{connectionId}/start`     | Authn request and relay state               |
| `POST /api/sso/saml/{connectionId}/callback` | response validation, claims/JIT, SSO ticket |
| `GET /api/sso/saml/{connectionId}/metadata`  | tenant-specific SP metadata                 |
| `/sso/complete`                              | exchange one-use SSO ticket through Auth.js |

## Support endpoints

`GET /api/support-session/launch?ticket=...` is consumed on the tenant/dedicated host once, sets a host-only support cookie, and redirects to a query-free dashboard URL. `DELETE /api/support-session` ends the session, clears the cookie, and returns the admin-host URL.

## Other tenant-aware endpoints

- `/api/upload` and `/api/files/{name}`;
- `/api/assistant`;
- `/api/ably-token`;
- `/api/auth/[...nextauth]`.

## Anonymous authentication endpoints

| Method/path                | Purpose                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`          | Shared host only. Proves credentials, then mints a single-use, host-bound login intent and returns the eligible workspaces. Never establishes a session. Every failure returns one identical body. |
| `DELETE /api/login`        | Invalidates a pending login intent and clears its cookie; called on sign-out.                                                                                                                      |
| `POST /api/password-reset` | Emails a reset link. On the shared host it fans out across every workspace the address belongs to. Always returns `{"ok":true}`.                                                                   |

`POST /api/login` requires an exact same-origin `Origin`, a same-origin
`Sec-Fetch-Site` when present, and `application/json`. It answers `404` on tenant,
dedicated and admin hosts.

The tRPC transport also accepts four procedures with no session at all —
`invitations.get`, `invitations.accept`, `passwordReset.validate` and
`passwordReset.reset`. Each carries a token whose hash is globally unique, so the
token identifies the tenant with no host and no session. A request without a valid
token, or a batch containing any other procedure, is rejected with `401`.

Uploads/files validate actor and object-level access. Realtime returns 503 without `ABLY_API_KEY` and the client does not initialize when that integration is absent.

## Error handling

- `400`: invalid input/state;
- `401`: missing, invalid, expired, revoked, or replayed credential;
- `403`: lifecycle/module/scope/capability/origin denied;
- `404`: resource or host-bound platform surface not available;
- `409`: incomplete configuration/conflict;
- `423`: organization not accessible;
- `429`: rate limited;
- `500`: unexpected server/provider failure.

Do not include secrets, credentials, or raw provider responses in error bodies.
