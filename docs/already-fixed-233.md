# GitHub issue #233 is already fixed

Issue #233 reports that medicine search on pack setup fails after extension preparation revokes
`PUBLIC` execution of `public.similarity_op(text,text)`.

The current code already restores the narrowly scoped privilege for the restricted application
role:

- `prisma/prepare-runtime-role.ts:100-102` includes an explicit `GRANT EXECUTE ON FUNCTION
  public.similarity_op(text,text) TO devfathom_app` in the runtime-role grant list.
- `prisma/prepare-runtime-role.ts:112-115` executes every entry in that grant list whenever runtime
  role preparation runs, including for an existing role.
- `tests/prepare-runtime-role.test.ts:44-64` verifies that fresh-role preparation issues the exact
  function grant and does not expose the supplied password in logs.
- `tests/prepare-runtime-role.test.ts:76-92` verifies that all grants are still issued for an
  existing correctly restricted role even when an optional password alteration is denied.

This is the minimum required access: it grants execution only on the named two-argument function
to `devfathom_app`; it does not restore `PUBLIC` execution, broaden database privileges, bypass
row-level security, or change application authorization behavior.
