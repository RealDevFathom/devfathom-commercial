# WHA-1212 automated gate evidence

This directory contains the mechanically retargeted WHA-1179/WHA-1125 gate harness and its raw output.
The gate target was commit `134f17fa15dc6cb3733f1368dcff54b1faf47a7d` on PostgreSQL 16 port `55594`.

The gate is **BLOCKED before database bootstrap**. PostgreSQL 16.15 `initdb` succeeded, but
`pg_ctl` could not start the server because the Paperclip run-scratch Unix socket filename was
longer than PostgreSQL's 103-byte maximum. A single correction shortened the socket directory;
the complete filename remained 121 bytes and the same failure recurred, so no further retry was
made. The first attempt is preserved under `attempt-1-socket-path-failure/`.

No product code, tests, or migrations were modified. Docker was independently checked once after
the stop boundary and was unavailable, so the image gate is NOT RUN.
