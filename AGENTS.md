<!-- BEGIN:source-only-cloud-setup -->
# Source-only Codex Cloud setup

This section applies to the private source snapshot repository
`WhatTheStack1/devfathom-source-cutover-20261014-e68ec823`.
Its preserved source baseline is `8959695be83bf1578617f27566dfa8f30989497c`
(tree `88bdfe40404b61de4dd9f3153a01722a5fcc9dc5`, 1,738 admitted files).
For Cloud environment setup, these instructions take precedence over the
Mac-specific CLI/profile/plugin bootstrap requirements below.

## First setup turn: inspection only

Before installing, generating, building, testing, or starting anything, read this
section and run only:

```sh
python3 .cutover/cloud-setup.py preflight
```

Report its receipt, including the exact Bun, Node and Python versions. Stop the
first setup turn before installation or application checks. Wait for a follow-up
that names the exact observed/selected Node version and explicitly invokes the
guarded install command. Do not infer permission for an automatic broad setup.

## Guarded installation

Use Bun 1.3.14 only. Once the initial receipt is reviewed, the sole dependency
installation entry point is:

```sh
python3 .cutover/cloud-setup.py install --node-version vX.Y.Z
```

Replace vX.Y.Z with the exact reviewed Node version. The script checks package and
lockfile identities and invokes `bun install --frozen-lockfile --ignore-scripts`.
The repository bunfig also requires frozen-lock installation and skips root and
dependency lifecycle scripts. Never override these settings, run `bun pm trust`,
use blanket lifecycle scripts, use another package manager, update the lockfile,
or fetch tools with `bunx`/`npx`. If the runtime is missing or differs, stop and
report it; propose an exact official installation command before running it.

Do not configure credentials, secrets, grants, network/security policies, external
services or databases. Do not run migrations, schema pushes, resets, seeds,
Prisma Studio, application/dev servers, workers, print bridges, jobs, containers
or background services. Keep the Start skill empty or explicitly a no-op.
Do not run the package postinstall, build, dev, start, db, E2E, smoke, broad test,
watch or coverage scripts. Accepted generated TypeScript is already present:
do not regenerate it during initial setup.

## Bounded checks and publication

Initial checks are limited to the guarded script's runtime, pinned-file,
dependency-version and Git identity checks. No application tests run implicitly.
After dependencies are installed, report the actual command receipts and
remaining blockers. Preserve the baseline and this separate configuration change;
do not edit product source or start parallel writers during environment setup.

The exact 11 admitted suites are listed in `.cutover/CHECK_COMMANDS.json`; their
retained Mac configs need a separate reviewed Linux adaptation before use. Keep
one worker, disabled caches, TypeScript noEmit and incremental:false. Known
excluded import edges and Next route declarations remain unresolved. Packaging
and source-profile checks need excluded initializer inputs and are not admitted
here. No held/private tests, fixture payloads or original repository history may
be recovered or fetched to repair these gaps.

Before any later application checks, retain the offline guard and require
environment-level network denial already available without changing permissions.
If that cannot be established, stop those checks. The guard alone does not
constrain native child processes. Never claim Linux tests passed without their
actual receipts. Publishing an environment is not product/build acceptance.
<!-- END:source-only-cloud-setup -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:devfathom-design-rules -->

# DevFathom Studio is the UI source of truth

Before planning, designing, reviewing, or implementing any user interface, read
`docs/design-system/DEVFATHOM-STUDIO.md` in full.

- Reuse the semantic tokens in `src/app/globals.css` and the shared components named in the
  design contract. Do not create a parallel palette, typography system, shell, or component
  vocabulary.
- Tenant and platform-control surfaces are one product family. New platform UI must inherit the
  same Studio shell, geometry, typography, interaction states, theme behavior, and responsive
  rules as the tenant workspace.
- Treat old files under `docs/superpowers/prototype-ref/` as historical implementation evidence,
  not current visual authority.
- Complete the visual QA matrix in the design contract before declaring UI work finished.

<!-- END:devfathom-design-rules -->

<!-- BEGIN:devfathom-cli-contract -->

# DevFathom Commercial CLI contract

- Use Codex Desktop GUI for planning, product decisions, and status only.
- Run implementation, Git mutations, migrations, QA, builds, and deployment through Codex CLI
  rooted at this repository with `codex -p devfathom-commercial -C <repo-path>`.
- Keep Ponytail Ultra and Caveman Ultra active in every CLI session.
- Keep Claude-Mem active. Retrieve only task-relevant observations; never inject broad history when
  the repository or current task already provides sufficient context.
- Keep Codebase Memory active. Prefer graph discovery before file scans; use `rg` for literals,
  configuration, and non-code files. Refresh the index after structural changes.
- Do not add Graphify by default. Codebase Memory already provides the required code graph; add a
  second graph tool only when a concrete uncovered need justifies its token and maintenance cost.

<!-- END:devfathom-cli-contract -->
