# ADR-003: Standard Shared-Host Login

Status: Accepted and implemented, 2026-08-02.

## Context

Every tenant reached its workspace through a host that already identified it — a
slug on the base domain, a verified custom domain, or a dedicated deployment URL.
Host resolution therefore doubled as tenant resolution, and the login page never
had to ask which organization a person meant.

Standard customers now share one host: `www.devfathom.com` in production,
`staging.devfathom.com` on staging. The login URL carries no slug and no
`workspace=` parameter, so the organization has to be established some other way —
after credentials are proven, and inside the authenticated boundary.

## Decisions

### 1. No global identity table

Identity uniqueness stays tenant-local. `20260728102000_tenant_user_email`
deliberately made `email` unique per organization: "Identity uniqueness is
therefore tenant-local, matching host-scoped authentication."

Merging N per-organization rows into one global identity would force a choice
between losing data and downgrading security wherever two rows for the same
address hold different password hashes — and neither is required to let someone
sign in at a shared host. The `User` model's identity shape is unchanged.

The cost is that a person who belongs to two organizations has two accounts with
two passwords. That is the existing product model, and the login flow simply
honours it: the password is checked against each candidate independently, and a
password that matches only one organization admits only that one.

### 2. Standard tenants stay on the shared host

After selecting a workspace the user REMAINS on the shared host. There is no
redirect to a per-tenant subdomain and no cross-host session handoff.

Auth.js cookies are host-only — `@auth/core`'s defaults set no `domain` — and in
secure mode the CSRF cookie uses the `__Host-` prefix, which forbids a `Domain`
attribute entirely. A redirect to `acme.devfathom.com` would therefore arrive with
no session, and making one work would mean inventing a second cross-host handoff
alongside the SSO ticket and the support launch ticket. It is not needed: nothing
about the tenant boundary depends on the host once the session carries the
organization, and `withTenantDb` already runs without host context.

Existing per-tenant subdomains keep resolving through the slug ladder, so
bookmarks continue to work. They are simply not the canonical path for standard
tenants. Enterprise dedicated and custom hosts are unaffected, and enterprise SSO
stays on them because OIDC redirect URIs and SAML ACS/audience values are derived
from the request host and registered at the customer IdP.

### 3. Verify the password against every candidate

The alternative — ask which organization first, then check the password — would
tell anyone who knows an address which workspaces it belongs to, before proving
anything. That is exactly the account-enumeration control the threat model
records, so it was rejected.

Instead: one narrow privileged lookup returns the candidate rows for the address,
the password is compared against each, and eligibility is a password match AND an
allowed account status AND an accessible organization lifecycle. Zero candidates
still performs one bcrypt compare against the dummy hash, so response time does
not reveal existence, and "no such address", "wrong password" and "no eligible
organization" all return one identical body.

The picker itself is a new enumeration surface only for someone who already holds
a correct password — which is not enumeration, it is authentication.

### 4. The pending-login intent is control-plane state

The intent spans organizations: it exists precisely for the window between "this
password is correct" and "this is the workspace". There is no single
`organizationId` for a tenant RLS policy to compare against, so a tenant-scoped
table cannot express it. It lives in the control plane under
`platform_control_plane_only`, and the RLS verifier asserts a tenant scope can
neither read it nor write it.

The row holds no tenant business data — an email, a host, and the candidate set
the server itself computed. It is written and read only by the authentication
path, in the same explicitly privileged scope the discovery lookup uses.

It is a server-side row rather than a cookie or JWT value because a submitted
organization id must never be authority on its own. The browser holds an opaque
handle; the server holds the decision. The pattern is `df_sso_ticket`'s, copied
deliberately: 32 random bytes, only the SHA-256 hash stored, a five-minute TTL,
single use via a conditional update asserting exactly one affected row. Two
additions for the shared host — the minting host is recorded and re-checked, and
a submitted organization id is accepted only if it belongs to the stored
candidate set.

### 5. The duplicate-email message is safe _today_

Every user-creation path now reports a duplicate address explicitly:
"A user with this email already exists."

That is safe because there is no anonymous signup in this product — no `/signup`,
`/register` or `/sign-up` route exists. Every creation path is authenticated by
an actor who can already see the organization's member list, so the message tells
them nothing they could not read directly, and it is far more useful than a
database constraint violation surfacing as a raw Prisma error.

**If public self-serve registration is ever added, this message must change.** An
anonymous caller must get a neutral response ("if that address is new, check your
email"), because at that point the same message becomes an enumeration oracle.

## Consequences

- One shared host serves all standard tenants; `DEFAULT_ORGANIZATION_ID` must
  never resolve there, and the `shared` host classification short-circuits before
  the default-host fallback to guarantee it.
- `AUTH_URL` and `NEXT_PUBLIC_APP_URL` must point at the shared host so reset and
  invite links land there. Both feed `configuredDefaultHosts()`, which is why the
  short-circuit above is a correctness requirement and not a nicety.
- A person with accounts in several organizations sees a selection step; a person
  with one does not.
- Discovery is the only new cross-tenant read surface in the product and is
  reviewed as such: one transaction, one predicate, a hard field whitelist, and a
  cap of ten candidates.
- Emails are stored lower-cased, so tenant-local identity is effectively
  case-insensitive without a second index.
