# GitHub issue #221 is already fixed

Issue #221 reports that the password hint in **Platform → Operators → Add operator** used
the low-contrast `text-text-faint` token in the light theme. The current implementation is
already fixed:

- `src/components/platform/platform-command-form.tsx:472-475` renders field help with
  `text-text-muted`, rather than `text-text-faint`.
- `src/app/globals.css:923-933` defines the light-theme card background as `#ffffff`,
  `--text-muted` as `#6c6c68`, and the superseded `--text-faint` as `#a3a39e`.
- `tests/platform-sensitive-forms.test.tsx:9-25` renders the operator password hint and
  asserts that it includes `text-text-muted` and excludes `text-text-faint`.

The latest supplied security review also marks the issue #221 delta as a pass and identifies
no authorization, tenancy, data, secret, or messaging behavior changes. No additional code
change is needed.
