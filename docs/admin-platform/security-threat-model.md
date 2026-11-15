# Security Threat Model

## Assets

- tenant work, people, finance, files, communications, and audit data;
- seller CRM, contracts, invoices, payments, renewals, and pipeline;
- passwords, sessions, API/SCIM tokens, MFA and recovery material;
- IdP metadata/secrets/certificates;
- provider credentials and deployment IDs;
- exports and purge evidence;
- platform audit and lifecycle history.

## Trust boundaries

1. browser ↔ tenant/custom/dedicated host;
2. browser ↔ admin host;
3. Next.js ↔ PostgreSQL pool;
4. worker ↔ AWS/DNS/Blob/IdP;
5. directory ↔ SCIM;
6. platform operator ↔ audited tenant support identity;
7. tenant API client ↔ REST scope boundary.

## Threats and implemented controls

| Threat                              | Controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant read/write             | host/session/token match (session claim plus explicit lifecycle gate on the shared host); tenant-scoped clients; transaction-local settings; forced RLS; organization-scoped unique/composite FKs; adversarial RLS test                                                                                                                                                                                                                                                      |
| Cross-tenant discovery surface      | two lookups run outside tenant scope by necessity — shared-host login discovery (only predicate: normalized email; hard field whitelist; cap 10) and anonymous invite/reset token resolution (only predicate: globally unique token hash; returns an organization id). Neither takes an attacker-controlled predicate, and everything after either runs in `withTenantDb`                                                                                                    |
| Platform access through tenant host | proxy denies platform pages and interactive APIs outside admin host; server capability/session revalidation                                                                                                                                                                                                                                                                                                                                                                  |
| Privilege escalation                | separate platform and tenant identities; least-privilege role matrices; deny-by-default ABAC; DENY wins; module checks                                                                                                                                                                                                                                                                                                                                                       |
| Session theft/replay                | HttpOnly/Secure cookies; opaque platform/support sessions; hashed tokens; expiry/revocation; one-use SSO/support/login-intent state; revocation as its own session claim, evaluated by one fail-closed decision point shared by the API and the page guard                                                                                                                                                                                                                   |
| Password/account enumeration        | dummy bcrypt; uniform invalid response; rate limiting; status-specific errors only after password proof                                                                                                                                                                                                                                                                                                                                                                      |
| Workspace enumeration (shared host) | the picker is only reachable AFTER the password is proven, so it is authentication rather than enumeration. The password is verified against every candidate before any organization is named; zero candidates still performs one bcrypt compare against the dummy hash; "no such address", "wrong password" and "no eligible organization" return one identical body with no cookie; the candidate set is capped at 10 and a larger set is audited and treated as a failure |
| Forged workspace selection          | a submitted organization id is validated against a server-side, single-use, host-bound intent recording the server-computed candidate set; a forged id is refused and does not consume the intent; the account status, organization lifecycle and SSO enforcement are all re-checked at selection, not trusted from the intent                                                                                                                                               |
| CSRF                                | SameSite cookies plus exact public-origin, fetch-site, and JSON checks on cookie-authenticated mutations                                                                                                                                                                                                                                                                                                                                                                     |
| Proxy/internal-origin confusion     | validated public-origin reconstruction for redirects/callbacks/metadata/locations                                                                                                                                                                                                                                                                                                                                                                                            |
| SSO replay/substitution             | OIDC PKCE/nonce/state; SAML request cache/relay state; one-use state/tickets; tenant connection/host binding — enterprise SSO runs only on tenant/dedicated hosts, and the shared host links out to the customer host rather than starting a flow; signed assertion/audience checks                                                                                                                                                                                          |
| SCIM/API token abuse                | random prefixed tokens, hash storage, expiry/revoke/last-used, rate limit, tenant and module binding, scopes, audit                                                                                                                                                                                                                                                                                                                                                          |
| Support impersonation abuse         | platform capability, reason, time limit, encrypted one-use cross-domain launch, banner, action identity, audit, suspension revocation                                                                                                                                                                                                                                                                                                                                        |
| Secret disclosure                   | AES-256-GCM at rest; prefix/configured-only UI; no secret in audit/result; environment-managed master key                                                                                                                                                                                                                                                                                                                                                                    |
| Job duplication/races               | SKIP LOCKED claim, idempotency keys/provider IDs, attempt limit/backoff, stale lease recovery, state recheck                                                                                                                                                                                                                                                                                                                                                                 |
| Unsafe purge                        | lifecycle/time guards, FK-aware order, organization predicate, control-evidence exclusion, job result counts                                                                                                                                                                                                                                                                                                                                                                 |
| Unverified domain takeover          | random TXT proof, public DNS resolution, verified-only host mapping, provider attachment after proof                                                                                                                                                                                                                                                                                                                                                                         |
| File/object exposure                | tenant actor and object-level checks; private Blob export requirement                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-only enforcement bypass          | server module/capability checks on tRPC/REST/SCIM/jobs/files; direct disabled route boundary                                                                                                                                                                                                                                                                                                                                                                                 |

## Known operational risks

- `PLATFORM_ENCRYPTION_KEY` rotation requires re-encryption; losing it loses encrypted configuration.
- Real OIDC/SAML interoperability must be tested per provider.
- Dedicated provisioning needs a least-privilege AWS IAM role, isolated resources, and a controlled image source; this path is not yet verified.
- The in-memory rate limiter is per process unless Upstash configuration is used; production distributed limits should use shared storage. **This now gates a cross-tenant surface.** Shared-host login discovery, intent minting, and workspace selection are each limited separately, but on a multi-replica deployment every replica keeps its own counters, so the effective limit is the configured value multiplied by the replica count. Configure Upstash before the shared host carries production traffic.
- `login:acct` is keyed on the email address and is therefore global across organizations, which is deliberate — discovery is global too. It does mean a user in one organization can rate-limit a same-address user in another. That was already true before the shared host; it is simply reachable more often now.
- `DEFAULT_ORGANIZATION_ID` is dangerous on a shared host. It exists for local development, and the `shared` host classification short-circuits before the default-host fallback so it can never be reached there. Never add a shared host to `configuredDefaultHosts()` expecting it to be ignored.
- Database purge does not automatically prove deletion in every external provider. The runbook requires reconciliation.
- Audit is append-oriented through product APIs, but database administrators remain a privileged trust role.
- Customer brand URLs are external presentation inputs; constrain updates and asset hosting operationally.

## Security release requirements

- no raw `@/lib/db` import outside scoped DB boundary;
- migration and RLS verifier pass against fresh PostgreSQL;
- platform paths/API host isolation tests pass;
- origin, ABAC, token, TOTP, module mapping, and proxy tests pass;
- secret scan and dependency audit reviewed;
- staging browser negative tests include cross-tenant host, disabled module, revoked SCIM, expired support, and suspended organization;
- shared-host negative tests include a wrong password, an unknown address, a forged organization id, a replayed intent, an expired intent, an intent presented on another host, and a revoked session against a read and a write on every procedure type;
- a distributed rate limiter is configured before the shared host serves production traffic;
- production operator enrolls MFA before customer onboarding.

## Incident priority

Treat suspected cross-tenant access, platform credential compromise, support misuse, purge outside policy, or export disclosure as a high-severity security incident. Follow [Runbooks](runbooks.md) and preserve evidence before remediation.
