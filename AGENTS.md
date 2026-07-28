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
