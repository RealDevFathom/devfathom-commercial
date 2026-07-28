# Authentication and Authorization

## Current

NextAuth v5 and Prisma adapter dependencies exist (`package.json`), with local authentication logic in `src/lib/auth.ts`. Password policy and TOTP helpers exist at `src/lib/password-policy.ts` and `src/lib/totp.ts`. API tokens are handled by `src/lib/api-auth.ts`. Review the code and live configuration before treating any provider or MFA flow as enabled.

## Planned enterprise contract

Support password/MFA where enabled, OIDC, SAML 2.0, JIT provisioning and SCIM 2.0. Identity connection configuration is organization-scoped, encrypted at rest, rotation-aware, and admin-audited. OIDC validates issuer/audience/signature/nonce/state/PKCE. SAML validates signed assertions, audience, recipient, clock skew and configured IdP metadata. JIT has deterministic email/domain matching, role mapping and deprovision rules. SCIM requires bearer-token rotation, idempotent PATCH/PUT, pagination, filtering and audit entries.

Authorization is deny-by-default, tenant-scoped, and evaluated server-side for UI, tRPC, REST, jobs and file access. API scopes must map to capabilities, not bypass them.
