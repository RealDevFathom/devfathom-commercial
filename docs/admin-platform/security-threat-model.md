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
4. worker ↔ Azure/DNS/Blob/IdP;
5. directory ↔ SCIM;
6. platform operator ↔ audited tenant support identity;
7. tenant API client ↔ REST scope boundary.

## Threats and implemented controls

| Threat                              | Controls                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant read/write             | host/session/token match; tenant-scoped clients; transaction-local settings; forced RLS; organization-scoped unique/composite FKs; adversarial RLS test |
| Platform access through tenant host | proxy denies platform pages and interactive APIs outside admin host; server capability/session revalidation                                             |
| Privilege escalation                | separate platform and tenant identities; least-privilege role matrices; deny-by-default ABAC; DENY wins; module checks                                  |
| Session theft/replay                | HttpOnly/Secure cookies; opaque platform/support sessions; hashed tokens; expiry/revocation; one-use SSO/support state                                  |
| Password/account enumeration        | dummy bcrypt; uniform invalid response; rate limiting; status-specific errors only after password proof                                                 |
| CSRF                                | SameSite cookies plus exact public-origin, fetch-site, and JSON checks on cookie-authenticated mutations                                                |
| Proxy/internal-origin confusion     | validated public-origin reconstruction for redirects/callbacks/metadata/locations                                                                       |
| SSO replay/substitution             | OIDC PKCE/nonce/state; SAML request cache/relay state; one-use state/tickets; tenant connection/host binding; signed assertion/audience checks          |
| SCIM/API token abuse                | random prefixed tokens, hash storage, expiry/revoke/last-used, rate limit, tenant and module binding, scopes, audit                                     |
| Support impersonation abuse         | platform capability, reason, time limit, encrypted one-use cross-domain launch, banner, action identity, audit, suspension revocation                   |
| Secret disclosure                   | AES-256-GCM at rest; prefix/configured-only UI; no secret in audit/result; environment-managed master key                                               |
| Job duplication/races               | SKIP LOCKED claim, idempotency keys/provider IDs, attempt limit/backoff, stale lease recovery, state recheck                                            |
| Unsafe purge                        | lifecycle/time guards, FK-aware order, organization predicate, control-evidence exclusion, job result counts                                            |
| Unverified domain takeover          | random TXT proof, public DNS resolution, verified-only host mapping, provider attachment after proof                                                    |
| File/object exposure                | tenant actor and object-level checks; private Blob export requirement                                                                                   |
| UI-only enforcement bypass          | server module/capability checks on tRPC/REST/SCIM/jobs/files; direct disabled route boundary                                                            |

## Known operational risks

- `PLATFORM_ENCRYPTION_KEY` rotation requires re-encryption; losing it loses encrypted configuration.
- Real OIDC/SAML interoperability must be tested per provider.
- Dedicated provisioning needs a least-privilege Azure identity, isolated resources, and a controlled image source; this path is not yet verified.
- The in-memory rate limiter is per process unless Upstash configuration is used; production distributed limits should use shared storage.
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
- production operator enrolls MFA before customer onboarding.

## Incident priority

Treat suspected cross-tenant access, platform credential compromise, support misuse, purge outside policy, or export disclosure as a high-severity security incident. Follow [Runbooks](runbooks.md) and preserve evidence before remediation.
