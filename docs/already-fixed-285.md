# GitHub issue #285 is already fixed

Issue #285 reported that two proposed migrations shared the
`20261021180000` timestamp:

- `20261021180000_pharmacy_rx_fill_release`
- `20261021180000_repair_package_module_cleanup`

Neither migration is present in the current tree, so the reported collision
cannot occur on this branch. The current migration sequence for that date
continues through the independently named controlled-correction migration
([`prisma/migrations/20261021160000_controlled_correction_invariants/migration.sql`,
line 1](../prisma/migrations/20261021160000_controlled_correction_invariants/migration.sql#L1))
and outbound-effect worker migration
([`prisma/migrations/20261021160000_outbound_effect_worker/migration.sql`, line
1](../prisma/migrations/20261021160000_outbound_effect_worker/migration.sql#L1)).

This was verified from the tracked tree with:

```sh
git ls-files 'prisma/migrations/*/migration.sql' |
  rg '20261021180000|pharmacy_rx_fill_release|repair_package_module_cleanup'
```

The command produces no matches. No migration was added or renamed because
doing so would manufacture migration history for changes that are not on the
current branch.
