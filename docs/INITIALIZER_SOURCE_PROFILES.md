# Initializer source profiles

The application source and the fixed 127-migration initializer have separate identities.
An application schema change does not revise either approved initializer profile.
`source-profiles.json` names the original `initializer-final127` and the
`initializer-final127-catalog` revision. Their schema, 127 SQL files and 459 generated
files are identical; the catalog revision changes one of the 159 source pins.
Each full executable manifest contains 1,820 files. The historical 604-entry selected
source cohort is not the full executable context.

The registry is hash-pinned by `scripts/aws-context.py` and loaded from the tooling
repository. No registry in the selected source root, arbitrary command-line digest,
unknown profile, or application profile can admit an initializer. New profiles need
an explicit reviewed tooling change. No application132 profile is admitted here.

## Source check

Supply an existing preserved source root containing the exact source files,
generated files, and these controls: `production-source-manifest.json`,
`initializer-source-pins.json`, `initializer-context-manifest.json`,
`generated-client-manifest.json`, and the pinned `prisma/fresh-database-manifest.json`.
Keep the preserved capture tooling separately alongside the source directory.

```sh
python3 -B scripts/aws-context.py --context initializer \
  --root "$INITIALIZER_SOURCE_ROOT" \
  --initializer-profile initializer-final127-catalog
```

Relative manifest paths resolve within the selected root. Missing roots, outside
manifest paths, private-category controls and symlinked controls fail before content reads. The import scanner uses the tooling
repository's existing TypeScript parser without executing application modules.
Successful profile output proves the 159 source and 459 generated file pins and
literal source closure. It does not prove executable dependency closure.
Without an explicit profile the historical source-only check remains available;
it does not claim generated-client verification. The default root is the current
directory. There is no fallback to an initializer snapshot when that root fails.

## Separate full-context check

Keep the exact 1,820-entry manifest outside the executable context. Use the approved
`executableManifestSha256` from the chosen trusted profile:

```sh
python3 -B scripts/aws-initializer-context.py --root "$INITIALIZER_EXECUTABLE_ROOT" \
  --manifest "$INITIALIZER_EXECUTABLE_MANIFEST" --sha256 "$APPROVED_MANIFEST_SHA256"
```

This unchanged integrity checker verifies every byte/size/mode, exact membership,
required files, 127 migrations and 459 generated files. The fixed initializer must
not import the evolving sibling application schema, generated client or bootstrap.
The offline guard derives its module boundary from the process working directory;
any separately admitted run must use the verified executable root as that directory.
Integrity success is not permission to run the initializer or connect to a database.

## Source regression checks

`tests/aws-context_test.py` accepts `INITIALIZER_SOURCE_ROOT` for its fixed initializer
assertions while its web checks continue to use the application repository.
`tests/aws-source-profiles_test.py` runs generic boundary cases without snapshots;
its additional real-pin cases require both `INITIALIZER_SOURCE_ROOT` and
`LEGACY_INITIALIZER_SOURCE_ROOT` and otherwise report a skip explicitly. These are
source/integrity tests only; they do not run bootstrap, migrations or providers.

For the fixed-127 **source-only** regression checks in a composed checkout, run:

```sh
python3 -B scripts/test-initializer-snapshot.py
```

This runner reads revision `96969faa8e0451bb4058cf6f77d7d0405eaeb388` from the local
Git object database, verifies all 159 records against the existing hash-pinned
source manifest, and materializes them in a temporary directory. It supplies that
root to the unchanged 25 `aws-context_test.py` checks, which validate the original
control hashes, exact source bytes/modes, 127 migrations, literal import closure
and rejection cases. Full Git history must be available (CI uses fetch-depth 0).
Missing history or any mismatched record fails; nothing is fetched or regenerated.
The runner deletes its temporary directory after the checks. It does not execute
captured code, generate a client, touch a database, or admit the evolving application
as an initializer. The explicit-root auditors retain their fail-closed behavior.
