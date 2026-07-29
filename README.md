<div align="center">

<img src="./public/favicon.svg" width="76" height="76" alt="DevFathom" />

# DevFathom Hub

**Depth in everything we build.**

The company operating hub for **DevFathom** and customer agencies. Projects,
finance, clients, people, real-time collaboration, and organization
administration in one calm workspace, backed by a separate seller control
plane.

</div>

---

## Overview

DevFathom Hub brings the tools the team uses every day into a single, fast,
consistent surface:

- **Dashboard** — a live pulse of what's happening across the workspace
- **Projects & Kanban** — boards, tasks, comments, and a Trello importer
- **Clients** — relationships, contacts, and engagement history
- **Finance** — invoices, transactions, and P&L reporting (admin)
- **Notes** — a rich Tiptap editor with mentions, tables, and links
- **Meetings** — scheduling with recurring occurrences
- **Chat** — real-time messaging over WebSockets
- **Team, HR & Insights** — people, leave, and analytics
- **REST API + API docs** — programmatic access for scripts and AI agents
- **Organization administration** — people, roles, modules, domains, identity,
  SCIM, email, and brand
- **Platform control desk** — CRM, contracts, manual onboarding, licenses,
  shared/dedicated deployments, jobs, operators, support, and audit

## Tech stack

| Area          | Choice                                              |
| ------------- | --------------------------------------------------- |
| Framework     | Next.js 16 (App Router) · React 19                  |
| Styling       | Tailwind CSS v4 · shadcn/ui on `@base-ui/react`     |
| Motion        | GSAP + `@gsap/react` · Motion (Framer Motion)       |
| Type-safe API | tRPC v11 · TanStack Query                           |
| Data          | Prisma 7 · PostgreSQL                               |
| Auth          | NextAuth v5                                         |
| Realtime      | Ably when configured; graceful no-realtime fallback |
| Runtime / PM  | [Bun](https://bun.sh)                               |

## Getting started

This project uses **Bun** as its package manager and runtime.

```bash
bun install          # install dependencies
bun run db:generate  # generate the Prisma client
bunx prisma migrate deploy
bun run db:seed      # (optional) seed demo data
bun run dev          # start Next.js
```

For local multi-host development, open
`http://devfathom.localhost:3000` for the tenant workspace and
`http://admin.localhost:3000/platform` for the seller control desk.

### Useful scripts

```bash
bun run dev        # Next.js development server
bun run build      # prisma generate && next build
bun run typecheck  # TypeScript
bun run lint       # ESLint
bun run test       # Vitest
bun run test:rls   # PostgreSQL isolation verification (test DB only)
bun run platform:jobs -- --max-jobs=25
bun run format     # prettier --write
bun run db:studio  # Prisma Studio
```

## Administration platform

The product uses one PostgreSQL database with forced organization RLS. Customer
agencies are activated manually; shared deployment is the default and
enterprise customers may use dedicated Vercel projects. Start with
**[the deployment runbook](./docs/DEPLOYMENT.md)** and
**[the administration handbook](./docs/admin-platform/README.md)**, then copy
**[`.env.example`](./.env.example)** for configuration names.

## Brand

DevFathom has a documented visual identity — palette, logo usage, typography,
and motion principles. See **[BRAND.md](./BRAND.md)**, or open the live
**`/brand`** page (publicly viewable).

Brand assets live in `public/` and are regenerated from a single master SVG:

```bash
bun run scripts/gen-brand-icons.ts   # rebuilds favicons, app icons & logo SVGs
```

## Project structure

```
src/
  app/                 # App Router routes
    (app)/             # authenticated workspace (dashboard, projects, …)
    brand/             # public brand showcase (/brand)
    login/             # animated sign-in
    platform/          # seller control desk
    api/               # tRPC, REST, platform, SCIM, SSO, support
  components/
    brand/             # logo / DevFathom mark
    layout/            # app shell, sidebar, topbar
    motion/            # Reveal, Stagger, CountUp, Magnetic, PageTransition
    ui/                # shadcn primitives
  lib/                 # auth, db, trpc, motion tokens
  server/              # tRPC routers
prisma/                # schema, seed, migrations
docs/admin-platform/   # architecture, API, status, runbooks, release evidence
```
