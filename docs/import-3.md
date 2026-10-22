# Pharmacy import 3/5 — mapping and operator workflow

## Design

This increment extends the existing `PharmacyMigrationSource` → `Batch` → `Row` →
`Exception` pipeline. It does not create a second importer. The pharmacy inventory data area now
hosts an accessible upload, column-mapping, preview, background-commit and confirmed rollback
workflow. Mapping rows show source samples, required-field state and the stable normalized target
key. Existing Studio `PageHeader`, `SectionCard`, `Button`, `StatusPill`, `Progress`, semantic
surface/state tokens and responsive table overflow are reused.

`header-synonyms.ts` is the single deterministic auto-mapping dictionary. It normalizes Unicode,
case, punctuation and whitespace, but deliberately does not use fuzzy matching. The 17 target
fields cover medicine identity, units/prices, stock/batch data, tax/location and party columns,
including documented vendor headings and common English, abbreviation and Roman-Urdu headings.
The first duplicate target wins so automation never silently overwrites a mapping.

## Persistence and security decisions

- `ImportMappingPreset` is tenant-owned, has the same database-generated organization default and
  forced-RLS contract as neighboring migration tables, and stores only the source-to-target JSON.
  Sample/customer data is not copied into presets.
- Preset names are unique per tenant. Every query and mutation also carries an explicit
  `organizationId` predicate as defense in depth. Creator/updater IDs provide durable attribution;
  tRPC's audited capability procedure records reads, preset changes and commit requests.
- All import endpoints use central `capabilityProcedure('pharmacy:data-import')`. The existing role
  catalogue and migration grant the exact capability only to pharmacy Owner and Manager templates;
  central `can()` retains explicit-DENY precedence.
- Monetary targets represent PKR input and are converted by the existing profiler/commit path to
  integer paisa (`BigInt` minor units). The UI never performs floating-point persistence.
- Commit is queued by the `PREVIEW` → `COMMITTING` transition after a fresh blocking-error count.
  Workers use the existing entity commit service and immutable manifest. Rollback confirmation is
  explicit; rollback implementation must reverse only manifest entries, never infer deletions.

## Follow-ups

1. Connect browser file selection to a streaming upload action that calls the existing guarded
   parser/profiler and returns headers plus three redacted samples.
2. Connect client controls to the new preset/preview router methods and poll batch progress.
3. Have the deployment's import worker claim `COMMITTING` batches and call `commitImportBatch`;
   expose per-entity processed counts from its durable job record.
4. Wire confirmed rollback to `rollbackImportBatch` and surface referential blockers. The current
   UI confirmation must not be treated as evidence that reversal completed.
5. Collect consented, anonymized Marg, Busy and local-vendor exports before adding hard-coded
   vendor presets. Add expiry parsing for every researched shape in import 4/5.

## Inspection-only QA

Focused Vitest coverage was added for every target field, normalization, mapping state, preset
save intent, preview counts and rollback confirmation. The Codex environment instruction for this
increment prohibits installs/test execution; the suites were therefore written and reviewed by
inspection. Visual QA remains required at 375, 768, 1024 and 1440 px, in both themes, with keyboard
and reduced-motion passes after the upload action is connected.
