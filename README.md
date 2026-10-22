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
- **Meetings** — scheduling with recurring occurrences and embedded video (8x8 JaaS)
- **Chat** — real-time messaging over managed realtime (Ably)
- **Team, HR & Insights** — people, leave, and analytics
- **REST API + API docs + AI operator** — programmatic and natural-language access for scripts and agents

## Documentation

The canonical, code-grounded documentation set lives in **[`docs/`](./docs/README.md)** — project status,
architecture, technical diligence, threat model, engineering/API references, product/business strategy,
operations, privacy, governance, and ownership. Start with the
**[current project status](./docs/executive/PROJECT-STATUS.md)** for anything beyond a quick orientation.

## Tech stack

| Area          | Choice                                          |
| ------------- | ----------------------------------------------- |
| Frontend      | Nuxt 4 · Vue 3 · TypeScript                     |
| Styling       | DevFathom design tokens · scoped Vue components |
| API           | FastAPI · Pydantic · automatic OpenAPI          |
| Data          | SQLAlchemy 2 async · PostgreSQL                  |
| Auth          | FastAPI JWT sessions · scoped API tokens        |
| Realtime      | Ably (managed, capability-scoped tokens)        |
| AI operator   | Google Gemini streaming/function calling        |
| Runtime / PM  | [Bun](https://bun.sh)                           |

## Getting started

The web app uses **Bun** and the API uses **Python 3.12+**.

```bash
bun install             # install Nuxt/Vue dependencies
bun run api:install     # install FastAPI/Python dependencies
cp .env.example .env    # fill local values; never commit .env
bun dev                 # start Nuxt :3000 and FastAPI :8000
```

Open [http://localhost:3000](http://localhost:3000). FastAPI documentation is at
[http://localhost:8000/docs](http://localhost:8000/docs). Realtime remains provided by Ably.
Environment variables (names, consumers, and failure behavior)
are catalogued in [`docs/reference/ENVIRONMENT-VARIABLES.md`](./docs/reference/ENVIRONMENT-VARIABLES.md).

### Useful scripts

```bash
bun dev              # Nuxt + FastAPI development servers
bun run build        # production Nuxt build + Python compile check
bun run typecheck    # Nuxt/Vue type checking
bun test             # route-policy unit tests
bun run api:test     # FastAPI tests
bun run lint         # Vue typecheck + Ruff
bun run verify       # formatting, lint, tests, and production build
```

### Deployment

`vercel.json` defines two Vercel Services in one deployment: Nuxt serves the web routes,
and FastAPI receives `/api/*`, `/docs`, `/openapi.json`, and `/health`. Preview deployments
automatically use their `VERCEL_URL` as the Nuxt API origin; a custom deployment can override
that with `NUXT_PUBLIC_API_BASE`.

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
app/                   # Nuxt 4 application
  pages/               # Vue file-based routes
  components/          # Vue product and layout components
  composables/         # API and authentication clients
  assets/css/          # design system and responsive styling
backend/
  app/                 # FastAPI service, auth, data, and routers
  tests/               # API smoke tests
prisma/                # legacy schema reference during DB migration
src/                   # read-only legacy Next/React implementation during parity work
```

> **Migration note:** `src/` and `prisma/` are inactive historical references. They are
> excluded from the dependency manifest, Nuxt build, FastAPI runtime, and deployment.
