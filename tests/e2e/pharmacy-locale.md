Run `bun run test:e2e:pharmacy-locale` with the same guarded local database and
synthetic credentials used by `test:e2e:pharmacy-counter`. Give each invocation a
fresh disposable database; do not share a database between these two lanes.
The existing runner performs preflight and seeds the fixture twice, then forwards
the locale configuration to Playwright.

The locale suite checks real cookie-backed SSR direction, English/Urdu layout and
font loading across 80 viewport/height/theme/motion combinations, catalogue alias
permission refusal and scoped writes, Urdu cash settlement, and switching language
while one tender request is held in flight. It makes no external customer sends.
