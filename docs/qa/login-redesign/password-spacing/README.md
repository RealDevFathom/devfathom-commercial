# PR #681 password spacing and licence date follow-up

The auth input recipe now reserves 48px at the inline end for the shared
`PasswordInput` reveal control. The reservation uses a persistent data attribute,
so revealing the password cannot remove it. Login, shared login, reset and invite
forms retain their existing handlers, labels, error associations and password state.
The Studio palette, shell, vertical copy and solo-owner routing are unchanged.

The 375px regression fills a 192-character password, moves the caret to the end,
and checks that the input's text content edge stops before the reveal button in
both masked and revealed states. It covers neutral, pharmacy, restaurant, hotel,
agency and Studio sign-in plus valid reset and invitation forms, in both themes.
Recovery validation uses explicit valid-response fixtures; existing integration
checks continue using real endpoints and the local Postgres database.

The Playwright config defaults to `http://app.localhost:4321` for shared-host QA
(and still accepts `PLAYWRIGHT_BASE_URL`):
`127.0.0.1` resolves the configured default tenant, whose vertical takes precedence
over presentation query parameters.

## Validation

- `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck`: passed on retry.
  The first run was killed during concurrent host memory pressure.
- `npm run lint`: passed; no findings.
- `npx eslint tests/e2e/login-redesign.config.ts tests/e2e/login-redesign.spec.ts`: passed.
- Prettier check of all changed source files and browser test: passed.
- `npx vitest run src/app/login src/lib/auth src/components/auth src/app/auth-recovery-studio.test.ts src/app/forgot-password src/app/reset-password src/app/change-password src/app/invite src/app/api/login src/lib/platform/auth.rate-limit.test.ts`:
  25 files, 316 tests passed, including solo-owner continuation, native submit,
  credential errors, password mismatch/error associations and licence regressions.
- Licence cases include 2099-02-31, ordinary and century non-leap years,
  leap years divisible by 4 and 400, month/day bounds, exact date formatting,
  valid month ends, today and expired dates with a fixed clock.
- Targeted Playwright long-password cases: 2 passed (light and dark), 32 populated
  masked/revealed route-state combinations.

- `NODE_OPTIONS=--max-old-space-size=8192 npm run build -- --webpack`: passed,
  including Next TypeScript validation and page generation.
- `npx playwright test --config tests/e2e/login-redesign.config.ts --output /tmp/r2-production-runtime-output`:
  **16 passed (2.2m)** against the production standalone app.

The dev run finished with 13 passed and 3 unavailable-link loading timeouts;
all eight matrices passed unchanged against production. Earlier Turbopack serving
errors and host memory pressure were local execution limitations. The production
startup guard correctly refused the supplied superuser database role. QA used a
temporary NOSUPERUSER/NOBYPASSRLS role on that same local database, with the
original environment URL used for fixtures and assertions. The role was removed
and the local server stopped afterward. No startup guards or rate limits were
bypassed, and no assertions were removed or relaxed.

## Design QA matrix

| Check                 | Result                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewports             | Passed: 375, 768, 1024 and 1440px across 14 auth routes.                                                                                                              |
| Themes                | Passed: light and dark at all four widths.                                                                                                                            |
| Motion                | Passed: reduced at 375/1024; normal at 768/1440.                                                                                                                      |
| Keyboard              | Passed: visible focus, tab order, Enter reveal and Escape; original field/error associations retained.                                                                |
| Layout                | Passed: no document horizontal overflow; RTL reflow; masked/revealed long text clears the button.                                                                     |
| States                | Passed: empty forms, unavailable links, credential errors, request loading/disabled/error/success, CRM permission denial. Destructive confirmation is not applicable. |
| Console/accessibility | Passed: no unexpected console/page errors; WCAG A/AA axe checks at 375/1440. Expected invalid-invitation 404s remain explicitly asserted.                             |
| Product parity        | Passed: Studio auth split shell and existing vertical context preserved; CRM evidence access verified.                                                                |

## Captures

- [Restaurant masked, light](restaurant-sign-in-long-password-masked-375-light.png)
- [Restaurant revealed, light](restaurant-sign-in-long-password-revealed-375-light.png)
- [Restaurant revealed, dark](restaurant-sign-in-long-password-revealed-375-dark.png)
- [Reset revealed, light](reset-password-long-password-revealed-375-light.png)
- [Invitation revealed, dark](accept-invite-long-password-revealed-375-dark.png)
- [Desktop split shell, dark](restaurant-sign-in-1440-dark.png)

All browser captures are also generated under `/tmp/login-shots`.
