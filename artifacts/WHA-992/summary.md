# WHA-992 read-only preview smoke

Run date: 2026-08-31 (Asia/Karachi)

Required canonical: `2e36eae35e68d3a9c5e7f182684dd25aff924469`

## Result

| Scope | Result | Evidence |
|---|---|---|
| Assigned execution checkout | PASS | Branch matched and initial HEAD was exact canonical `2e36eae35e68d3a9c5e7f182684dd25aff924469` |
| Tenant health | PASS | Approved outer-sandbox `GET /api/health` returned HTTP 200 |
| Platform login availability | PASS | Approved outer-sandbox `GET /platform/login` returned HTTP 200 |
| Running preview canonical | FAIL | Port 3105 listener PID 84775 had cwd `WHA-953-compose-approved-restaurant-corrections-into-one-private-lineage`; that checkout HEAD was `541862adc5f479e677a21e54f8715f1a43b63458` |
| Restaurant authentication and route smoke | BLOCK | Not run against a non-canonical preview |
| SuperAdmin authenticated landing | BLOCK | Canonical mismatch; deterministic platform credentials also unavailable in this run environment |
| Agency entitlement | BLOCK | Canonical mismatch; safe Agency fixture credentials unavailable in this run environment |
| HTTP/console/runtime/hydration/link/navigation review | BLOCK | No browser page loaded after canonical precondition failed |
| Screenshots / Playwright trace | BLOCK | None captured; browser never launched |

## Diagnostic distinction

The mandated `devfathom-commercial` Codex CLI profile observed HTTP 000 because its inner workspace sandbox could not access local port 3105. That is a runner isolation limitation, not a product or preview outage: the approved outer-sandbox health and platform-login requests both returned HTTP 200, and `lsof` confirmed a Node listener on port 3105.

A direct fallback browser script was prepared but did not launch because this execution worktree has no local `node_modules/.bin/tsx`; dependencies were not installed. Subsequent listener-cwd inspection then established the stronger canonical mismatch blocker, so no alternate browser runner was attempted.

## Disposition

BLOCKED — preview owner must serve exact canonical `2e36eae35e68d3a9c5e7f182684dd25aff924469` on port 3105, then reassign or resume WHA-992. No source, test, app configuration, business data, user, order, dependency, process, remote, or security control was changed.
