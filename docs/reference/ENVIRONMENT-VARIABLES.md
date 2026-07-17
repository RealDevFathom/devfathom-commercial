# Environment variable catalogue

**Snapshot:** 2026-07-12  
**Rule:** this file lists variable **names, consumers, and behavior only**. It never contains values. Values live in Vercel and in the issuing consoles.

Legend — **Scope:** server-only unless marked `NEXT_PUBLIC_` (client-exposed, inlined at build). **Required:** does the app fail without it, or degrade? **Missing behavior** is Verified from the consuming code.

## Application runtime — required for core function

| Variable       | Consumer(s)                                                    | Purpose                                          | Missing behavior                                                                        | Required       |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------- |
| `DATABASE_URL` | `backend/app/database.py`                                      | PostgreSQL connection (SQLAlchemy async)         | health is degraded and data routes cannot query                                         | **Yes**        |
| `AUTH_SECRET`  | `backend/app/security.py`, signed file/tool capabilities        | Session and short-lived capability signing       | production startup rejects weak/default values                                           | **Yes (prod)** |

## Application runtime — feature integrations (degrade gracefully)

| Variable                       | Consumer(s)                                                                  | Purpose                                                                                          | Missing behavior                                                                                                    | Scope      |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| `ABLY_API_KEY`                 | `backend/app/routers/integrations.py`, `collaboration_common.py`             | 30-min capability-scoped client tokens and server publishing                                     | token route returns **503**; Nuxt falls back to 5-second polling; writes remain authoritative                      | server     |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `backend/app/routers/integrations.py`                                        | Gemini streaming and server-enforced function tools                                              | assistant returns **503**; the rest of the app remains available                                                      | server     |
| `GEMINI_MODEL`                 | `backend/app/config.py`                                                      | Gemini model id                                                                                  | fallback to `gemini-2.5-flash`                                                                                        | server     |
| `BLOB_READ_WRITE_TOKEN`        | `backend/app/routers/integrations.py`                                        | Vercel private Blob storage in production                                                        | local/dev uses `PRIVATE_UPLOAD_DIR`; production must configure Blob for durable files                                | server     |
| `PRIVATE_UPLOAD_DIR`           | `backend/app/routers/integrations.py`                                        | local private upload storage                                                                     | fallback `private-uploads`; files are never served statically and require auth plus a signed URL                     | server     |
| `BREVO_API_KEY`                | `backend/app/routers/auth_management.py`                                     | Transactional password-reset email                                                               | reset requests remain enumeration-safe; delivery is skipped                                                         | server     |
| `BREVO_SENDER_EMAIL`           | `backend/app/routers/auth_management.py`                                     | Password-reset From address                                                                      | delivery is skipped                                                                                                  | server     |
| `BREVO_SENDER_NAME`            | `backend/app/routers/auth_management.py`                                     | Sender display name                                                                              | fallback `'DevFathom'`                                                                                               | server     |
| `NEXT_PUBLIC_JAAS_APP_ID`      | `backend/app/routers/meetings.py`                                            | 8x8 JaaS tenant id; historical name retained for compatibility                                  | call-token route returns **503**                                                                                     | server     |
| `JAAS_KID`                     | `backend/app/routers/meetings.py`                                            | JaaS JWT key id                                                                                  | call-token route returns **503**                                                                                     | server     |
| `JAAS_PRIVATE_KEY`             | `backend/app/routers/meetings.py`                                            | RSA key signing 2-h room JWTs (`\n`-escaped PEM supported)                                       | call-token route returns **503**                                                                                     | server     |
| `APP_URL`                      | `backend/app/config.py`, `backend/app/routers/auth_management.py`            | Public base URL for capability and password-reset links                                           | fallback `http://localhost:3000`                                                                                     | server     |
| `CORS_ORIGINS`                 | `backend/app/config.py`, `backend/app/main.py`                               | Comma-separated browser origins                                                                  | local Nuxt origins only                                                                                              | server     |
| `ENVIRONMENT` / `VERCEL_ENV`  | `backend/app/config.py`                                                      | Production secret-safety mode                                                                    | fallback development; Vercel supplies `VERCEL_ENV`                                                                  | server     |
| `ACCESS_TOKEN_MINUTES`         | `backend/app/config.py`, `backend/app/security.py`                           | JWT session lifetime                                                                             | fallback 7 days                                                                                                      | server     |

## Connected-mailbox OAuth (optional)

Each provider is independently gated by its credentials and `EMAIL_TOKEN_ENC_KEY`; an unconfigured provider's button is disabled. FastAPI binds encrypted OAuth state to the signed-in user and a ten-minute expiry, uses PKCE, and reads mailbox identity from Gmail Profile or Microsoft Graph `/me` rather than trusting an unverified ID token. Refresh tokens are AES-256-GCM encrypted at rest. Inbox refresh is live-provider backed and updates `lastSyncedAt`; this implementation does not maintain a local message-body cache.

| Variable                                                                              | Consumer                  | Purpose                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_TOKEN_ENC_KEY`                                                                 | `backend/app/routers/email_integration.py` | AES-256-GCM key encrypting mailbox refresh tokens. **Rotating it orphans every stored token.** |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | `backend/app/routers/email_integration.py` | Gmail mailbox-connect OAuth app with PKCE                                       |
| `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` / `MS_OAUTH_REDIRECT_URI`             | `backend/app/routers/email_integration.py` | Microsoft mailbox-connect OAuth app with PKCE                                   |
| `MS_OAUTH_TENANT`                                                                     | `backend/app/routers/email_integration.py` | Entra tenant; fallback `'common'`                                                |

## Historical scripts

The retained `prisma/*.ts` files are inactive migration references. Their former bootstrap variables (`ADMIN_*` and `SEED_PASSWORD`) are not part of the active dependency manifest, runtime, or `.env.example`.

## Legacy variables — mark and remove

**Verified dead.** No reachable app code reads these.

| Variable                 | Status             | Evidence                                                                                                                                                  |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SOCKET_URL` | Legacy (Socket.IO) | Zero code references; realtime is Ably (D-004). Named only in a warning comment in `.env.example`; still present in legacy Vercel envs.                   |
| `FRONTEND_URL`           | Legacy (Socket.IO) | Zero code references.                                                                                                                                     |
| `SOCKET_PORT`            | Legacy (Socket.IO) | Zero code references; no socket server exists.                                                                                                            |
| `GROQ_API_KEY`           | Legacy (Groq)      | Read only implicitly by `@ai-sdk/groq` inside `scripts/assistant-{eval,diag}.ts`; the app assistant route uses Gemini (D-007). `grep groq src/` = 0 hits. |
| `GROQ_MODEL`             | Legacy (Groq)      | Same — eval/diag scripts only.                                                                                                                            |

## Deployment coverage

The Vercel Services build is verified locally, but secret values and provider credentials were not mutated or assumed during this migration. Before promotion, validate the variable names above independently for Production and Preview, then perform provider-specific smoke tests. Local development uses `.env`; committed templates contain names and placeholders only.

## `.env.example` accuracy

**Verified current state:** `.gitignore` ignores `.env*` but explicitly allows `!.env.example`. The sanitized template contains placeholder entries for every active application/runtime variable listed above, including the Google AI key. Legacy Socket.IO/Groq and inactive Prisma-script names are comments only, so they remain visible as removal guidance without becoming active configuration.

The template intentionally excludes values and uses `REPLACE_*` placeholders. It is safe to track only after the secret scan remains clean. Copy it to `.env` for local use; real `.env` files remain ignored.

**Maintenance rule:** every new environment variable must update the consuming code, this catalogue, `.env.example`, deployment-name validation, missing-behavior documentation, owner, and rotation notes in the same change.

## Rotation ownership (placeholders until assigned)

| Variable class                  | Rotation owner          | Cadence                              | Rotation notes                           |
| ------------------------------- | ----------------------- | ------------------------------------ | ---------------------------------------- |
| `AUTH_SECRET`                   | **TBD — Security**      | On suspicion; else annual            | Signs out all users; do deliberately     |
| `DATABASE_URL`                  | **TBD — Data/Platform** | On suspicion; else annual            | Rotate DB password at provider           |
| `ABLY_API_KEY`                  | **TBD — Platform**      | Annual                               | Old client tokens expire ≤ 30 min        |
| `GOOGLE_GENERATIVE_AI_API_KEY`  | **TBD — AI**            | Annual; immediately on cost incident | Also the emergency assistant kill switch |
| `BREVO_API_KEY`                 | **TBD — Platform**      | Annual                               | —                                        |
| `JAAS_PRIVATE_KEY` / `JAAS_KID` | **TBD — Platform**      | Annual                               | New key pair in 8x8 console              |
| `EMAIL_TOKEN_ENC_KEY`           | **TBD — Security**      | Only with mailbox migration          | Rotation orphans stored tokens           |
| Mailbox OAuth secrets           | **TBD — Security**      | Per provider policy                  | Disable the provider during rotation     |

Procedure: [runbooks §5](../operations/RUNBOOKS.md#5-secrets-rotation).

## Related documents

- [Deployment and environments](../operations/DEPLOYMENT-ENVIRONMENTS.md) · [Integrations and flows](../architecture/INTEGRATIONS-AND-FLOWS.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · [Runbooks](../operations/RUNBOOKS.md)
