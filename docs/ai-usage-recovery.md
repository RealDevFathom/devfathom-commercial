# Claude usage accounting recovery

Both Anthropic and Bedrock require `AI_USAGE_JOURNAL_DIR`, an absolute directory on a
private persistent volume. Mount the same directory in every worker, preserve it across
restarts and releases, and keep it outside any publicly served directory. Do not use a
container's ephemeral filesystem or a temporary directory in production. The filesystem
must support atomic rename and file/directory fsync. For example:

```dotenv
AI_USAGE_JOURNAL_DIR=/home/app/shared/ai-usage-journal
```

Each completed paid invocation writes and fsyncs a journal record before attempting its
ledger transaction. The record contains a UUID, provider, exact model, token counts,
original UTC invocation time and the six-decimal cost calculated from the price selected
before the purchase. It contains no tenant identifiers, prompts or generated content.

After a committed ledger insert the journal file is removed. If the transaction times out
or fails, paid output is returned and the file remains. Every subsequent Claude model
preflight and invocation replays pending records before reading the budget. A failed
replay stops new purchases until accounting recovers. Replay inserts the original UUID
with `ON CONFLICT DO NOTHING`, so a lost commit acknowledgement, concurrent workers or
a crash before journal cleanup cannot count a call twice. Ledger updates are never used.

Retain and alert on `AI_USAGE_PERSIST_FAILED` logs. They contain structured accounting
metadata, including the same UUID and original price rates, for reconciliation if the
journal filesystem itself fails after preflight. Restore a record with that UUID and
the original token counts, timestamp and calculated six-decimal cost to `<uuid>.json`
in the journal directory; the next preflight replays it. Do not generate another UUID
for the same call or delete pending records to restore service.

Malformed records block replay and remain available for investigation. A `.tmp` file can
remain if a worker crashes while publishing a record: stop writers before inspecting it,
recover the complete JSON from that file or the structured accounting log, then publish
it as `<uuid>.json`. Only complete `.json` files are automatically replayed. Missing
provider token counts require provider-side usage reconciliation; they are never recorded
as zero-cost usage.
