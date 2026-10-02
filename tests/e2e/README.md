# Browser (Playwright) harness notes

## `next dev` on 127.0.0.1 needs `allowedDevOrigins` (WHA-1623)

The pharmacy-counter lane (and others) serve `next dev` on `http://127.0.0.1:<port>`.
Next 16 blocks its dev websocket (`/_next/webpack-hmr`) for origins not listed in
`allowedDevOrigins`, and that socket also carries the React debug channel the
initial page payload waits on. Without `allowedDevOrigins: ['127.0.0.1']` in
`next.config.ts` the page renders but **never hydrates**: the dev server logs
`Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr from "127.0.0.1"`.
The setting is dev-only; `next start` ignores it.

## Wait for hydration before signing in

`/login` forms set `data-hydrated="true"` once React owns them. Use
`waitForLoginHydrated(page)` from `fixtures/login-hydration.ts` before typing
(60 s budget, added to the test timeout). A submit that lands earlier is the
native POST to `/login/submit` — it signs in too, but it is not the client path
the suites exercise.
