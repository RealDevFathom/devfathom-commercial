## Complete baseline native-select inventory

Baseline: `002b84ee1ca72880cee1f0ffebf4cdd79d343236`. AST inventory: **408 product JSX controls in 164 files** (the 409th text match was a documentation comment): **367 migrated, 10 retained exceptions, 31 counter controls excluded by DEV-977**. Counts are JSX source controls; mapped controls may render more than once. Seven native test fixtures remain below. The new shared SelectField native bridge is a form/validation implementation detail, not a retained old-style visible dropdown.


`src/app/(app)/audit-logs/audit-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 318 | Audit category filter | Moved |
| 331 | Audit operation filter | Moved |
| 344 | Audit source filter | Moved |
| 357 | Audit outcome filter | Moved |
| 370 | Audit person / actor filter | Moved |
| 388 | Branch | Moved |

`src/app/(app)/clients/[id]/client-detail-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 335 | Status | Moved |
| 1433 | Status | Moved |
| 1448 | Contract value currency | Moved |
| 1470 | Linked Project | Moved |
| 1628 | Contract status | Moved |

`src/app/(app)/dashboard/pharmacy-dashboard-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 401 | Dashboard branch | Moved |

`src/app/(app)/dashboard/restaurant-management-overview.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 730 | Saved / closed date range | Moved |

`src/app/(app)/email/email-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 595 | From | Moved |

`src/app/(app)/finance/finance-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 380 | Expense category in transaction editor | Moved |
| 607 | Category | Moved |
| 623 | Project | Moved |
| 638 | Client | Moved |
| 849 | Category | Moved |
| 863 | Interval | Moved |

`src/app/(app)/finance/invoices-tab.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 378 | Client * | Moved |
| 393 | Project | Moved |

`src/app/(app)/hotel/settings/extras/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 128 | Property | Moved |

`src/app/(app)/hotel/settings/journey/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 162 | Property | Moved |

`src/app/(app)/hotel/settings/meal-plans/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 131 | Property | Moved |

`src/app/(app)/hotel/settings/property/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 84 | Property | Moved |

`src/app/(app)/hotel/settings/rooms/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 127 | Property | Moved |

`src/app/(app)/hotel/settings/spaces/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 146 | Property | Moved |

`src/app/(app)/hr/hr-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 500 | Type | Moved |
| 760 | Member | Moved |
| 774 | Year | Moved |

`src/app/(app)/notes/notes-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 561 | Note visibility | Moved |
| 861 | Shared user view / edit permission | Moved |

`src/app/(app)/organization/organization-admin-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 577 | System role | Moved |
| 585 | Department | Moved |
| 595 | Role template | Moved |
| 696 | Existing user system role / status (mapped field) | Moved |
| 714 | Department | Moved |
| 724 | Custom role | Moved |

`src/app/(app)/pharmacy/accounts/account-activity-bridge/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 167 | Account activity branch | Moved |
| 189 | Account and currency | Moved |

`src/app/(app)/pharmacy/accounts/ap-aging/ap-entry-forms.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 152 | Currency | Moved |
| 222 | Invoice | Moved |
| 254 | Paid from | Moved |
| 335 | Credit note | Moved |
| 345 | Supplier bill | Moved |

`src/app/(app)/pharmacy/accounts/ap-aging/payables-panels.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 121 | Payee | Moved |
| 136 | Currency | Moved |

`src/app/(app)/pharmacy/accounts/branch-picker.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 56 | Authorized branch (shared accounts picker) | Moved |

`src/app/(app)/pharmacy/accounts/cash-flow/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 142 | Active branch | Moved |

`src/app/(app)/pharmacy/accounts/cheque-maturity/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 136 | Authorized active branch | Moved |

`src/app/(app)/pharmacy/accounts/journal-evidence-export/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 177 | Journal export branch | Moved |

`src/app/(app)/pharmacy/accounts/profit-loss/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 95 | Branch | Moved |

`src/app/(app)/pharmacy/accounts/tax-profile-review/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 95 | Branch | Moved |
| 214 | Tax profile version (comparison side) | Moved |

`src/app/(app)/pharmacy/finance/ledger-reports.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 581 | Margin grouping | Moved |
| 789 | Profit grouping | Moved |

`src/app/(app)/pharmacy/finance/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 415 | Branch | Moved |
| 471 | Tender type | Moved |
| 536 | Workflow | Moved |
| 593 | Pay from / receive into | Moved |
| 766 | Bank or wallet statement line | Moved |
| 778 | POS settlement batch | Moved |
| 838 | Unmatched bank line | Moved |
| 850 | Posted transaction | Moved |
| 919 | Price mode | Moved |

`src/app/(app)/pharmacy/inventory/expiry/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 278 | Branch | Moved |
| 288 | Expiring within | Moved |

`src/app/(app)/pharmacy/inventory/labels/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 151 | Posted goods receipt | Moved |
| 196 | Branch | Moved |

`src/app/(app)/pharmacy/inventory/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 620 | Branch | Moved |
| 828 | Storage type | Moved |
| 866 | Validated zone | Moved |
| 931 | Lot and location | Moved |
| 1152 | Lot | Moved |
| 1170 | Co-authorizing witness | Moved |
| 1230 | Manually held stock | Moved |
| 1270 | Stock | Moved |
| 1284 | Destination branch and location | Moved |
| 1378 | Manufacturing batch | Moved |

`src/app/(app)/pharmacy/inventory/transfers/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 302 | Branch | Moved |

`src/app/(app)/pharmacy/khata/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 194 | Branch | Moved |

`src/app/(app)/pharmacy/loyalty/adjust-points-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 41 | Adjustment | Moved |

`src/app/(app)/pharmacy/loyalty/customer-search.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 52 | Branch | Moved |

`src/app/(app)/pharmacy/loyalty/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 410 | Reminder language | Moved |

`src/app/(app)/pharmacy/loyalty/prepaid/forms.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 188 | Customer | Moved |
| 205 | Branch | Moved |
| 222 | Open cash drawer | Moved |
| 254 | Movement | Moved |
| 387 | Customer | Moved |

`src/app/(app)/pharmacy/marketing/growth-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 377 | Decision | Moved |
| 397 | Reviewed template | Moved |

`src/app/(app)/pharmacy/marketing/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 170 | Branch | Moved |
| 302 | Sandbox outcome | Moved |
| 500 | Occasion | Moved |
| 533 | Approved template | Moved |
| 544 | Retail rule | Moved |

`src/app/(app)/pharmacy/marketing/profile-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 121 | Star rating | Moved |
| 131 | Tone | Moved |

`src/app/(app)/pharmacy/marketing/voucher-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 191 | Approver | Moved |

`src/app/(app)/pharmacy/purchasing/_components/branch-scope.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 61 | Branch | Moved |

`src/app/(app)/pharmacy/purchasing/_components/form-controls.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 175 | Purchasing native named field (shared label/options) | Kept — Unbounded medicine, pack and supplier lists retain the native phone picker. Purchasing OCR, label-based validation and imperative focus remain native; remove when a shared searchable picker preserves those integrations and mobile interaction. |

`src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 614 | Expiry precision | Moved |
| 676 | Receive into (optional) | Moved |

`src/app/(app)/pharmacy/purchasing/receiving/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 918 | Purchase order | Moved |

`src/app/(app)/pharmacy/reports/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 560 | Reports branch | Moved |
| 577 | Reports supplier | Moved |

`src/app/(app)/pharmacy/reports/repeat-purchasing/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 97 | Selected authorized branches | Moved |

`src/app/(app)/pharmacy/reports/replenishment/scenario-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 445 | Branch | Moved |
| 615 | Forecast method | Moved |

`src/app/(app)/pharmacy/reports/replenishment/seasonal-calendar-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 169 | Season | Moved |

`src/app/(app)/pharmacy/reports/supplier-credit-follow-up/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 336 | Branch | Moved |

`src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 492 | Priority filter | Moved |
| 510 | Assignee filter | Moved |
| 530 | Label filter | Moved |

`src/app/(app)/projects/[id]/project-detail-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 271 | Status | Moved |

`src/app/(app)/projects/import/trello-import-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 268 | Existing import destination project | Moved |
| 453 | Trello member to workspace user mapping | Moved |

`src/app/(app)/projects/projects-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 213 | Sort projects | Moved |
| 422 | Status | Moved |
| 438 | Client | Moved |

`src/app/(app)/restaurant/inventory/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 559 | Stock item | Moved |
| 570 | Location | Moved |
| 581 | Reason | Moved |
| 614 | Stock item | Moved |
| 625 | Location | Moved |
| 680 | Location | Moved |
| 800 | Stock item | Moved |
| 978 | From | Moved |
| 994 | To | Moved |
| 1035 | Stock item | Moved |

`src/app/(app)/restaurant/notifications/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 454 | Delivery state | Moved |
| 904 | Branch | Moved |

`src/app/(app)/restaurant/purchasing/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 686 | Supplier | Moved |
| 697 | Branch | Moved |
| 705 | Location | Moved |
| 716 | Stock item | Moved |

`src/app/(app)/restaurant/purchasing/receiving-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 210 | Receipt discrepancy kind | Moved |

`src/app/(app)/restaurant/reports/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 368 | Branch | Moved |
| 380 | Stock location | Moved |

`src/app/(app)/restaurant/sop/admin/sop-admin.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 995 | Assign to | Moved |
| 1018 | Job role | Moved |
| 1046 | Frequency | Moved |
| 1079 | Interval unit | Moved |

`src/app/(app)/restaurant/sop/oversight/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 457 | Scope | Moved |
| 674 | Channel | Moved |
| 916 | Recent occurrence | Moved |

`src/app/(app)/restaurant/sop/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 320 | Active staff (SOP actor / approver) | Moved |
| 442 | Branch | Moved |
| 871 | Approving credential type | Moved |

`src/app/(app)/restaurant/sop/reports/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 141 | Branch | Moved |
| 159 | Department | Moved |

`src/app/(app)/reviews/reviews-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 386 | Subject | Moved |
| 401 | Reviewer | Moved |

`src/app/(app)/settings/settings-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1645 | Token acts as | Moved |

`src/app/(app)/team/[id]/member-detail-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 757 | Department | Moved |
| 798 | Status | Moved |

`src/app/(app)/team/team-content.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 651 | Department | Moved |
| 730 | Staff role template | Moved |

`src/app/(public)/my-pharmacy/portal-home.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 370 | Account | Moved |

`src/app/login/register/request-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 104 | Registration choice field (vertical-specific name/label) | Moved |

`src/app/platform/(console)/audit/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 260 | Outcome | Moved |

`src/app/platform/(console)/health/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 75 | Vertical | Moved |
| 89 | Organization | Moved |

`src/app/platform/(console)/organizations/page.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 89 | Vertical | Moved |
| 106 | Lifecycle status | Moved |

`src/components/chat/sidebar/create-channel-dialog.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 135 | Type | Moved |

`src/components/hotel/extras-catalog.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 485 | Posting department | Moved |
| 524 | How often it is charged | Moved |

`src/components/hotel/function-spaces-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1103 | Claim | Moved |

`src/components/hotel/inventory-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 671 | Sold as | Moved |
| 854 | Room type | Moved |
| 886 | Connecting room | Moved |
| 908 | Dorm policy | Moved |
| 1329 | Change | Moved |
| 1352 | New status | Moved |
| 1456 | Why it is withheld | Moved |

`src/components/hotel/journey-templates-editor.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 718 | Journey moment / channel / language (mapped field) | Moved |

`src/components/hotel/meal-plans-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 751 | Basis | Moved |

`src/components/pharmacy/branch-assignments.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 60 | Branch | Moved |
| 77 | Member | Moved |

`src/components/pharmacy/cameras/pharmacy-camera-wizard.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 127 | Branch | Moved |
| 196 | Simulator source | Moved |

`src/components/pharmacy/cameras/pharmacy-cameras-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 123 | Preset | Moved |
| 140 | Cold-chain zone | Moved |
| 387 | Branch | Moved |

`src/components/pharmacy/cameras/pharmacy-configured-setup.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 42 | Branch | Moved |

`src/components/pharmacy/catalogue-approval-queue.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 177 | Catalogue item | Moved |

`src/components/pharmacy/counter-computers.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 765 | Branch | Moved |

`src/components/pharmacy/counter/counter-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 3709 | Branch | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-drawer-operator.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 110 | Hand the till to | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-keymap-legend.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 49 | Keymap | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-khata-payment-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 332 | Tender | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-open-drawer-step.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 189 | Who runs this till | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-pack-approval-dialog.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 84 | Approving manager or owner | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-receipt-view.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 410 | Language | Excluded — DEV-977, untouched |
| 423 | Format | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-return-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 590 | Witnessing pharmacist | Excluded — DEV-977, untouched |
| 868 | Sold line | Excluded — DEV-977, untouched |
| 948 | Returned lot / batch | Excluded — DEV-977, untouched |
| 1000 | Keep-aside (quarantine) location | Excluded — DEV-977, untouched |
| 1034 | Refund to | Excluded — DEV-977, untouched |
| 1173 | Original tender | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-rx-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 353 | Prescriber | Excluded — DEV-977, untouched |
| 386 | Medicine | Excluded — DEV-977, untouched |
| 408 | Presentation | Excluded — DEV-977, untouched |
| 439 | Original custody | Excluded — DEV-977, untouched |
| 986 | Prescription line | Excluded — DEV-977, untouched |
| 1006 | Approving pharmacist | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-tender-discard.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 117 | Approving manager or owner | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/counter-tender-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1129 | Family Khata account | Excluded — DEV-977, untouched |
| 1282 | Approving manager or owner | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/day-close-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 247 | Branch | Excluded — DEV-977, untouched |
| 499 | Report language | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/day-end-hour-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 130 | The business day ends at | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/payment-sandbox-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 102 | Action | Excluded — DEV-977, untouched |
| 114 | Simulated terminal | Excluded — DEV-977, untouched |
| 149 | Simulated evidence | Excluded — DEV-977, untouched |
| 161 | Operation | Excluded — DEV-977, untouched |

`src/components/pharmacy/counter/shift-handover-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 29 | Closed drawer | Excluded — DEV-977, untouched |

`src/components/pharmacy/customer-ordering-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 136 | Assigned runner | Moved |
| 357 | Fulfilling branch | Moved |
| 373 | Ordering for customer | Moved |
| 603 | Intended payment method | Moved |

`src/components/pharmacy/customer-portal-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 114 | Branch | Moved |
| 129 | Customer | Moved |

`src/components/pharmacy/delivery-evidence-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 105 | Evidence action | Moved |

`src/components/pharmacy/dispensing/controlled-register-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 162 | Branch | Moved |
| 353 | Entry to correct | Moved |
| 376 | Qualified person | Moved |

`src/components/pharmacy/dispensing/prescriptions-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 326 | Patient | Moved |
| 348 | Prescriber | Moved |
| 372 | Prescription source | Moved |
| 439 | Where is the original prescription? | Moved |
| 487 | Medicine | Moved |
| 514 | Medicine form | Moved |
| 772 | Dispensing branch | Moved |
| 868 | Reminder channel | Moved |

`src/components/pharmacy/dispensing/substitution-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 54 | Prescription line | Moved |

`src/components/pharmacy/dispensing/substitution-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 43 | Supplied presentation | Moved |

`src/components/pharmacy/inventory/expiry-board.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 404 | Mark-down % | Moved |
| 467 | Return supplier | Moved |

`src/components/pharmacy/inventory/shelf-label-print-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 181 | Label size | Moved |

`src/components/pharmacy/inventory/transfers/packing-slip-print-button.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 25 | Packing slip paper for {slip.reference} | Moved |

`src/components/pharmacy/inventory/transfers/transfer-allocate-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 34 | Destination branch and receiving location | Moved |
| 47 | Stock line {index + 1} {index > 0 ? ' (optional)' : ''} | Moved |

`src/components/pharmacy/inventory/transfers/transfer-receive-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 69 | Witness | Moved |

`src/components/pharmacy/medicine-pack-setup.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 158 | Medicine | Moved |
| 184 | Presentation | Moved |
| 204 | Pack type | Moved |

`src/components/pharmacy/medicine-reference-workbench.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 599 | Medicine reference column mapping | Moved |

`src/components/pharmacy/migration-staging-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 151 | Migration source column mapping | Moved |
| 175 | Quantity column counts | Moved |

`src/components/pharmacy/owner-import-wizard.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 104 | Branch | Moved |
| 109 | Stock location | Moved |
| 128 | Owner import column mapping | Moved |

`src/components/pharmacy/printer-settings.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 105 | Receipt printer and paper | Moved |
| 169 | Test language | Moved |
| 253 | Branch | Moved |

`src/components/pharmacy/refill-program-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 182 | Branch | Moved |
| 597 | Customer | Moved |
| 624 | Item and pack | Moved |
| 700 | Hand-over | Moved |
| 712 | Payment | Moved |
| 855 | Signing pharmacist | Moved |

`src/components/pharmacy/regulatory-profile-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 153 | Province this branch operates in | Moved |
| 370 | Which branch is this profile for? | Moved |
| 525 | Province | Moved |
| 632 | Licence category | Moved |
| 836 | Fiscal status | Moved |

`src/components/pharmacy/sop/pharmacy-sop-workspace.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 290 | Branch | Moved |

`src/components/pharmacy/sop/sop-board.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 338 | Procedure | Moved |

`src/components/pharmacy/sop/sop-record-picker.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 214 | SOP step linked record | Moved |

`src/components/pharmacy/sop/sop-setup.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 161 | Branch timezone | Kept — Full IANA timezone list; retain native phone picker and platform type-ahead for the long list until a shared searchable timezone control preserves mobile interaction. |
| 788 | Role | Moved |
| 810 | Person | Moved |
| 830 | How often | Moved |

`src/components/pharmacy/staged-medicine-catalogue.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 182 | Branch | Moved |
| 286 | Review filter | Moved |

`src/components/pharmacy/supplier-price-lists.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 190 | Supplier | Moved |

`src/components/platform/ai-settings-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 462 | Provider | Moved |

`src/components/platform/platform-command-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 442 | Platform command select field (field-defined label) | Moved |

`src/components/platform/support-access-form.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 65 | Access duration | Moved |

`src/components/receipts/receipt-designer.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 130 | Branch | Moved |
| 156 | Paper width | Moved |

`src/components/restaurant/catalog/catalog-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 970 | Modifier group to attach | Moved |
| 1051 | Allergen to attach to product | Moved |
| 1909 | Allergen to attach to ingredient | Moved |
| 2337 | Approved substitute ingredient | Moved |
| 2496 | Parent category | Moved |
| 2542 | Product type | Moved |
| 2550 | Category | Moved |
| 2629 | Component product | Moved |
| 2651 | Variant (optional) | Moved |
| 2815 | From unit | Moved |
| 2833 | To unit | Moved |
| 2887 | Base unit | Moved |
| 2923 | Product | Moved |
| 2943 | Variant | Moved |
| 2969 | Yield unit | Moved |
| 3012 | Source type | Moved |
| 3029 | Ingredient / sub-recipe source | Moved |
| 3063 | Unit | Moved |

`src/components/restaurant/catering/catering-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 156 | Driver | Moved |
| 596 | Filter by status | Moved |
| 881 | Fulfillment | Moved |
| 893 | Stock location | Moved |
| 1153 | Recipe | Moved |
| 1260 | Cost type | Moved |
| 1484 | Customer | Moved |
| 1546 | Saved delivery address | Moved |

`src/components/restaurant/catering/catering-evidence.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 330 | Original consumption | Moved |
| 350 | Disposition | Moved |
| 581 | Receipt kind | Moved |
| 600 | Evidence type | Moved |

`src/components/restaurant/catering/catering-terminal-boundary.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 170 | Terminal operator | Moved |

`src/components/restaurant/delivery/delivery-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 236 | Branch | Moved |
| 268 | Customer | Moved |

`src/components/restaurant/floor/floor-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1073 | Target type | Moved |
| 1112 | Routing product / category | Moved |

`src/components/restaurant/growth/growth-review-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 152 | Review priority | Moved |

`src/components/restaurant/kds/kds-board.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 463 | Acting operator | Moved |

`src/components/restaurant/loyalty/loyalty-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 542 | Filter by tag | Moved |
| 1192 | Assign tag | Moved |
| 1247 | Channel | Moved |
| 1254 | State | Moved |

`src/components/restaurant/menu-import/menu-import-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1270 | Merge into existing product | Moved |
| 1287 | Merge into variant | Moved |

`src/components/restaurant/menus/menus-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 796 | Menu | Moved |
| 1024 | Price list | Moved |
| 1597 | Preview branch menu | Moved |
| 1607 | Preview channel | Moved |
| 1741 | Brand | Moved |
| 1803 | Canonical product | Moved |
| 1820 | Canonical variant | Moved |
| 1879 | Canonical product | Moved |
| 1896 | Canonical variant | Moved |
| 1925 | Branch | Moved |
| 1935 | Menu | Moved |
| 1945 | Publication price list | Moved |
| 1990 | Scope | Moved |
| 2062 | Menu item | Moved |

`src/components/restaurant/money/money-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 625 | Mode | Moved |

`src/components/restaurant/operator-safe-selector.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 73 | Authorized operator (consumer-defined label) | Moved |

`src/components/restaurant/orders/orders-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 275 | Status | Moved |
| 292 | Channel | Moved |
| 307 | Page size | Moved |
| 511 | Wastage disposition | Moved |
| 535 | Approving credential type | Moved |

`src/components/restaurant/pos/checkout-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 197 | Bill item | Moved |

`src/components/restaurant/pos/drawer-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 325 | Movement | Moved |

`src/components/restaurant/pos/operator-switch.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 65 | Operator | Moved |

`src/components/restaurant/pos/order-pad.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 98 | Operator | Moved |
| 263 | Channel | Moved |
| 330 | Saved address | Moved |
| 344 | Delivery zone | Moved |
| 429 | Floor section | Moved |

`src/components/restaurant/pos/order-ticket-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 365 | Current table | Moved |
| 381 | Destination table | Moved |
| 534 | Wastage disposition | Moved |

`src/components/restaurant/pos/refund-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 351 | Settled receipt | Moved |

`src/components/restaurant/pos/split-bill-dialog.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 130 | Split method | Moved |
| 177 | Guest bill per order line | Moved |

`src/components/restaurant/pos/tender-pad.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 155 | Tender type | Moved |

`src/components/restaurant/print-bridge-enrollment.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 154 | Branch | Moved |

`src/components/restaurant/print-routing-section.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 478 | Branch | Moved |
| 567 | Print route station per type | Moved |
| 585 | Print route destination per type | Moved |

`src/components/restaurant/printer-inventory-panel.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 1132 | Print bridge | Moved |

`src/components/restaurant/printer-registration-fields.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 143 | Printer {index + 1} paper width | Moved |

`src/components/restaurant/promotions/promotions-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 404 | Timezone | Moved |
| 434 | Benefit type | Moved |
| 456 | Application basis | Moved |
| 522 | Target type | Moved |
| 533 | Branches | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 549 | Products | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 563 | Variants | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 582 | Categories | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 597 | Channels | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 609 | Offline policy | Moved |
| 650 | Product alternatives | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |
| 670 | Category alternatives | Kept — Native multi-select preserves modifier/range selection, selectedOptions and repeated FormData entries. Retain until the shared multiple-selection interaction has equivalent behavior. |

`src/components/restaurant/restaurant-branch-select.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 54 | Active restaurant branch | Kept — Demo floor and daily-close preparation requires a visible native Branch select, its options and native value setter. Retain until that consumer supports shared Select without changing tour behavior. |

`src/components/restaurant/restaurant-camera-wizard.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 133 | Branch | Moved |
| 209 | Watches | Moved |

`src/components/restaurant/restaurant-device-select.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 48 | Restaurant device | Moved |

`src/components/restaurant/restaurant-devices-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 443 | Device kind | Moved |
| 527 | KDS station | Moved |
| 651 | Approving staff | Moved |
| 669 | Approving credential type | Moved |

`src/components/restaurant/restaurant-roster-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 544 | Replacement employee | Moved |
| 885 | Operator | Moved |
| 979 | Timestamp | Moved |

`src/components/restaurant/restaurant-staff-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 319 | Status | Moved |
| 398 | Staff member status | Moved |
| 535 | Organization user | Moved |
| 621 | Status | Moved |
| 682 | Credential type | Moved |

`src/components/restaurant/restaurant-staff-invite-dialog.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 157 | Role | Moved |

`src/components/restaurant/restaurant-staff-select.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 52 | Restaurant staff | Moved |

`src/components/restaurant/restaurant-tax-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 190 | Preset branch | Moved |
| 203 | Jurisdiction and profile | Moved |
| 347 | Branch | Moved |
| 360 | Pakistan jurisdiction | Moved |
| 373 | Price mode | Moved |

`src/components/terminal/terminal-console.tsx`

| Baseline line | Purpose | Disposition / reason |
| ---: | --- | --- |
| 740 | Operator | Moved |
| 859 | Incoming operator | Moved |
| 949 | Approving manager | Moved |

Native test fixtures (not application controls; unchanged):

| File / baseline line | Purpose | Disposition / reason |
| --- | --- | --- |
| `src/app/(app)/pharmacy/purchasing/_components/action-form.test.tsx:216` | Sibling supplier | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/invoice-capture-reader.test.tsx:95` | Line {slot + 1} | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/invoice-capture-reader.test.tsx:106` | {`${field}:d${slot}`} | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/invoice-capture-reader.test.tsx:130` | Supplier | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.test.tsx:60` | expiryPrecision:pol-1 | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/pack-photo-reader.test.tsx:70` | stockLocation:pol-1 | Kept — Test fixture for native browser behavior; not product UI. |
| `src/app/(app)/pharmacy/purchasing/_components/progressive-lines.test.tsx:9` | Medicine {index + 1} | Kept — Test fixture for native browser behavior; not product UI. |
