# DEV-1001 visual source and family coverage

This is an explicit mapping of all **147 migrated application source files (367 source controls)** from `inventory.md` to the 78 representative screen fixtures in `screen-sources.md`. It does not turn a family representative into evidence that a different file was rendered. Screenshots use actual components, not reconstructed control galleries.

**Direct** means the file is explicitly listed as an actual source of a fixture. **Family representative** means a related workflow in the same product/module has a fixture, while this exact file/layout has no direct screenshot evidence. **Gap** means there is no sufficiently close workflow fixture; its family is named below. All direct rows remain subject to conditional-state and route-integration limits. The 86 listed source files include the retained native restaurant branch component, hence 85 are migrated files.

| Evidence level | Migrated files | Migrated source controls |
|---|---:|---:|
| Direct | 85 | 239 |
| Family representative | 62 | 128 |
| Gap | 0 | 0 |

## Named missing families

None remain without a workflow-family representative. This does **not** mean every migrated file or conditional control was directly captured. The exact direct-versus-representative distinction is retained in every row below.


## Every migrated source file

| Application source | Controls | Evidence level | Representative fixture / limitation |
|---|---:|---|---|
| `src/app/(app)/audit-logs/audit-content.tsx` | 6 | Direct | `workspace-audit` |
| `src/app/(app)/clients/[id]/client-detail-content.tsx` | 5 | Direct | `workspace-clients` |
| `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx` | 1 | Direct | `pharmacy-dashboard` |
| `src/app/(app)/dashboard/restaurant-management-overview.tsx` | 1 | Direct | `restaurant-dashboard` |
| `src/app/(app)/email/email-content.tsx` | 1 | Direct | `workspace-email` |
| `src/app/(app)/finance/finance-content.tsx` | 6 | Family representative | `workspace-finance` — Finance workspace and invoice workflow |
| `src/app/(app)/finance/invoices-tab.tsx` | 2 | Direct | `workspace-finance` |
| `src/app/(app)/hotel/settings/extras/page.tsx` | 1 | Family representative | `hotel-extras` — Hotel extras settings and property scope |
| `src/app/(app)/hotel/settings/journey/page.tsx` | 1 | Family representative | `hotel-journey` — Hotel journey templates and property scope |
| `src/app/(app)/hotel/settings/meal-plans/page.tsx` | 1 | Family representative | `hotel-meal-plans` — Hotel meal plan settings |
| `src/app/(app)/hotel/settings/property/page.tsx` | 1 | Family representative | `hotel-inventory` — Hotel property and room configuration |
| `src/app/(app)/hotel/settings/rooms/page.tsx` | 1 | Family representative | `hotel-inventory` — Hotel property and room configuration |
| `src/app/(app)/hotel/settings/spaces/page.tsx` | 1 | Family representative | `hotel-function-spaces` — Hotel function spaces and property scope |
| `src/app/(app)/hr/hr-content.tsx` | 3 | Direct | `workspace-hr` |
| `src/app/(app)/notes/notes-content.tsx` | 2 | Direct | `workspace-notes` |
| `src/app/(app)/organization/organization-admin-content.tsx` | 6 | Direct | `workspace-organization` |
| `src/app/(app)/pharmacy/accounts/account-activity-bridge/page.tsx` | 2 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/ap-aging/ap-entry-forms.tsx` | 5 | Direct | `pharmacy-accounts` |
| `src/app/(app)/pharmacy/accounts/ap-aging/payables-panels.tsx` | 2 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/branch-picker.tsx` | 1 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/cash-flow/page.tsx` | 1 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/cheque-maturity/page.tsx` | 1 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/journal-evidence-export/page.tsx` | 1 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/profit-loss/page.tsx` | 1 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/accounts/tax-profile-review/page.tsx` | 2 | Family representative | `pharmacy-accounts` — Pharmacy accounts scope, payables and financial reporting |
| `src/app/(app)/pharmacy/finance/ledger-reports.tsx` | 2 | Direct | `pharmacy-finance` |
| `src/app/(app)/pharmacy/finance/page.tsx` | 9 | Family representative | `pharmacy-finance` — Pharmacy financial ledger/reporting |
| `src/app/(app)/pharmacy/inventory/expiry/page.tsx` | 2 | Family representative | `pharmacy-expiry` — Pharmacy expiry inventory |
| `src/app/(app)/pharmacy/inventory/labels/page.tsx` | 2 | Family representative | `pharmacy-printing` — pharmacy-printing: shelf labels and printer settings |
| `src/app/(app)/pharmacy/inventory/page.tsx` | 10 | Family representative | `pharmacy-expiry` — Pharmacy inventory management and stock filters |
| `src/app/(app)/pharmacy/inventory/transfers/page.tsx` | 1 | Family representative | `pharmacy-transfers` — Pharmacy transfer allocation, receiving and slips |
| `src/app/(app)/pharmacy/khata/page.tsx` | 1 | Direct | `pharmacy-khata` |
| `src/app/(app)/pharmacy/loyalty/adjust-points-form.tsx` | 1 | Direct | `pharmacy-loyalty` |
| `src/app/(app)/pharmacy/loyalty/customer-search.tsx` | 1 | Family representative | `pharmacy-loyalty` — Pharmacy loyalty/customer balances and prepaid |
| `src/app/(app)/pharmacy/loyalty/page.tsx` | 1 | Family representative | `pharmacy-loyalty` — Pharmacy loyalty/customer balances and prepaid |
| `src/app/(app)/pharmacy/loyalty/prepaid/forms.tsx` | 5 | Direct | `pharmacy-loyalty` |
| `src/app/(app)/pharmacy/marketing/growth-panel.tsx` | 2 | Family representative | `pharmacy-marketing` — Pharmacy campaigns, vouchers and profiles |
| `src/app/(app)/pharmacy/marketing/page.tsx` | 5 | Family representative | `pharmacy-marketing` — Pharmacy campaigns, vouchers and profiles |
| `src/app/(app)/pharmacy/marketing/profile-panel.tsx` | 2 | Family representative | `pharmacy-marketing` — Pharmacy campaigns, vouchers and profiles |
| `src/app/(app)/pharmacy/marketing/voucher-panel.tsx` | 1 | Direct | `pharmacy-marketing` |
| `src/app/(app)/pharmacy/purchasing/_components/branch-scope.tsx` | 1 | Family representative | `pharmacy-purchasing` — Pharmacy receiving and purchase scope |
| `src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.tsx` | 2 | Direct | `pharmacy-purchasing` |
| `src/app/(app)/pharmacy/purchasing/receiving/page.tsx` | 1 | Family representative | `pharmacy-purchasing` — Pharmacy receiving and purchase scope |
| `src/app/(app)/pharmacy/reports/page.tsx` | 2 | Family representative | `pharmacy-reports` — Pharmacy report scope and replenishment advice |
| `src/app/(app)/pharmacy/reports/repeat-purchasing/page.tsx` | 1 | Family representative | `pharmacy-reports` — Pharmacy report scope and replenishment advice |
| `src/app/(app)/pharmacy/reports/replenishment/scenario-console.tsx` | 2 | Direct | `pharmacy-reports` |
| `src/app/(app)/pharmacy/reports/replenishment/seasonal-calendar-panel.tsx` | 1 | Direct | `pharmacy-reports` |
| `src/app/(app)/pharmacy/reports/supplier-credit-follow-up/page.tsx` | 1 | Family representative | `pharmacy-reports` — Pharmacy report scope and replenishment advice |
| `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx` | 3 | Family representative | `workspace-projects` — Project workspace lists, details, boards and import |
| `src/app/(app)/projects/[id]/project-detail-content.tsx` | 1 | Family representative | `workspace-projects` — Project workspace lists, details, boards and import |
| `src/app/(app)/projects/import/trello-import-content.tsx` | 2 | Family representative | `workspace-projects` — Project workspace lists, details, boards and import |
| `src/app/(app)/projects/projects-content.tsx` | 3 | Direct | `workspace-projects` |
| `src/app/(app)/restaurant/inventory/page.tsx` | 10 | Direct | `restaurant-inventory` |
| `src/app/(app)/restaurant/notifications/page.tsx` | 2 | Direct | `restaurant-notifications` |
| `src/app/(app)/restaurant/purchasing/page.tsx` | 4 | Direct | `restaurant-purchasing` |
| `src/app/(app)/restaurant/purchasing/receiving-form.tsx` | 1 | Direct | `restaurant-purchasing` |
| `src/app/(app)/restaurant/reports/page.tsx` | 2 | Direct | `restaurant-reports` |
| `src/app/(app)/restaurant/sop/admin/sop-admin.tsx` | 4 | Direct | `restaurant-procedures` |
| `src/app/(app)/restaurant/sop/oversight/page.tsx` | 3 | Family representative | `restaurant-procedures` — restaurant-procedures: administration, work, oversight and reports |
| `src/app/(app)/restaurant/sop/page.tsx` | 3 | Family representative | `restaurant-procedures` — restaurant-procedures: administration, work, oversight and reports |
| `src/app/(app)/restaurant/sop/reports/page.tsx` | 2 | Family representative | `restaurant-procedures` — restaurant-procedures: administration, work, oversight and reports |
| `src/app/(app)/reviews/reviews-content.tsx` | 2 | Direct | `workspace-reviews` |
| `src/app/(app)/settings/settings-content.tsx` | 1 | Direct | `workspace-settings` |
| `src/app/(app)/team/[id]/member-detail-content.tsx` | 2 | Family representative | `workspace-team` — Team directory and member detail |
| `src/app/(app)/team/team-content.tsx` | 2 | Direct | `workspace-team` |
| `src/app/(public)/my-pharmacy/portal-home.tsx` | 1 | Direct | `pharmacy-public-portal` |
| `src/app/login/register/request-form.tsx` | 1 | Direct | `registration-hotel`, `registration-pharmacy`, `registration-restaurant` |
| `src/app/platform/(console)/audit/page.tsx` | 1 | Direct | `platform-audit` |
| `src/app/platform/(console)/health/page.tsx` | 2 | Direct | `platform-health` |
| `src/app/platform/(console)/organizations/page.tsx` | 2 | Direct | `platform-organizations` |
| `src/components/chat/sidebar/create-channel-dialog.tsx` | 1 | Direct | `workspace-chat` |
| `src/components/hotel/extras-catalog.tsx` | 2 | Direct | `hotel-extras` |
| `src/components/hotel/function-spaces-panel.tsx` | 1 | Direct | `hotel-function-spaces` |
| `src/components/hotel/inventory-panel.tsx` | 7 | Direct | `hotel-inventory` |
| `src/components/hotel/journey-templates-editor.tsx` | 1 | Direct | `hotel-journey` |
| `src/components/hotel/meal-plans-panel.tsx` | 1 | Direct | `hotel-meal-plans` |
| `src/components/pharmacy/branch-assignments.tsx` | 2 | Direct | `pharmacy-branch-assignments` |
| `src/components/pharmacy/cameras/pharmacy-camera-wizard.tsx` | 2 | Direct | `pharmacy-cameras` |
| `src/components/pharmacy/cameras/pharmacy-cameras-console.tsx` | 3 | Family representative | `pharmacy-cameras` — Pharmacy camera setup and administration |
| `src/components/pharmacy/cameras/pharmacy-configured-setup.tsx` | 1 | Family representative | `pharmacy-cameras` — Pharmacy camera setup and administration |
| `src/components/pharmacy/catalogue-approval-queue.tsx` | 1 | Family representative | `pharmacy-reference-import` — Pharmacy catalogue review and publication |
| `src/components/pharmacy/counter-computers.tsx` | 1 | Direct | `pharmacy-devices` |
| `src/components/pharmacy/customer-ordering-console.tsx` | 4 | Direct | `pharmacy-orders` |
| `src/components/pharmacy/customer-portal-panel.tsx` | 2 | Direct | `pharmacy-customer-portal` |
| `src/components/pharmacy/delivery-evidence-form.tsx` | 1 | Direct | `pharmacy-orders` |
| `src/components/pharmacy/dispensing/controlled-register-console.tsx` | 3 | Family representative | `pharmacy-dispensing` — Pharmacy prescriptions, controlled records and substitution |
| `src/components/pharmacy/dispensing/prescriptions-console.tsx` | 8 | Family representative | `pharmacy-dispensing` — Pharmacy prescriptions, controlled records and substitution |
| `src/components/pharmacy/dispensing/substitution-console.tsx` | 1 | Family representative | `pharmacy-dispensing` — Pharmacy prescriptions, controlled records and substitution |
| `src/components/pharmacy/dispensing/substitution-form.tsx` | 1 | Direct | `pharmacy-dispensing` |
| `src/components/pharmacy/inventory/expiry-board.tsx` | 2 | Direct | `pharmacy-expiry` |
| `src/components/pharmacy/inventory/shelf-label-print-panel.tsx` | 1 | Direct | `pharmacy-printing` |
| `src/components/pharmacy/inventory/transfers/packing-slip-print-button.tsx` | 1 | Direct | `pharmacy-printing` |
| `src/components/pharmacy/inventory/transfers/transfer-allocate-form.tsx` | 2 | Family representative | `pharmacy-transfers` — Pharmacy transfer allocation, receiving and slips |
| `src/components/pharmacy/inventory/transfers/transfer-receive-form.tsx` | 1 | Direct | `pharmacy-transfers` |
| `src/components/pharmacy/medicine-pack-setup.tsx` | 3 | Direct | `pharmacy-pack-setup` |
| `src/components/pharmacy/medicine-reference-workbench.tsx` | 1 | Direct | `pharmacy-reference-import` |
| `src/components/pharmacy/migration-staging-form.tsx` | 2 | Family representative | `pharmacy-import` — Pharmacy import staging and mapping |
| `src/components/pharmacy/owner-import-wizard.tsx` | 3 | Direct | `pharmacy-import` |
| `src/components/pharmacy/printer-settings.tsx` | 3 | Direct | `pharmacy-printing` |
| `src/components/pharmacy/refill-program-console.tsx` | 6 | Direct | `pharmacy-refills` |
| `src/components/pharmacy/regulatory-profile-form.tsx` | 5 | Direct | `pharmacy-regulatory` |
| `src/components/pharmacy/sop/pharmacy-sop-workspace.tsx` | 1 | Family representative | `pharmacy-procedures` — Pharmacy procedure setup, work and record choice |
| `src/components/pharmacy/sop/sop-board.tsx` | 1 | Family representative | `pharmacy-procedures` — Pharmacy procedure setup, work and record choice |
| `src/components/pharmacy/sop/sop-record-picker.tsx` | 1 | Family representative | `pharmacy-procedures` — Pharmacy procedure setup, work and record choice |
| `src/components/pharmacy/sop/sop-setup.tsx` | 3 | Direct | `pharmacy-procedures` |
| `src/components/pharmacy/staged-medicine-catalogue.tsx` | 2 | Family representative | `pharmacy-reference-import` — Pharmacy catalogue review and publication |
| `src/components/pharmacy/supplier-price-lists.tsx` | 1 | Family representative | `pharmacy-purchasing` — Pharmacy supplier price list and purchasing |
| `src/components/platform/ai-settings-console.tsx` | 1 | Direct | `platform-ai-settings` |
| `src/components/platform/platform-command-form.tsx` | 1 | Direct | `platform-command` |
| `src/components/platform/support-access-form.tsx` | 1 | Direct | `platform-support` |
| `src/components/receipts/receipt-designer.tsx` | 2 | Direct | `receipt-designer` |
| `src/components/restaurant/catalog/catalog-console.tsx` | 18 | Direct | `restaurant-catalog` |
| `src/components/restaurant/catering/catering-console.tsx` | 8 | Direct | `restaurant-catering` |
| `src/components/restaurant/catering/catering-evidence.tsx` | 4 | Family representative | `restaurant-catering` — Restaurant catering events and evidence |
| `src/components/restaurant/catering/catering-terminal-boundary.tsx` | 1 | Family representative | `restaurant-catering` — Restaurant catering events and evidence |
| `src/components/restaurant/delivery/delivery-console.tsx` | 2 | Direct | `restaurant-delivery` |
| `src/components/restaurant/floor/floor-console.tsx` | 2 | Direct | `restaurant-floor` |
| `src/components/restaurant/growth/growth-review-panel.tsx` | 1 | Direct | `restaurant-growth` |
| `src/components/restaurant/kds/kds-board.tsx` | 1 | Direct | `restaurant-kds` |
| `src/components/restaurant/loyalty/loyalty-console.tsx` | 4 | Direct | `restaurant-loyalty` |
| `src/components/restaurant/menu-import/menu-import-console.tsx` | 2 | Direct | `restaurant-menu-import` |
| `src/components/restaurant/menus/menus-console.tsx` | 14 | Direct | `restaurant-menus` |
| `src/components/restaurant/money/money-console.tsx` | 1 | Direct | `restaurant-money` |
| `src/components/restaurant/operator-safe-selector.tsx` | 1 | Direct | `restaurant-selectors` |
| `src/components/restaurant/orders/orders-console.tsx` | 5 | Direct | `restaurant-orders` |
| `src/components/restaurant/pos/checkout-panel.tsx` | 1 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/drawer-panel.tsx` | 1 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/operator-switch.tsx` | 1 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/order-pad.tsx` | 5 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/order-ticket-panel.tsx` | 3 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/refund-panel.tsx` | 1 | Family representative | `restaurant-pos` — Restaurant POS checkout, ticket, operator and refund flows |
| `src/components/restaurant/pos/split-bill-dialog.tsx` | 2 | Direct | `restaurant-pos` |
| `src/components/restaurant/pos/tender-pad.tsx` | 1 | Direct | `restaurant-pos` |
| `src/components/restaurant/print-bridge-enrollment.tsx` | 1 | Family representative | `restaurant-printing` — restaurant-printing: printers, routing and bridge enrollment |
| `src/components/restaurant/print-routing-section.tsx` | 3 | Direct | `restaurant-printing` |
| `src/components/restaurant/printer-inventory-panel.tsx` | 1 | Family representative | `restaurant-printing` — restaurant-printing: printers, routing and bridge enrollment |
| `src/components/restaurant/printer-registration-fields.tsx` | 1 | Family representative | `restaurant-printing` — restaurant-printing: printers, routing and bridge enrollment |
| `src/components/restaurant/promotions/promotions-console.tsx` | 5 | Direct | `restaurant-promotions` |
| `src/components/restaurant/restaurant-camera-wizard.tsx` | 2 | Direct | `restaurant-cameras` |
| `src/components/restaurant/restaurant-device-select.tsx` | 1 | Direct | `restaurant-selectors` |
| `src/components/restaurant/restaurant-devices-console.tsx` | 4 | Direct | `restaurant-devices` |
| `src/components/restaurant/restaurant-roster-console.tsx` | 3 | Direct | `restaurant-roster` |
| `src/components/restaurant/restaurant-staff-console.tsx` | 5 | Direct | `restaurant-staff` |
| `src/components/restaurant/restaurant-staff-invite-dialog.tsx` | 1 | Family representative | `restaurant-staff` — Restaurant staff management and invitation |
| `src/components/restaurant/restaurant-staff-select.tsx` | 1 | Direct | `restaurant-selectors` |
| `src/components/restaurant/restaurant-tax-console.tsx` | 5 | Direct | `restaurant-tax` |
| `src/components/terminal/terminal-console.tsx` | 3 | Direct | `restaurant-terminal` |

No screenshot or keyboard result is asserted by this mapping alone. See `after-metrics.json`, the visual QA report and the source-control tests for executed evidence. Native exceptions and the DEV-977 counter exclusion remain documented separately in `inventory.md`.
