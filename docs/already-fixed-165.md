# GitHub issue #165: already fixed

Issue #165 reports that the production Content Security Policy allowed inline scripts without a
nonce or hash. The current code already fixes that report:

- `src/lib/security/content-security-policy.ts:16-21` builds a request-scoped `script-src`. In
  production it contains the supplied nonce and `'strict-dynamic'`, but neither
  `'unsafe-inline'` nor `'unsafe-eval'`.
- `src/proxy.ts:49-59` generates a fresh nonce for each request, builds the policy from it, and
  forwards both the policy and nonce to Next's renderer. `src/proxy.ts:64-66` also applies that
  policy to the outgoing response.
- `src/app/layout.tsx:208-225` reads the forwarded nonce and passes it to the preference bootstrap.
  `src/components/preference-bootstrap.tsx:6-12` places it on the inline
  `apply-user-preferences` script. Next can likewise nonce its framework bootstrap scripts because
  the CSP is present on the forwarded request.
- `src/lib/security/content-security-policy.test.ts:11-33` checks that production has a
  nonce-only script policy and that development alone retains `'unsafe-eval'` without adding
  `'unsafe-inline'`.
- `src/proxy.test.ts:98-110` checks that separate requests receive separate policies, that the
  response policy has no script `'unsafe-inline'`, and that the same nonce is forwarded to
  rendering.

No implementation change is needed.
