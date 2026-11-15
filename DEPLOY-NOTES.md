# DEPLOY-NOTES.md — deploy-gated enhancements (PLAT-02, PLAT-03)

These two improvements can't be implemented or validated in a local dev environment —
each needs a real AWS deployment plus an external service and a new dependency. They
are intentionally left as documented `todo` (per the owner's call) rather than shipped as
untested code that could silently break production uploads/telemetry.

## IMP-PLAT-02 — Production file storage (S3)

**Why deploy-gated:** local development may use a private filesystem fallback, while the
production path requires `STORAGE_ADAPTER=s3` with a private S3 uploads bucket
(`S3_UPLOADS_BUCKET`, `AWS_REGION`) and credentials from the runtime role.

**Steps at deploy time:**
1. Configure `STORAGE_ADAPTER=s3`, the uploads bucket and the runtime role in the target
   environment (see [docs/deploy/aws.md](docs/deploy/aws.md)).
2. Keep private object access behind the existing session and per-channel membership checks.
3. Verify upload, fetch, and membership-denied paths in AWS staging before production.

## IMP-PLAT-03 — Observability (error tracking + request metrics)

**Why deploy-gated:** needs an error-tracking project (DSN) and runs meaningfully only against
real production traffic. The flagged 500-prone paths (raw FK errors, JSON parse, etc.) were
already hardened in the bug program (REST-05/06/07); this adds the *visibility* layer.

**Steps at deploy time:**
1. `bun add @sentry/nextjs` (or the tracker of choice), run its wizard → `SENTRY_DSN` +
   `instrumentation.ts` / client+server configs.
2. Wrap the tRPC error formatter and the `/api/v1` `withApiAuth` catch to report exceptions
   (the audit trail already records REST failures — forward the same `errorCode`/`path`).
3. Add request metrics and alerting through the selected observability path.
4. Verify the flagged 500 paths surface as captured events in AWS staging.

---
_All other 67 enhancements + 53 bugs are shipped on `fix/qa-remediation`. AI-02's audit-surfacing
half shipped; its "citations" half is deferred (needs the untracked assistant `src/lib/ai/context.ts`
refactor committed first)._
