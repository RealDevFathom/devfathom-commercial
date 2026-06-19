<div align="center">

<img src="./public/favicon.svg" width="76" height="76" alt="DevFathom" />

# DevFathom Hub

**Depth in everything we build.**

The internal company hub for **DevFathom** — a premium software services and
consultancy firm. Projects, finance, clients, people, and real-time
collaboration, in one calm, unified workspace.

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

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) · React 19 |
| Styling | Tailwind CSS v4 · shadcn/ui on `@base-ui/react` |
| Motion | GSAP + `@gsap/react` · Motion (Framer Motion) |
| Type-safe API | tRPC v11 · TanStack Query |
| Data | Prisma 7 · PostgreSQL |
| Auth | NextAuth v5 |
| Realtime | Socket.IO |
| Runtime / PM | [Bun](https://bun.sh) |

## Getting started

This project uses **Bun** as its package manager and runtime.

```bash
bun install          # install dependencies
bun run db:generate  # generate the Prisma client
bun run db:push      # sync the schema to your database
bun run db:seed      # (optional) seed demo data
bun dev              # start web + socket server together
```

Open [http://localhost:3000](http://localhost:3000). In production this runs at
**dev-fathom-hub.vercel.app**.

### Useful scripts

```bash
bun dev            # web (next dev) + socket server, concurrently
bun run build      # prisma generate && next build
bun run lint       # eslint
bun run format     # prettier --write
bun run db:studio  # Prisma Studio
```

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
    api/               # tRPC + REST (/api/v1)
  components/
    brand/             # logo / DevFathom mark
    layout/            # app shell, sidebar, topbar
    motion/            # Reveal, Stagger, CountUp, Magnetic, PageTransition
    ui/                # shadcn primitives
  lib/                 # auth, db, trpc, motion tokens
  server/              # tRPC routers
socket-server/         # Socket.IO server
```
