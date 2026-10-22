# Issue #243 — already fixed

Issue #243 is already fixed in the current code, so no production code or test
code was changed.

## File-and-line evidence

- `src/lib/pharmacy/regulatory-profile-form.ts:111-120` validates the licence
  date relationship and attaches the resulting issue to the
  `licenceValidTo` path.
- `src/lib/validation-error.ts:10-21` retains Zod field errors and derives the
  formatted message from the first field name. For `licenceValidTo`, the
  camel-case conversion produces the required `Licence valid to:` prefix.
- `src/server/trpc.ts:121-135` formats `BAD_REQUEST` validation failures,
  publishes their field map as `data.validation`, and uses the prefixed
  validation message in the response.
- `src/components/pharmacy/regulatory-profile-form.tsx:119-135` copies
  `data.validation` messages into the form's per-field error state rather than
  falling back to the form-level alert when field errors exist.
- `src/components/pharmacy/regulatory-profile-form.tsx:55-80` gives a field
  error the predictable `${htmlFor}-error` ID and `role="alert"`.
- `src/components/pharmacy/regulatory-profile-form.tsx:467-477` binds the
  `licenceValidTo` error to the expiry input, sets `aria-invalid`, and points
  `aria-describedby` at `licenceValidTo-error`.
- `src/lib/pharmacy/regulatory-profile-form.test.ts:69-77` already provides
  focused regression coverage for both date-format and cross-field failures,
  including the `licenceValidTo` field assignment.

## Verification constraint

This conclusion was reached by static inspection. In accordance with the issue
instructions for the Bun 1.2.14/no-database/npm-403 environment, dependencies
were not installed and tests were not run.
