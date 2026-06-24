# DEPLOY-NOTES.md — deploy-gated enhancements (PLAT-02, PLAT-03)

These two improvements can't be implemented or validated in a local dev environment —
each needs a real Vercel deployment plus an external service and a new dependency. They
are intentionally left as documented `todo` (per the owner's call) rather than shipped as
untested code that could silently break production uploads/telemetry.

## IMP-PLAT-02 — Production file storage (Vercel Blob)

**Why deploy-gated:** uploads currently write to a local `private-uploads/` dir served by
`/api/files/[name]` (auth'd; see RT-05). Vercel's filesystem is ephemeral, so production
needs object storage. Validating requires a Blob store + token that only exist on Vercel.

**Steps at deploy time:**
1. `bun add @vercel/blob`.
2. Create a Blob store in the Vercel dashboard → it injects `BLOB_READ_WRITE_TOKEN`.
3. In `src/app/api/upload/route.ts`: when `BLOB_READ_WRITE_TOKEN` is set, `put(filename, file,
   { access: 'public' | 'private' })` from `@vercel/blob` and store the returned URL on the
   record; else fall back to the current local-FS write (keeps dev working).
4. Delivery: for private blobs, mint short-lived signed URLs in `/api/files/[name]` (keep the
   existing session + per-channel membership checks from RT-05 as the gate before signing).
5. Verify in a Vercel Preview deploy: upload → fetch → membership-denied path.

## IMP-PLAT-03 — Observability (error tracking + request metrics)

**Why deploy-gated:** needs an error-tracking project (DSN) and runs meaningfully only against
real production traffic. The flagged 500-prone paths (raw FK errors, JSON parse, etc.) were
already hardened in the bug program (REST-05/06/07); this adds the *visibility* layer.

**Steps at deploy time:**
1. `bun add @sentry/nextjs` (or the tracker of choice), run its wizard → `SENTRY_DSN` +
   `instrumentation.ts` / client+server configs.
2. Wrap the tRPC error formatter and the `/api/v1` `withApiAuth` catch to report exceptions
   (the audit trail already records REST failures — forward the same `errorCode`/`path`).
3. Add request metrics via Vercel's built-in Web Analytics / Speed Insights (`@vercel/analytics`)
   or the tracker's performance monitoring.
4. Verify the flagged 500 paths surface as captured events in a Preview deploy.

---
_All other 67 enhancements + 53 bugs are shipped on `fix/qa-remediation`. AI-02's audit-surfacing
half shipped; its "citations" half is deferred (needs the untracked assistant `src/lib/ai/context.ts`
refactor committed first)._
