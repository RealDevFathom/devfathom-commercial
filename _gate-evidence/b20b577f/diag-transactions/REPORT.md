# WHA-1222 transaction diagnostic

## Disposition

Diagnostic complete. The reported gate failure did not reproduce in the required isolated invocation on `b20b577f`. The comparison commit `76faf6a1` produced the same passing result. The captured database evidence does not identify a leaked connection or lock holder in `print-bridge`, the restaurant jobs runner, seed, or the four named new DB lanes.

The original a07a5518 error strings supplied in the task were:

```text
Transaction API error: Unable to start a transaction in the given time
Hook timed out in 10000ms
```

Neither string appeared in any reproduced run, so no additional stack text can honestly be attributed to this diagnostic.

## Required observations

1. `b20b577f` isolated suite: PASS, 1 file and 11/11 tests, 4.60 seconds. See `b20b577f-m4-alone.log` and `.exit-code` (`0`). Therefore it does not fail alone.
2. PostgreSQL while the isolated suite ran: the requested activity and ungranted-lock queries were sampled every 500 ms. The first sampler used `gate_owner`, which PostgreSQL correctly restricted to its own query plus opaque other backends; every ungranted-lock sample was still `(0 rows)`. A second diagnostic run used cluster superuser `gate_admin` and gave full visibility. It observed at most 10 backends, transient `idle in transaction` sessions actively owned by the running test files, and zero ungranted locks in all 10 samples. After process exit only the five PostgreSQL background processes and the sampler remained; no test client, interactive transaction, or lock remained.
3. `76faf6a1` isolated suite: PASS, 1 file and 11/11 tests, 4.88 seconds. See `76faf6a1-m4-alone.log` and `.exit-code` (`0`).
4. New-lane attribution: no leaked post-suite connection was observed, so no file can be named as the culprit. A bounded five-file concurrent probe covered `restaurant-m4-acceptance`, `offline-counter`, `finance-postings`, `bookkeeping`, and `jobs.purge`. Restaurant M4 and three of the four new lanes passed. `bookkeeping.db.test.ts` failed two assertions with `PrismaClientValidationError: Unknown argument organizationId`, which is a distinct generated-client validation failure, not the reported transaction-start or hook-timeout failure. No ungranted locks were present and all transient test connections disappeared when the run ended.

## PostgreSQL excerpts

No `too many clients`, lock timeout, transaction timeout, `FATAL`, or `PANIC` line exists in `postgres.log`. The notable lines are expected negative-path constraint tests, for example:

```text
ERROR:  pharmacy onboarding events are append-only; delete or purge the organization to remove its onboarding history
ERROR:  new row for relation "pharmacy_registered_devices" violates check constraint "pharmacy_registered_devices_revocation_check"
ERROR:  RECEIPT_LEASE_OVERLAP
ERROR:  OFFLINE_COMMAND_IMMUTABLE
ERROR:  QUOTA_EXCEEDS_ON_HAND
```

The complete server log is `postgres.log`; filtered excerpts are in `postgres-notable-excerpts.log`.

## Commands and results

- Reset claimed branch to exact base: `git reset --hard b20b577f` -> `b20b577f9d397855458cbef15ea8d178870d85a3`.
- Copied `node_modules` from the named WHA-1116 worktree and ran `bunx prisma generate` -> success, Prisma 7.9.1.
- Fresh PostgreSQL 16 on port 55499, socket `/tmp/pg-55499`; roles `gate_owner` and restricted `gate_runtime` (`rolsuper=false`, `rolbypassrls=false`).
- `prepare-extensions` -> success; 81 migrations -> success; generate -> success; seed -> first invocation failed closed because `SEED_PASSWORD` was absent, corrected invocation with the required diagnostic-only credential -> success; runtime grants -> success.
- Required isolated command on `b20b577f` -> exit 0, 11 passed.
- Same isolated command from detached `76faf6a1` worktree -> exit 0, 11 passed.
- Five-file attribution probe -> exit 1, 72 passed and 2 bookkeeping validation failures; no transaction-start error, hook timeout, waiting lock, or retained client.

## Conclusion and remaining risk

The evidence rules out an intrinsic failure in `tests/restaurant-m4-acceptance.test.ts` on either commit and provides no evidence of a leaked transaction in the named new lanes. It does not recreate the exact 43-suite a07a5518 scheduling conditions, because that prior JSON artifact is not present in this claimed checkout. The pattern remains consistent with a gate-wide scheduling/resource interaction, but that is an inference, not a proven root cause. A builder should use the original full-suite command and preserve a superuser-visible activity sample at the first timeout to distinguish pool scheduling from an external long-lived client.

No product code or tests were modified.
