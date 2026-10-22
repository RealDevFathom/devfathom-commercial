# Issue #243 — already fixed on main

Issue #243 is already fixed in the current main snapshot, so no production code was changed.

## Static verification

- `regulatoryProfileInput` reports the invalid licence date on the
  `licenceValidTo` path. The existing unit coverage verifies that the formatted
  validation payload contains `fields.licenceValidTo` and does not place the
  error on `licenceValidFrom`.
- The shared tRPC error formatter turns that field name into the message prefix
  `Licence valid to:` and publishes the field errors as `data.validation` for a
  `BAD_REQUEST`.
- The regulatory form copies `data.validation.licenceValidTo` into its field
  error state. When present, the licence-valid-to input renders
  `aria-invalid="true"` and `aria-describedby="licenceValidTo-error"`, while the
  field wrapper renders the message as `#licenceValidTo-error` with
  `role="alert"`.

## Existing regression coverage

`src/lib/pharmacy/regulatory-profile-form.test.ts` already covers the
cross-field licence-date rejection and its field-level formatted payload. Per
the task constraint for the old environment, the test suite was not run and no
dependencies were installed.
