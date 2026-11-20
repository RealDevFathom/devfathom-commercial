# DEV-103 AP aging branch picker: visual QA evidence

Production build (`next build`, standalone) served against a seeded local PostgreSQL 16 (runtime
role without BYPASSRLS), headless Chromium, owner `ADMIN` and a non-owner `EMPLOYEE`.
Pharmacy Finance licensed, two active branches ("Main Branch", "Gulshan Branch").

States: `default` (nothing chosen), `selected`, `invalid-branch-url` (branch id not in the
organization), `denied-non-owner` (picker empty, router refuses), `empty-branch-list` (both branches
deactivated). Each at 375, 768, 1024 and 1440 px, light and dark; `default` also with
`prefers-reduced-motion: reduce` at 1024. `keyboard-focus-select-*` capture the focus pass.

Results (see `log-active.json`, `log-empty.json`): 42 captures, no document horizontal overflow,
no console or page errors. The select takes the Studio field surface in both themes and shows the
focus ring (3px ring token) on keyboard focus. Tab order after the select goes to the as-of date.

Defect found and fixed during the pass: with an unlisted branch in the URL the select displayed the
first listed branch (the placeholder was disabled). It now shows "Choose a branch".
Not covered: loading state (server-rendered, no client loading UI on this form) and
Escape behaviour (no dialog on this form).
