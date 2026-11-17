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

This section applies only on the owner's workstation. A cloud task (Codex cloud or any other
hosted agent with no access to that workstation) skips every bullet below: it implements the
change, runs the repository checks itself, and opens a pull request against `develop` without
merging it. Ponytail, Caveman, Claude-Mem and Codebase Memory are not available there and are not
required.

- Use Codex Desktop GUI for planning, product decisions, and status only.
- Run implementation, Git mutations, migrations, QA, builds, and deployment through Codex CLI
  rooted at this repository with `codex -p devfathom-commercial -C <repo-path>`,
  or directly through the assigned Codex Cloud runtime rooted at this repository.
- Keep Ponytail Ultra and Caveman Ultra active in every CLI session.
- Keep Claude-Mem active unless unavailable in the assigned Codex Cloud runtime; disclose any
  such unavailability rather than claiming activation. Retrieve only task-relevant observations; never inject broad history when
  the repository or current task already provides sufficient context.
- Keep Codebase Memory active unless unavailable in the assigned Codex Cloud runtime; disclose any
  such unavailability rather than claiming activation. Prefer graph discovery before file scans; use `rg` for literals,
  configuration, and non-code files. Refresh the index after structural changes.
- Do not add Graphify by default. Codebase Memory already provides the required code graph; add a
  second graph tool only when a concrete uncovered need justifies its token and maintenance cost.

<!-- END:devfathom-cli-contract -->
