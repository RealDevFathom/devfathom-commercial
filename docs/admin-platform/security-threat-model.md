# Security Threat Model

## Assets and trust boundaries

Assets: tenant data, credentials/tokens, identity metadata, files, commercial records, audit evidence and exports. Boundaries: browser↔app, app↔database, app↔object storage, app↔identity provider, app↔email/payment providers, and agency admin↔tenant context.

## Priority threats and controls

| Threat                   | Required control                                           | Evidence needed             |
| ------------------------ | ---------------------------------------------------------- | --------------------------- |
| Cross-tenant access      | host/token binding, RLS, scoped FKs, isolation tests       | adversarial test suite      |
| Privilege escalation     | deny-by-default capability checks, audited grants          | route/procedure tests       |
| Token theft/replay       | hashed tokens, expiry/rotation, redaction, rate limits     | security test/review        |
| SSO assertion abuse      | protocol validation and metadata controls                  | OIDC/SAML conformance tests |
| Webhook forgery          | signature, timestamp, idempotency                          | provider simulation tests   |
| Export/data exfiltration | time-limited encrypted artifacts, audit                    | access/expiry tests         |
| Destructive admin action | confirmation, dual control where required, immutable audit | runbook drill               |

Current helpers such as `src/lib/rate-limit.ts`, `src/lib/api-auth.ts` and `src/server/audit.ts` are useful anchors, but no platform threat-control claim is complete without verification.
