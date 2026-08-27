# Terminal and device registry

## Requirement

- **IMPLEMENTED** — Back office registers/revokes devices and manages staff/operator credentials; terminals establish trusted sessions, heartbeat, lock/unlock, switch operators, and request co-authorization. Evidence: [`src/server/routers/restaurant-devices.ts`](../../../src/server/routers/restaurant-devices.ts), [`src/app/api/restaurant/terminal`](../../../src/app/api/restaurant/terminal), [`src/app/(app)/restaurant/devices/page.tsx`](../../../src/app/%28app%29/restaurant/devices/page.tsx).

## Acceptance and planned hardware

- Revoked, stale, wrong-branch, or unauthorized sessions fail; sensitive actions retain actor/device context. Evidence: [`tests/restaurant-m2-contract.test.ts`](../../../tests/restaurant-m2-contract.test.ts), [`tests/restaurant-m2-terminal-threats.test.ts`](../../../tests/restaurant-m2-terminal-threats.test.ts).
- **PLANNED (WHA-212)** — Camera live feed/storage, Hikvision/EZVIZ, Dahua/IMOU, Uniview, TP-Link presets, tenant and platform-console wizard, manual ONVIF/RTSP fallback.
- **PLANNED (WHA-243 owner decision)** — Physical print bridge. Device registration does not imply printer or camera integration.
