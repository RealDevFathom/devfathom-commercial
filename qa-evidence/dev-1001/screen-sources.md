# DEV-1001 actual screen sources

The isolated visual harness renders **78 screen families**, mapped below to **86 distinct application source files**. Each row uses the real presentation component or page with local synthetic props, query responses, and inert action adapters. No production service, authenticated route, or database workflow is exercised. Server presentation functions are resolved using in-memory fixture callers and explicit local read adapters.

These mappings identify presentation sources; they do not imply every conditional control or state is visible in each screenshot. The per-control migration inventory and test results are recorded separately. Matrix completion, failures, and retained native controls must be read from the QA report and metrics.

Screenshot names follow `after-<screen-family>-<width>-<theme>-<motion>.png`; menu captures append `-open`. A filename alone is not evidence that a menu is visibly open.

| Screen family | Actual application source | Fixture source |
|---|---|---|
| restaurant-selectors | `src/components/restaurant/restaurant-branch-select.tsx`<br>`src/components/restaurant/restaurant-staff-select.tsx`<br>`src/components/restaurant/restaurant-device-select.tsx`<br>`src/components/restaurant/operator-safe-selector.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| restaurant-cameras | `src/components/restaurant/restaurant-camera-wizard.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| restaurant-pos | `src/components/restaurant/pos/tender-pad.tsx`<br>`src/components/restaurant/pos/split-bill-dialog.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| pharmacy-import | `src/components/pharmacy/owner-import-wizard.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| platform-support | `src/components/platform/support-access-form.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| receipt-designer | `src/components/receipts/receipt-designer.tsx` | `tests/e2e/dev-1001-fixtures.tsx` |
| pharmacy-accounts | `src/app/(app)/pharmacy/accounts/ap-aging/ap-entry-forms.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| pharmacy-dispensing | `src/components/pharmacy/dispensing/substitution-form.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| pharmacy-transfers | `src/components/pharmacy/inventory/transfers/transfer-receive-form.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| hotel-meal-plans | `src/components/hotel/meal-plans-panel.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| pharmacy-expiry | `src/components/pharmacy/inventory/expiry-board.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| workspace-chat | `src/components/chat/sidebar/create-channel-dialog.tsx` | `tests/e2e/dev-1001-extra-fixtures.tsx` |
| restaurant-menu-import | `src/components/restaurant/menu-import/menu-import-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-money | `src/components/restaurant/money/money-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-catering | `src/components/restaurant/catering/catering-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-orders | `src/components/restaurant/orders/orders-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-delivery | `src/components/restaurant/delivery/delivery-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-kds | `src/components/restaurant/kds/kds-board.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-catalog | `src/components/restaurant/catalog/catalog-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-menus | `src/components/restaurant/menus/menus-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-staff | `src/components/restaurant/restaurant-staff-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-roster | `src/components/restaurant/restaurant-roster-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-devices | `src/components/restaurant/restaurant-devices-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-promotions | `src/components/restaurant/promotions/promotions-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-floor | `src/components/restaurant/floor/floor-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| restaurant-loyalty | `src/components/restaurant/loyalty/loyalty-console.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| pharmacy-regulatory | `src/components/pharmacy/regulatory-profile-form.tsx` | `tests/e2e/dev-1001-management-fixtures.tsx` |
| workspace-clients | `src/app/(app)/clients/[id]/client-detail-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-finance | `src/app/(app)/finance/invoices-tab.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-hr | `src/app/(app)/hr/hr-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-reviews | `src/app/(app)/reviews/reviews-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-email | `src/app/(app)/email/email-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-settings | `src/app/(app)/settings/settings-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-projects | `src/app/(app)/projects/projects-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-audit | `src/app/(app)/audit-logs/audit-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-organization | `src/app/(app)/organization/organization-admin-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-team | `src/app/(app)/team/team-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| workspace-notes | `src/app/(app)/notes/notes-content.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| registration-hotel | `src/app/login/register/request-form.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| registration-pharmacy | `src/app/login/register/request-form.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| registration-restaurant | `src/app/login/register/request-form.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| restaurant-terminal | `src/components/terminal/terminal-console.tsx` | `tests/e2e/dev-1001-general-fixtures.tsx` |
| pharmacy-finance | `src/app/(app)/pharmacy/finance/ledger-reports.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-loyalty | `src/app/(app)/pharmacy/loyalty/adjust-points-form.tsx`<br>`src/app/(app)/pharmacy/loyalty/prepaid/forms.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-marketing | `src/app/(app)/pharmacy/marketing/voucher-panel.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-reports | `src/app/(app)/pharmacy/reports/replenishment/scenario-console.tsx`<br>`src/app/(app)/pharmacy/reports/replenishment/seasonal-calendar-panel.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-pack-setup | `src/components/pharmacy/medicine-pack-setup.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-purchasing | `src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.tsx` | `tests/e2e/dev-1001-pharmacy-fixtures.tsx` |
| pharmacy-dashboard | `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| restaurant-dashboard | `src/app/(app)/dashboard/restaurant-management-overview.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-public-portal | `src/app/(public)/my-pharmacy/portal-home.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-customer-portal | `src/components/pharmacy/customer-portal-panel.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-cameras | `src/components/pharmacy/cameras/pharmacy-camera-wizard.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-refills | `src/components/pharmacy/refill-program-console.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-procedures | `src/components/pharmacy/sop/sop-setup.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| pharmacy-reference-import | `src/components/pharmacy/medicine-reference-workbench.tsx` | `tests/e2e/dev-1001-additional-fixtures.tsx` |
| restaurant-inventory | `src/app/(app)/restaurant/inventory/page.tsx` | `tests/e2e/dev-1001-inventory-page-fixture.tsx` |
| pharmacy-khata | `src/app/(app)/pharmacy/khata/page.tsx` | `tests/e2e/dev-1001-gap-finance-fixtures.tsx` |
| pharmacy-branch-assignments | `src/components/pharmacy/branch-assignments.tsx` | `tests/e2e/dev-1001-gap-finance-fixtures.tsx` |
| platform-audit | `src/app/platform/(console)/audit/page.tsx` | `tests/e2e/dev-1001-gap-platform-fixtures.tsx` |
| platform-health | `src/app/platform/(console)/health/page.tsx` | `tests/e2e/dev-1001-gap-platform-fixtures.tsx` |
| platform-organizations | `src/app/platform/(console)/organizations/page.tsx` | `tests/e2e/dev-1001-gap-platform-fixtures.tsx` |
| platform-ai-settings | `src/components/platform/ai-settings-console.tsx` | `tests/e2e/dev-1001-gap-platform-fixtures.tsx` |
| platform-command | `src/components/platform/platform-command-form.tsx` | `tests/e2e/dev-1001-gap-platform-fixtures.tsx` |
| restaurant-notifications | `src/app/(app)/restaurant/notifications/page.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-purchasing | `src/app/(app)/restaurant/purchasing/page.tsx`<br>`src/app/(app)/restaurant/purchasing/receiving-form.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-reports | `src/app/(app)/restaurant/reports/page.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-procedures | `src/app/(app)/restaurant/sop/admin/sop-admin.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-growth | `src/components/restaurant/growth/growth-review-panel.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-printing | `src/components/restaurant/print-routing-section.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| restaurant-tax | `src/components/restaurant/restaurant-tax-console.tsx` | `tests/e2e/dev-1001-gap-restaurant-fixtures.tsx` |
| pharmacy-devices | `src/components/pharmacy/counter-computers.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| pharmacy-printing | `src/components/pharmacy/printer-settings.tsx`<br>`src/components/pharmacy/inventory/shelf-label-print-panel.tsx`<br>`src/components/pharmacy/inventory/transfers/packing-slip-print-button.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| pharmacy-orders | `src/components/pharmacy/customer-ordering-console.tsx`<br>`src/components/pharmacy/delivery-evidence-form.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| hotel-inventory | `src/components/hotel/inventory-panel.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| hotel-extras | `src/components/hotel/extras-catalog.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| hotel-function-spaces | `src/components/hotel/function-spaces-panel.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
| hotel-journey | `src/components/hotel/journey-templates-editor.tsx` | `tests/e2e/dev-1001-gap-pharmacy-hotel-fixtures.tsx` |
