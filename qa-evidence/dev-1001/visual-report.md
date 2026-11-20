# DEV-1001 visual QA evidence

Baseline: `002b84ee1ca72880cee1f0ffebf4cdd79d343236`. Chromium renders real application presentation components using existing Studio CSS/fonts, synthetic records and inert local adapters. No authenticated service, production data or production database is used. Earlier saved captures used a temporary loopback fixture server. After the no-hosting instruction, the harness fulfills a reserved `https://dev1001.invalid` origin entirely from already-read static HTML/JS/CSS/font bytes through Playwright interception. Every other request is aborted; there is no network request, HTTP listener, or local/LAN hosting. 128 default and 16 state rows are explicitly recorded as in-memory static reruns. Chromium blocks `file://` navigation by administrator policy; that policy was not changed. Previous captures are reused rather than represented as newly rerun.

## Results

The saved evidence contains **1248/1248 default variants** across **78 representative screen families**; 78 families have all 16 combinations. Each complete family covers **375/768/1024/1440px × light/dark × normal/reduced motion**.

The metrics record **0 console/render-error variants**, **0 variants with a control below 44px**, **0 keyboard-failure variants**, **0 focus observations without a ring/outline**, and **16 document-overflow variants**. There are 3264 recorded control keyboard checks. The state matrix contains **272/272 variants** across 17 supported state cases, with 0 console errors and 0 document overflows. Destructive confirmation has 16/16 captures; 16 record cancellation and restored focus.

No missing variant, recorded keyboard failure, console error or unstyled shared-focus observation remains in the saved metrics. The baseline layout failures below still prevent a green layout release gate.

## What the interaction evidence proves

The visual matrix uses actual Playwright browser keyboard input: ArrowDown opens shared menus, Escape closes them and restores trigger focus, and Tab leaves the trigger. Later focused reruns additionally wait for focus inside the opened popup and an eventual visible ring or outline. Open-menu screenshots use the real viewport without forcing animation completion; focus must remain inside the popup after capture. Full-page/forced-animation captures can dismiss a popup and incorrectly send the following Escape to its parent editor, so that capture artifact was removed without relaxing keyboard assertions. When a modal is open, interaction is scoped to that dialog. Retained native controls use ArrowDown and Tab; their operating-system popup is not claimed as a DOM listbox. Hover and active-option styles/captures are recorded by later runs where present.

**Enter evidence is separate.** This visual matrix does not test Enter selection. [Browser form evidence](form-parity.json) records actual browser End/Enter activation. The per-control jsdom suite sends End/Enter but then explicitly invokes a zero-detail click because jsdom does not perform the native keyboard activation default action. That fallback is interaction-contract coverage, not proof of actual browser Enter. See [control methodology](../../tests/dev-1001/README.md) and the browser-form records for their exact scope, including blank, required and disabled submissions.

[Raw default metrics](after-metrics.json) · [Raw state metrics](state-metrics.json) · [Source-family map](screen-sources.md) · [Every migrated file’s visual family](visual-family-coverage.md) · [Investigation history](visual-investigation.md)

## Baseline layout failures

The following four mobile document-overflow layouts are reproduced from the immutable baseline with the same synthetic records. They remain failures of the Studio document-overflow rule; they are not migration regressions and are included in the 16 failure count.

| Fixture at 375px | Baseline document width | Current document width | Before / after |
|---|---:|---:|---|
| hotel-function-spaces | 462px | 462px | [PNG](before-hotel-function-spaces-375-light-no-preference.png) / [PNG](after-hotel-function-spaces-375-light-no-preference.png) |
| restaurant-money | 391px | 391px | [PNG](before-restaurant-money-375-light-no-preference.png) / [PNG](after-restaurant-money-375-light-no-preference.png) |
| workspace-clients | 581px | 581px | [PNG](before-workspace-clients-375-light-no-preference.png) / [PNG](after-workspace-clients-375-light-no-preference.png) |
| workspace-hr | 389px | 389px | [PNG](before-workspace-hr-375-light-no-preference.png) / [PNG](after-workspace-hr-375-light-no-preference.png) |

Manual comparisons also retain these pre-existing clipping/crowding issues. The image links are direct evidence, not passing layout claims.

| Family | Recorded limitation | Before / after |
|---|---|---|
| restaurant-printing | First KOT fieldset and station/destination controls clip inside the card | [PNG](before-restaurant-printing-375-light-no-preference.png) / [PNG](after-restaurant-printing-375-light-no-preference.png) |
| restaurant-procedures | Template-library eyebrow and status badge overlap | [PNG](before-restaurant-procedures-375-light-no-preference.png) / [PNG](after-restaurant-procedures-375-light-no-preference.png) |
| hotel-inventory | Opening focus scrolls the existing wide table/inline editor | [PNG](before-hotel-inventory-375-light-no-preference.png) / [PNG](after-hotel-inventory-375-light-no-preference.png) |
| hotel-function-spaces | Wide table and booking form overflow on mobile | [PNG](before-hotel-function-spaces-375-light-no-preference.png) / [PNG](after-hotel-function-spaces-375-light-no-preference.png) |
| hotel-journey | Heading and actions are crowded on mobile | [PNG](before-hotel-journey-375-light-no-preference.png) / [PNG](after-hotel-journey-375-light-no-preference.png) |
| pharmacy-orders | Storefront heading/search controls are crowded | [PNG](before-pharmacy-orders-375-light-no-preference.png) / [PNG](after-pharmacy-orders-375-light-no-preference.png) |
| workspace-notes | Adjacent Share action clips; selected Private value is restored | [PNG](before-workspace-notes-375-light-no-preference.png) / [PNG](after-workspace-notes-375-light-no-preference.png) |

Recorded direct visual reviews include the seven added restaurant families, seven pharmacy/hotel families, five platform mobile families, Khata and branch assignments on mobile, and workspace finance on desktop/dark, plus earlier representative inspections. The resumed review also inspected the 375px dark archive confirmation and the 1440px light hotel claim popup directly. This report does not infer an exhaustive manual review merely from the existence of screenshots.

## Coverage limits

All 147 migrated application source files are mapped: **85 directly rendered files and 62 related-workflow representatives**, with zero named family gaps. The 78 fixture families render 86 distinct application presentation sources including the retained native branch component. A family representative is not a claim that another file, every conditional control, or every state was directly rendered.

These are presentation fixtures, not authenticated route journeys. They do not prove production permission gates, application-wide Next hydration, data mutations, or database workflows. Server presentation functions receive local in-memory callers. The full live-route Studio release gate is **not claimed passed**. Baseline layout failures and any outstanding metrics above remain explicit blockers to that claim.

There are 139 targeted baseline PNGs; this is not a full before matrix. Files ending `-open.png` show a capture point and are not alone proof of a visible operating-system picker. Intermediate `-keyboard-failure.png` images preserve investigations and must not be counted as passing captures.

## Reproduce without hosting

```sh
node tests/e2e/dev-1001-visual-qa.mjs after
DEV1001_STATES_ONLY=1 node tests/e2e/dev-1001-visual-qa.mjs after
DEV1001_SCREENS=workspace-clients,workspace-hr,restaurant-money,hotel-function-spaces node tests/e2e/dev-1001-visual-qa.mjs before
```

The runner supplies in-memory static browser responses, without a local/LAN HTTP server or outbound network. `DEV1001_SCREENS` selects families; `DEV1001_KEYS` selects exact variant keys; `DEV1001_PROBE=1` captures 375px/light/normal without keyboard assertions. Full runs merge evidence by exact key. Both motion settings remain present in the final matrix.

## Screen gallery

| Screen family | Variants | 375px / light | 1440px / dark |
|---|---:|---|---|
| hotel-extras | 16/16 | [PNG](after-hotel-extras-375-light-no-preference.png) | [PNG](after-hotel-extras-1440-dark-no-preference.png) |
| hotel-function-spaces | 16/16 | [PNG](after-hotel-function-spaces-375-light-no-preference.png) | [PNG](after-hotel-function-spaces-1440-dark-no-preference.png) |
| hotel-inventory | 16/16 | [PNG](after-hotel-inventory-375-light-no-preference.png) | [PNG](after-hotel-inventory-1440-dark-no-preference.png) |
| hotel-journey | 16/16 | [PNG](after-hotel-journey-375-light-no-preference.png) | [PNG](after-hotel-journey-1440-dark-no-preference.png) |
| hotel-meal-plans | 16/16 | [PNG](after-hotel-meal-plans-375-light-no-preference.png) | [PNG](after-hotel-meal-plans-1440-dark-no-preference.png) |
| pharmacy-accounts | 16/16 | [PNG](after-pharmacy-accounts-375-light-no-preference.png) | [PNG](after-pharmacy-accounts-1440-dark-no-preference.png) |
| pharmacy-branch-assignments | 16/16 | [PNG](after-pharmacy-branch-assignments-375-light-no-preference.png) | [PNG](after-pharmacy-branch-assignments-1440-dark-no-preference.png) |
| pharmacy-cameras | 16/16 | [PNG](after-pharmacy-cameras-375-light-no-preference.png) | [PNG](after-pharmacy-cameras-1440-dark-no-preference.png) |
| pharmacy-customer-portal | 16/16 | [PNG](after-pharmacy-customer-portal-375-light-no-preference.png) | [PNG](after-pharmacy-customer-portal-1440-dark-no-preference.png) |
| pharmacy-dashboard | 16/16 | [PNG](after-pharmacy-dashboard-375-light-no-preference.png) | [PNG](after-pharmacy-dashboard-1440-dark-no-preference.png) |
| pharmacy-devices | 16/16 | [PNG](after-pharmacy-devices-375-light-no-preference.png) | [PNG](after-pharmacy-devices-1440-dark-no-preference.png) |
| pharmacy-dispensing | 16/16 | [PNG](after-pharmacy-dispensing-375-light-no-preference.png) | [PNG](after-pharmacy-dispensing-1440-dark-no-preference.png) |
| pharmacy-expiry | 16/16 | [PNG](after-pharmacy-expiry-375-light-no-preference.png) | [PNG](after-pharmacy-expiry-1440-dark-no-preference.png) |
| pharmacy-finance | 16/16 | [PNG](after-pharmacy-finance-375-light-no-preference.png) | [PNG](after-pharmacy-finance-1440-dark-no-preference.png) |
| pharmacy-import | 16/16 | [PNG](after-pharmacy-import-375-light-no-preference.png) | [PNG](after-pharmacy-import-1440-dark-no-preference.png) |
| pharmacy-khata | 16/16 | [PNG](after-pharmacy-khata-375-light-no-preference.png) | [PNG](after-pharmacy-khata-1440-dark-no-preference.png) |
| pharmacy-loyalty | 16/16 | [PNG](after-pharmacy-loyalty-375-light-no-preference.png) | [PNG](after-pharmacy-loyalty-1440-dark-no-preference.png) |
| pharmacy-marketing | 16/16 | [PNG](after-pharmacy-marketing-375-light-no-preference.png) | [PNG](after-pharmacy-marketing-1440-dark-no-preference.png) |
| pharmacy-orders | 16/16 | [PNG](after-pharmacy-orders-375-light-no-preference.png) | [PNG](after-pharmacy-orders-1440-dark-no-preference.png) |
| pharmacy-pack-setup | 16/16 | [PNG](after-pharmacy-pack-setup-375-light-no-preference.png) | [PNG](after-pharmacy-pack-setup-1440-dark-no-preference.png) |
| pharmacy-printing | 16/16 | [PNG](after-pharmacy-printing-375-light-no-preference.png) | [PNG](after-pharmacy-printing-1440-dark-no-preference.png) |
| pharmacy-procedures | 16/16 | [PNG](after-pharmacy-procedures-375-light-no-preference.png) | [PNG](after-pharmacy-procedures-1440-dark-no-preference.png) |
| pharmacy-public-portal | 16/16 | [PNG](after-pharmacy-public-portal-375-light-no-preference.png) | [PNG](after-pharmacy-public-portal-1440-dark-no-preference.png) |
| pharmacy-purchasing | 16/16 | [PNG](after-pharmacy-purchasing-375-light-no-preference.png) | [PNG](after-pharmacy-purchasing-1440-dark-no-preference.png) |
| pharmacy-reference-import | 16/16 | [PNG](after-pharmacy-reference-import-375-light-no-preference.png) | [PNG](after-pharmacy-reference-import-1440-dark-no-preference.png) |
| pharmacy-refills | 16/16 | [PNG](after-pharmacy-refills-375-light-no-preference.png) | [PNG](after-pharmacy-refills-1440-dark-no-preference.png) |
| pharmacy-regulatory | 16/16 | [PNG](after-pharmacy-regulatory-375-light-no-preference.png) | [PNG](after-pharmacy-regulatory-1440-dark-no-preference.png) |
| pharmacy-reports | 16/16 | [PNG](after-pharmacy-reports-375-light-no-preference.png) | [PNG](after-pharmacy-reports-1440-dark-no-preference.png) |
| pharmacy-transfers | 16/16 | [PNG](after-pharmacy-transfers-375-light-no-preference.png) | [PNG](after-pharmacy-transfers-1440-dark-no-preference.png) |
| platform-ai-settings | 16/16 | [PNG](after-platform-ai-settings-375-light-no-preference.png) | [PNG](after-platform-ai-settings-1440-dark-no-preference.png) |
| platform-audit | 16/16 | [PNG](after-platform-audit-375-light-no-preference.png) | [PNG](after-platform-audit-1440-dark-no-preference.png) |
| platform-command | 16/16 | [PNG](after-platform-command-375-light-no-preference.png) | [PNG](after-platform-command-1440-dark-no-preference.png) |
| platform-health | 16/16 | [PNG](after-platform-health-375-light-no-preference.png) | [PNG](after-platform-health-1440-dark-no-preference.png) |
| platform-organizations | 16/16 | [PNG](after-platform-organizations-375-light-no-preference.png) | [PNG](after-platform-organizations-1440-dark-no-preference.png) |
| platform-support | 16/16 | [PNG](after-platform-support-375-light-no-preference.png) | [PNG](after-platform-support-1440-dark-no-preference.png) |
| receipt-designer | 16/16 | [PNG](after-receipt-designer-375-light-no-preference.png) | [PNG](after-receipt-designer-1440-dark-no-preference.png) |
| registration-hotel | 16/16 | [PNG](after-registration-hotel-375-light-no-preference.png) | [PNG](after-registration-hotel-1440-dark-no-preference.png) |
| registration-pharmacy | 16/16 | [PNG](after-registration-pharmacy-375-light-no-preference.png) | [PNG](after-registration-pharmacy-1440-dark-no-preference.png) |
| registration-restaurant | 16/16 | [PNG](after-registration-restaurant-375-light-no-preference.png) | [PNG](after-registration-restaurant-1440-dark-no-preference.png) |
| restaurant-cameras | 16/16 | [PNG](after-restaurant-cameras-375-light-no-preference.png) | [PNG](after-restaurant-cameras-1440-dark-no-preference.png) |
| restaurant-catalog | 16/16 | [PNG](after-restaurant-catalog-375-light-no-preference.png) | [PNG](after-restaurant-catalog-1440-dark-no-preference.png) |
| restaurant-catering | 16/16 | [PNG](after-restaurant-catering-375-light-no-preference.png) | [PNG](after-restaurant-catering-1440-dark-no-preference.png) |
| restaurant-dashboard | 16/16 | [PNG](after-restaurant-dashboard-375-light-no-preference.png) | [PNG](after-restaurant-dashboard-1440-dark-no-preference.png) |
| restaurant-delivery | 16/16 | [PNG](after-restaurant-delivery-375-light-no-preference.png) | [PNG](after-restaurant-delivery-1440-dark-no-preference.png) |
| restaurant-devices | 16/16 | [PNG](after-restaurant-devices-375-light-no-preference.png) | [PNG](after-restaurant-devices-1440-dark-no-preference.png) |
| restaurant-floor | 16/16 | [PNG](after-restaurant-floor-375-light-no-preference.png) | [PNG](after-restaurant-floor-1440-dark-no-preference.png) |
| restaurant-growth | 16/16 | [PNG](after-restaurant-growth-375-light-no-preference.png) | [PNG](after-restaurant-growth-1440-dark-no-preference.png) |
| restaurant-inventory | 16/16 | [PNG](after-restaurant-inventory-375-light-no-preference.png) | [PNG](after-restaurant-inventory-1440-dark-no-preference.png) |
| restaurant-kds | 16/16 | [PNG](after-restaurant-kds-375-light-no-preference.png) | [PNG](after-restaurant-kds-1440-dark-no-preference.png) |
| restaurant-loyalty | 16/16 | [PNG](after-restaurant-loyalty-375-light-no-preference.png) | [PNG](after-restaurant-loyalty-1440-dark-no-preference.png) |
| restaurant-menu-import | 16/16 | [PNG](after-restaurant-menu-import-375-light-no-preference.png) | [PNG](after-restaurant-menu-import-1440-dark-no-preference.png) |
| restaurant-menus | 16/16 | [PNG](after-restaurant-menus-375-light-no-preference.png) | [PNG](after-restaurant-menus-1440-dark-no-preference.png) |
| restaurant-money | 16/16 | [PNG](after-restaurant-money-375-light-no-preference.png) | [PNG](after-restaurant-money-1440-dark-no-preference.png) |
| restaurant-notifications | 16/16 | [PNG](after-restaurant-notifications-375-light-no-preference.png) | [PNG](after-restaurant-notifications-1440-dark-no-preference.png) |
| restaurant-orders | 16/16 | [PNG](after-restaurant-orders-375-light-no-preference.png) | [PNG](after-restaurant-orders-1440-dark-no-preference.png) |
| restaurant-pos | 16/16 | [PNG](after-restaurant-pos-375-light-no-preference.png) | [PNG](after-restaurant-pos-1440-dark-no-preference.png) |
| restaurant-printing | 16/16 | [PNG](after-restaurant-printing-375-light-no-preference.png) | [PNG](after-restaurant-printing-1440-dark-no-preference.png) |
| restaurant-procedures | 16/16 | [PNG](after-restaurant-procedures-375-light-no-preference.png) | [PNG](after-restaurant-procedures-1440-dark-no-preference.png) |
| restaurant-promotions | 16/16 | [PNG](after-restaurant-promotions-375-light-no-preference.png) | [PNG](after-restaurant-promotions-1440-dark-no-preference.png) |
| restaurant-purchasing | 16/16 | [PNG](after-restaurant-purchasing-375-light-no-preference.png) | [PNG](after-restaurant-purchasing-1440-dark-no-preference.png) |
| restaurant-reports | 16/16 | [PNG](after-restaurant-reports-375-light-no-preference.png) | [PNG](after-restaurant-reports-1440-dark-no-preference.png) |
| restaurant-roster | 16/16 | [PNG](after-restaurant-roster-375-light-no-preference.png) | [PNG](after-restaurant-roster-1440-dark-no-preference.png) |
| restaurant-selectors | 16/16 | [PNG](after-restaurant-selectors-375-light-no-preference.png) | [PNG](after-restaurant-selectors-1440-dark-no-preference.png) |
| restaurant-staff | 16/16 | [PNG](after-restaurant-staff-375-light-no-preference.png) | [PNG](after-restaurant-staff-1440-dark-no-preference.png) |
| restaurant-tax | 16/16 | [PNG](after-restaurant-tax-375-light-no-preference.png) | [PNG](after-restaurant-tax-1440-dark-no-preference.png) |
| restaurant-terminal | 16/16 | [PNG](after-restaurant-terminal-375-light-no-preference.png) | [PNG](after-restaurant-terminal-1440-dark-no-preference.png) |
| workspace-audit | 16/16 | [PNG](after-workspace-audit-375-light-no-preference.png) | [PNG](after-workspace-audit-1440-dark-no-preference.png) |
| workspace-chat | 16/16 | [PNG](after-workspace-chat-375-light-no-preference.png) | [PNG](after-workspace-chat-1440-dark-no-preference.png) |
| workspace-clients | 16/16 | [PNG](after-workspace-clients-375-light-no-preference.png) | [PNG](after-workspace-clients-1440-dark-no-preference.png) |
| workspace-email | 16/16 | [PNG](after-workspace-email-375-light-no-preference.png) | [PNG](after-workspace-email-1440-dark-no-preference.png) |
| workspace-finance | 16/16 | [PNG](after-workspace-finance-375-light-no-preference.png) | [PNG](after-workspace-finance-1440-dark-no-preference.png) |
| workspace-hr | 16/16 | [PNG](after-workspace-hr-375-light-no-preference.png) | [PNG](after-workspace-hr-1440-dark-no-preference.png) |
| workspace-notes | 16/16 | [PNG](after-workspace-notes-375-light-no-preference.png) | [PNG](after-workspace-notes-1440-dark-no-preference.png) |
| workspace-organization | 16/16 | [PNG](after-workspace-organization-375-light-no-preference.png) | [PNG](after-workspace-organization-1440-dark-no-preference.png) |
| workspace-projects | 16/16 | [PNG](after-workspace-projects-375-light-no-preference.png) | [PNG](after-workspace-projects-1440-dark-no-preference.png) |
| workspace-reviews | 16/16 | [PNG](after-workspace-reviews-375-light-no-preference.png) | [PNG](after-workspace-reviews-1440-dark-no-preference.png) |
| workspace-settings | 16/16 | [PNG](after-workspace-settings-375-light-no-preference.png) | [PNG](after-workspace-settings-1440-dark-no-preference.png) |
| workspace-team | 16/16 | [PNG](after-workspace-team-375-light-no-preference.png) | [PNG](after-workspace-team-1440-dark-no-preference.png) |

## State gallery

| Family / state | Variants | 375px / light | 1440px / dark |
|---|---:|---|---|
| pharmacy-import / denied | 16/16 | [PNG](after-pharmacy-import-denied-375-light-no-preference.png) | [PNG](after-pharmacy-import-denied-1440-dark-no-preference.png) |
| pharmacy-import / empty | 16/16 | [PNG](after-pharmacy-import-empty-375-light-no-preference.png) | [PNG](after-pharmacy-import-empty-1440-dark-no-preference.png) |
| pharmacy-import / error | 16/16 | [PNG](after-pharmacy-import-error-375-light-no-preference.png) | [PNG](after-pharmacy-import-error-1440-dark-no-preference.png) |
| pharmacy-import / loading | 16/16 | [PNG](after-pharmacy-import-loading-375-light-no-preference.png) | [PNG](after-pharmacy-import-loading-1440-dark-no-preference.png) |
| receipt-designer / empty | 16/16 | [PNG](after-receipt-designer-empty-375-light-no-preference.png) | [PNG](after-receipt-designer-empty-1440-dark-no-preference.png) |
| receipt-designer / error | 16/16 | [PNG](after-receipt-designer-error-375-light-no-preference.png) | [PNG](after-receipt-designer-error-1440-dark-no-preference.png) |
| receipt-designer / loading | 16/16 | [PNG](after-receipt-designer-loading-375-light-no-preference.png) | [PNG](after-receipt-designer-loading-1440-dark-no-preference.png) |
| restaurant-cameras / disabled | 16/16 | [PNG](after-restaurant-cameras-disabled-375-light-no-preference.png) | [PNG](after-restaurant-cameras-disabled-1440-dark-no-preference.png) |
| restaurant-cameras / error | 16/16 | [PNG](after-restaurant-cameras-error-375-light-no-preference.png) | [PNG](after-restaurant-cameras-error-1440-dark-no-preference.png) |
| restaurant-cameras / loading | 16/16 | [PNG](after-restaurant-cameras-loading-375-light-no-preference.png) | [PNG](after-restaurant-cameras-loading-1440-dark-no-preference.png) |
| restaurant-catalog / confirmation | 16/16 | [PNG](after-restaurant-catalog-confirmation-375-light-no-preference.png) | [PNG](after-restaurant-catalog-confirmation-1440-dark-no-preference.png) |
| restaurant-pos / disabled | 16/16 | [PNG](after-restaurant-pos-disabled-375-light-no-preference.png) | [PNG](after-restaurant-pos-disabled-1440-dark-no-preference.png) |
| restaurant-selectors / denied | 16/16 | [PNG](after-restaurant-selectors-denied-375-light-no-preference.png) | [PNG](after-restaurant-selectors-denied-1440-dark-no-preference.png) |
| restaurant-selectors / disabled | 16/16 | [PNG](after-restaurant-selectors-disabled-375-light-no-preference.png) | [PNG](after-restaurant-selectors-disabled-1440-dark-no-preference.png) |
| restaurant-selectors / empty | 16/16 | [PNG](after-restaurant-selectors-empty-375-light-no-preference.png) | [PNG](after-restaurant-selectors-empty-1440-dark-no-preference.png) |
| restaurant-selectors / error | 16/16 | [PNG](after-restaurant-selectors-error-375-light-no-preference.png) | [PNG](after-restaurant-selectors-error-1440-dark-no-preference.png) |
| restaurant-selectors / loading | 16/16 | [PNG](after-restaurant-selectors-loading-375-light-no-preference.png) | [PNG](after-restaurant-selectors-loading-1440-dark-no-preference.png) |
