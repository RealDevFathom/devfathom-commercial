# Hybrid Deployment and Operations

## Current

The repository targets Next.js/Vercel and includes `vercel.json`, `@vercel/blob`, `@vercel/edge-config`, and `@vercel/sdk` dependencies (`package.json`). `DEPLOY-NOTES.md` records prior deploy-gated considerations. Dependency presence does not prove linked production resources, environment variables, or active use.

## Planned operational model

Use Vercel Functions/Fluid Compute for web/API workloads unless a documented workload requires another runtime. Keep PostgreSQL as the durable system of record; use object storage for durable file payloads; use a queue/worker design for exports, SCIM, billing webhooks and purge jobs. Define regions, RPO/RTO, backups, restore drills, secret rotation, health checks, logging, metrics and alert ownership before production launch.

Document every required environment variable by name, purpose, environment, rotation owner and whether it is sensitive—never its value.
