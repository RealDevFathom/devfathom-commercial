# Issue #466: `fix/growth-g2-followups` archive disposition

**Decision:** close the archived branch as obsolete. Do not recreate the branch, open a PR from
the tag, or cherry-pick any of its commits.

## Evaluation basis

The preserved tag `archive/fix/growth-g2-followups` points at `93e27ae3`. Issue #466 records these
16 commits as absent from the historical `main` comparison:

| Commit     | Archived change                                 | Disposition                               |
| ---------- | ----------------------------------------------- | ----------------------------------------- |
| `93e27ae3` | Bigint constructors in growth tests             | Obsolete with the archived implementation |
| `58eb10e8` | Bigint spend and a G2 migration stamp           | Obsolete data model                       |
| `b0e6fe9c` | Per-organization metrics tick failure isolation | Obsolete job implementation               |
| `3e3851a5` | Merge of the G2 work                            | Merge commit; do not replay               |
| `304a4aa6` | UTC parsing in PostgreSQL fixtures              | Obsolete fixtures                         |
| `f6463f25` | G2 validation-stop notes                        | Historical notes only                     |
| `1378c79e` | Nightly tenant customer-metrics job             | Obsolete job implementation               |
| `6e152825` | Merge of G1 into G2                             | Merge commit; do not replay               |
| `25834be5` | G1 blocker cleanup                              | Historical notes only                     |
| `646692de` | Demo `GrowthSettings` and templates             | Obsolete seed/data model                  |
| `dcbd97cc` | G1 data model and migration                     | Superseded data model                     |
| `67df65b5` | Invalid-G1-schema blocker notes                 | Historical notes only                     |
| `97e9d2c4` | Blocked G1 schema draft                         | Incomplete draft                          |
| `ecfc2f76` | Merge of restaurant loyalty work                | Unrelated merge commit; do not replay     |
| `d3e8cdad` | Loyalty wallet on receipts                      | Unrelated to this recovery                |
| `7b81f39e` | Gated growth-tick skeleton                      | Obsolete skeleton                         |

The archived line is not a safe source of incremental changes: it combines incomplete G1/G2
schema and job iterations, historical blocker documentation, merge commits, and unrelated
restaurant loyalty work. Replaying it would reintroduce an abandoned `GrowthSettings`/metrics-tick
architecture alongside the accepted shared growth implementation.

## Current implementation

`develop` already owns the supported shared `GrowthInsight` model and its pharmacy and restaurant
review ledgers in the current schema. Their database invariants are migration-owned, including
tenant scoping, append-only behavior, and review lineage. The current application also has the
pharmacy and restaurant growth workflows that use those models. The archive therefore contains no
still-relevant unit that can be ported without regressing or duplicating the accepted design.

The receipt loyalty commit is deliberately excluded from this recovery decision: it is unrelated
to G2 and must not be smuggled in through an archive-restoration ticket. Existing receipt and
loyalty behavior on `develop` remains unchanged.

## Resolution

- Keep the archive tag as historical evidence.
- Do not restore `fix/growth-g2-followups` as a branch.
- Do not open a PR from the archived tree.
- Do not cherry-pick any of the 16 commits listed above.
- Close #466 as resolved by this disposition record.
