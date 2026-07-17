# Nuxt + FastAPI migration

## Runtime architecture

- Nuxt 4 owns SSR, Vue routes, layouts, browser state, and the DevFathom UI.
- FastAPI owns login, JWT verification, API-token scopes, OpenAPI, and business data access.
- SQLAlchemy's async PostgreSQL driver reads the existing Prisma-created tables, so deployment does not require a destructive database conversion.
- The Nuxt client reads the API origin from `NUXT_PUBLIC_API_BASE`; FastAPI explicitly allows the configured `CORS_ORIGINS`.
- Vercel Services build Nuxt and FastAPI independently inside one deployment, routing API and OpenAPI paths to Python and all other paths to Nuxt.

## Compatibility boundary

The legacy `src/` tree and `prisma/schema.prisma` are retained only as read-only historical references. They are excluded from Nuxt's TypeScript project, dependency manifest, runtime, and production output. All active product routes use Vue/Nuxt and all active business APIs use FastAPI.

The migrated surface includes authentication and 2FA, dashboard, projects and Kanban, CRM, notes, realtime chat, meetings, finance, team and HR, reviews, audit and administration, uploads, email, and the approval-gated AI operator. The old Next.js, React, tRPC, NextAuth, and Prisma packages are no longer runtime dependencies.

## Local development

1. Install web dependencies with `bun install`.
2. Install API dependencies with `bun run api:install` (prefer a virtual environment).
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, `AUTH_SECRET`, `NUXT_PUBLIC_API_BASE`, and `CORS_ORIGINS`.
4. Run `bun dev` for Nuxt on port 3000 and FastAPI on port 8000.
5. Use `/docs` on the FastAPI origin for interactive OpenAPI documentation.

## Deployment gates

1. Back up the target PostgreSQL database and apply `backend/migrations/20260712_phase3_email.sql` once per environment.
2. Configure production secrets and provider credentials listed in `docs/reference/ENVIRONMENT-VARIABLES.md`.
3. Run `bun run verify` before promotion.
4. Validate OAuth redirect URLs and Ably/Blob provider access in a preview deployment.

Deleting the inactive `src/` and `prisma/` reference trees is optional repository cleanup and is deliberately separate from runtime migration so historical work is not destroyed.
