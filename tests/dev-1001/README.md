# DEV-1001 control-boundary regression evidence

`control-fixtures.json` freezes the 377 in-scope native controls from develop commit
`002b84ee1ca72880cee1f0ffebf4cdd79d343236`, identified by original file and line.
The 31 pharmacy-counter controls are excluded. Ten other controls have explicit
native exceptions; 367 controls are migrated.

Run the complete suite:

```sh
bunx vitest run tests/dev-1001/control-parity.test.tsx --maxWorkers=1
```

The suite has two complementary checks:

- For every control, the live JSX must preserve the baseline attributes, callback
  expressions, option templates, and associated visible label. Only the native
  tag's replacement by `StudioSelect` and comments/formatting may differ. Retained
  controls must still be native. This catches field-name, permission, validation,
  value-transform, and label changes at the call site.
- Each of the 367 migrated controls is rendered first as a native control and then
  through the real shared `SelectField`. It compares accessible name, selected
  value/text, option labels/disabled states, `FormData`, validity, reset, 44px
  target classes, keyboard navigation/activation outcome, Escape, and restored trigger focus.
  Native bridge focus/accessibility exclusion is also asserted.

The jsdom tests navigate with ArrowDown/End and send an Enter keydown, then
explicitly call `fireEvent.click(option, { detail: 0 })`, matching the repository's
existing shared Select test. That click supplies the browser activation that
jsdom does not synthesize. These per-control tests therefore prove the navigation
and commit outcome, but **do not by themselves prove actual browser Enter
activation**.

Separate [Chromium form evidence](../../qa-evidence/dev-1001/form-parity.json)
uses `page.keyboard.press('Enter')` with **no option-click fallback**. It records
five trusted Enter key events per run and verifies the resulting selection and
submitted values. The four runs cover server rendering/hydration and client-only
rendering, each with normal and reduced motion and the existing Studio CSS.
All 56 browser checks pass. These are representative shared-component fixtures,
not 367 individual browser route tests.

The browser checks distinguish raw `FormData` from successful form submission:

- An enabled optional blank submits its name with `''`, including after keyboard
  selection back to the blank option.
- A required blank exists in raw `FormData` with `''`, but native validation
  prevents a successful submit and focuses the first invalid shared trigger.
- A directly disabled required blank neither blocks validation nor submits.
- A disabled fieldset omits its ordinary field, while its first-legend field
  remains enabled and submits, matching native HTML behavior.
- Disabled options and disabled optgroups are skipped by keyboard navigation;
  enabled fields and the externally associated form field submit exactly once.

Run the browser evidence with `node tests/e2e/dev-1001-form-parity.mjs all`.
Every request to the reserved synthetic `dev1001.invalid` origin is intercepted
and fulfilled from in-memory HTML/JS/CSS, or aborted. No HTTP listener, hosted
site, external network request, application server or database is used.

Dynamic records and dynamic label expressions use deterministic local stand-ins.
Literal choices and resolvable lexical constants come from the baseline source;
conditional option templates are represented together, with duplicate synthetic
values disambiguated. These are **control-boundary tests**, not authenticated route
or database tests. They do not exercise page data loading, parent conditional
rendering, permission decisions, or server actions. Existing screen tests and the
browser visual matrix provide separate evidence for those surfaces.

The generator is reproducible and reads only Git source:

```sh
node tests/dev-1001/generate-fixtures.cjs
```

Do not regenerate this baseline to accept a regression. Review any change to the
frozen source, native-exception set, or fixture interpretation against the original
commit and the issue's acceptance criteria.
