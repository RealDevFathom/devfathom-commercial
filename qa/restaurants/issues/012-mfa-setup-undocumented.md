[QA][Restaurants][SEV3] Local setup does not say platform sign-in requires MFA enrollment
Labels: qa, restaurants, sev3-minor

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Platform host `http://admin.localhost:3000/platform/login`. `PLATFORM_MFA_ENFORCE` was unset. Executed 2026-10-21.

## Test case

SET-03.

## Steps

1. Follow `docs/LOCAL_SETUP.md` through seed.
2. Open `/platform/login` and sign in with the seeded platform administrator email and password.
3. Complete the MFA enrollment screen with a valid time-based code.

## Expected

The local setup guide tells the operator that the first platform sign-in requires MFA enrollment, how the setup key is shown, and that a 6-digit code completes it. Enrollment itself works and lands on `/platform`.

## Actual

Enrollment works. The login form asks for the authenticator code, a valid code lands on `/platform`, and later platform commands succeed. `docs/LOCAL_SETUP.md` does not mention MFA enrollment, so an operator following only that guide stops at a code prompt the document never describes.

The authenticator secret and recovery codes are not included here.

## Evidence

Platform sign-in during this pass reached `/platform` only after enrollment. The omission is in `docs/LOCAL_SETUP.md`.

## Suspected code

`docs/LOCAL_SETUP.md`. The enrollment behavior lives in `src/lib/platform/auth.ts` and the platform login form. No fix is proposed here.
