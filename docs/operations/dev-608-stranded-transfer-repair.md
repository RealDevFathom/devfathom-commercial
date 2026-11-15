# Same-branch transfers stranded in transit: repair

Linear: DEV-608. GitHub: #1228. This runbook does **not** approve a run. Each environment needs
its own approval, given on the dry-run output.

## What went wrong

Before DEV-608, moving stock between two locations in the same branch
(`pharmacyInventory.transfer`, which calls `transferStock`) posted two movements:

- `<prefix>:out`: `TRANSFER_OUT`, `AVAILABLE`, at the origin location.
- `<prefix>:in`: `TRANSFER_IN`, `IN_TRANSIT`, at the destination location.

No transfer record was created, so nothing could receive or cancel the second leg. Those units
are counted on hand, but they cannot be sold or moved.

The code fix makes new moves land `AVAILABLE` at a saleable destination. It does not touch
movements that were already posted. This runbook repairs those.

## What the repair does

For every stranded pair, `repair.sql` posts the exact linked reversal of both legs. A reversal is
an `ADJUSTMENT` movement whose `reversesMovementId` names the original movement. This is the
ledger's own correction mechanism (PUR-04, §8A invariant 8):

- It takes the units out of `IN_TRANSIT` at the destination.
- It puts them back `AVAILABLE` at the origin.

After the repair, the stock sits exactly where it was before the move. If staff still want the
units at the destination, they repeat the move in the app. The fixed code lands them `AVAILABLE`
there, provided the destination is a saleable location (store, rack/bin, fridge or safe).

The ledger is append-only. The repair never updates or deletes a movement. Balances change only
through the ledger trigger, which still enforces these rules:

- No bucket goes negative.
- Each reversal is the exact negation of its original movement, and no movement is reversed twice.
- Cold-chain stock is only made available in a validated cold-chain zone.

Every reversal records the actor `system:dev-608-repair` and a reason naming DEV-608.

### Pairs held back for a person

The repair leaves two kinds of pair untouched. The dry run lists them with the reason:

| `heldBack`                 | Meaning                                                                                                                                                                            | What to do                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IN_TRANSIT_BALANCE_SHORT` | The `IN_TRANSIT` bucket no longer holds all the stranded units, because some were counted, adjusted or written off since. Reversing the full pair would drive the bucket negative. | Reconcile the bucket with a stock count, then run the dry run again.                                                                                       |
| `ORIGIN_NOT_COLD_CHAIN`    | The medicine needs cold chain, but the origin is not a validated cold-chain zone.                                                                                                  | Decide with the pharmacist in charge. Either validate the zone or move the stock through the quarantine flow. The repair will not make it available there. |

## How to identify the stranded pairs

The repair picks up a `TRANSFER_IN` movement only when all of these hold:

- Its disposition is `IN_TRANSIT`.
- Its idempotency key ends in `:in`.
- It has an unreversed `TRANSFER_OUT`/`AVAILABLE` partner under the same prefix ending in `:out`, with the same lot and branch and the exactly opposite quantity and arrangement.

No other code path writes that shape:

- Inter-branch dispatch uses `:transit`.
- Inter-branch receipt is `AVAILABLE` and uses `:received`.

The dry run and the repair select pairs with the same block of SQL, between the
`-- candidates:begin` and `-- candidates:end` markers. A test (`tests/dev-608-stranded-transfer-repair.test.ts`) keeps the copies identical.

## Steps

Run every step as the migration owner (`MIGRATION_DATABASE_URL`), never as the runtime role.

1. Dry run. This is read-only and ends in `ROLLBACK`. Keep the output; it is the evidence for
   approval.

   ```bash
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f docs/operations/dev-608-stranded-transfer-repair/dry-run.sql
   ```

   It prints one row per stranded pair, with `willRepair` and `heldBack`, and then the counts:
   `strandedPairs`, `pairsToRepair`, `unitsToReturn`, the two held-back counts, and the
   number of organizations.

2. Get approval for that output in this environment.

3. Repair.

   ```bash
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f docs/operations/dev-608-stranded-transfer-repair/repair.sql
   ```

   - It locks stock writes for the duration of its few statements, so no sale, count or move
     can draw on the same buckets mid-repair.
   - It reports `pairsRepaired`, `reversalMovementsPosted` (always twice the pairs) and
     `unitsReturned`. These must equal the dry run's `pairsToRepair` and `unitsToReturn`.
   - It raises an error and rolls everything back if the number of reversals posted is not
     exactly twice the number of pairs.

4. Run the dry run again. `pairsToRepair` must be `0`. Any rows still listed are the held-back
   pairs, for a person to resolve.

The repair is idempotent. A pair it has reversed is no longer a candidate, so a second run
posts nothing.

## Rollback

The repair only adds reversal movements, and the ledger refuses to reverse a reversal. A
repaired pair leaves the stock exactly as it was before the original move. If the units belong
at the destination, repeat the move in the app. Never update or delete ledger rows.
