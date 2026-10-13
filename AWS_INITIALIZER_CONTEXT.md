# Final source composition status — 2026-10-13

The integrated source now has the reviewed final schema and 127 migrations.
All 125 historical SQL files and the lockfile retain their accepted pins; the
two additions are the source-tenant anchor and visibility-context anchors.
The source library has 159 exact pins and the generated client has 459 files.

The previous executable context proof below applies to the earlier 125-migration
bytes. The new 1,820-entry executable inventory is an unmaterialized recipe:
NOT_BUILT, dependency bytes not freshly revalidated, offline smoke NOT_RUN.
Dependencies were neither copied nor installed. No database, image, release or
runtime acceptance is claimed for the final composition. The exact context
auditor remains strict and must be run on a separately materialized context
before any later executable acceptance.

---

# Offline executable initializer context

The separately materialized initializer context contains the accepted v2 runner,
adapter, observer, fingerprint, baseline and preparation renderer; canonical
writer imports; migration-only config and all 125 historical SQL files; 459
unchanged generated Prisma files; and the exact selected dependency closure.
`executable-initializer-context-manifest.json` is external to that directory.
Verify its handoff SHA-256 before use with `scripts/aws-initializer-context.py`.
No private configuration, captured historical values, baseline approval or secrets
are included. The 153-file initializer source manifest remains a source library
check; it is not an executable-context certificate.

This package is an offline **Darwin arm64** execution proof using existing Node
22.23.1, tsx 4.23.1, pg 8.22.0 and Prisma client/adapter 7.9.1. Package metadata
versions match the unchanged bun.lock. The selected esbuild platform binary is
Darwin arm64; this is not a Linux image or Linux dependency receipt. Extraction
uses explicit roots and recursive package dependencies, including pg-cloudflare,
without installing dependencies or copying the complete dependency tree. The
Prisma migration CLI is not included: this context proves initializer import and
source binding, not execution of migration commands.

From the initializer context, the handoff smoke command is:

```sh
TSX_DISABLE_CACHE=1 TSX_TSCONFIG_PATH=prisma/tsconfig.fresh-database.json \
CONTEXT_TRACE=/approved/scratch/context-trace.json \
node --require ./scripts/aws-initializer-offline-guard.cjs --import tsx \
  scripts/aws-initializer-smoke.mjs
```

Use a clean process environment. The smoke validates exact initializer source
bindings, rejects a deliberately corrupted source hash and rejects a missing
independent approval before reading configuration. The guard denies sockets,
listeners, DNS, TLS and fetch, and refuses module loads outside the context.
The installed tsx attempts local parent IPC; those attempts are denied and
recorded. They do not open a socket and are not DB execution. Other socket
attempts fail the smoke. The runner has no help command: `--help` returns
`CONFIG_REJECTED` with exit 2; this is the accepted runner behavior.

The guard and observed traces are focused offline evidence, not a general
security sandbox or complete dynamic path coverage. Generated client, dependency
files, package/lock bytes and all source files are independently hash-pinned.
A fresh INITIAL artifact and independently delivered approval pin must bind the
actual source, exact historical timestamps/catalog, target and intended effect.
COMPLETED_REPLAY needs its own separately reviewed artifact and pin.

Web context remains separate. Dockerfile.aws and its literal allowlist preserve
the existing demo default and still reject unselected composition. No host
generated client/dependencies are added to that web context. Its known 17 demo
imports remain pending the existing product decision; none were removed here.

The production-source-manifest.json remains the frozen historical provenance
anchor used by the source audit. The handoff's final-source-manifest.json and
release-content-manifest.json identify this composed candidate, including its
accepted camera source/test changes and refreshed packaging pins. Do not treat
the historical provenance manifest as the current release manifest.

Remaining gates: separate visibility handoff/review/composition, genuine
historical/catalog capture and approval, real PostgreSQL privileges/catalog
visibility/queue/ACK/cancellation/concurrency/TLS, Linux image/runtime admission,
demo product decision and existing Board/cloud/deployment approvals. Nothing in
this package clears those gates.
