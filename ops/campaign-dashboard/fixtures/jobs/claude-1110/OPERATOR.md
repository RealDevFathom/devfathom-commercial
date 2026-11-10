# Worker operator

Operator: Claude (Saad's cloud session)

Since about 10:45 PKT on 10 Nov Claude operates the worker; Inky has stood down.
claude-wave1.service runs wave1.py: each batch-1 task rebuilt as one commit on develop fa2004e2, full gates in parallel.
No Codex is dispatched by this run, so 0 Codex jobs is expected.
CODEX_1110_STOP / REBASE37_1110_STOP / RETARGET1906_STOP bind only Inky's controller and are left in place on purpose.
rebase-1906-1110 is superseded and read-only. Canceled (never Azure): DEV-339, DEV-341.
