# GitHub issue #285: migration timestamp collision fix

The two `20261021180000` migrations named in issue #285 are not in the current
tree. However, verification of every current migration timestamp found the
same collision class at `20261021160000`:

- `20261021160000_controlled_correction_invariants`
- the formerly named `20261021160000_outbound_effect_worker`

The outbound-effect-worker migration now has the issue-specific, unique
timestamp `20261023000285`. Its SQL remains unchanged. The migration's focused
contract test also references the renamed path, so a stale or missing path
fails explicitly.

Verification must inspect timestamp prefixes rather than only the two names
from the original report. The following command prints every duplicate prefix;
`20261021160000` and `20261023000285` must not appear in its output:

```sh
find prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
  cut -d_ -f1 | sort | uniq -d
```

Older duplicate prefixes reported by that repository-wide audit are existing
migration-history debt and are intentionally not renamed here: renaming
already-shipped migrations would make Prisma treat them as unapplied. This fix
is limited to the newly identified collision and preserves migration contents
and ordering semantics.
