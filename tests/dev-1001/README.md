# Shared Select behavior coverage

The permanent DEV-1001 tests exercise the real organization-administration screen
with deterministic query and mutation dependencies. They cover labels and stored
role values, keyboard navigation and selection, successful form values, the
upstream pharmacy PIN behavior, refused-change reset, and pending submission
disablement. They do not freeze JSX source, import order, class names, or an entire
repository inventory.

```sh
node_modules/.bin/vitest run tests/dev-1001/organization-control-parity.test.tsx
```

The screen’s role options currently remain enabled on `develop`; these tests
preserve that behavior rather than introducing new permission decisions. The
[shared component tests](../../src/components/ui/select-field.test.tsx) separately
exercise disabled options, disabled fieldsets, required fields, reset and focus.
Existing screen tests throughout `src/` retain their assertions and intent.

The jsdom screen test uses ArrowDown/End navigation and an Enter keydown, then
explicitly supplies a zero-detail click because jsdom does not perform the browser
activation default action. This proves navigation and the resulting application
payload, not actual browser Enter. The browser form runner in
`tests/e2e/dev-1001-form-parity.mjs` separately uses trusted Chromium Enter events
without an option-click fallback, including normal and reduced motion, blank and
required values, disabled controls, and form submission. Its synthetic responses
are intercepted in memory, without a local/LAN listener or outbound network.
