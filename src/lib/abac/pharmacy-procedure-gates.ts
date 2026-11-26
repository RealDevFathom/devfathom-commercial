/**
 * DEV-959A — every pharmacy procedure, the gate it sits behind, and the sub-role
 * description lines (`subRoleKey/lineId`) that say what it lets a person do, or why no
 * sub-role grants it. Checked against the live routers by pharmacy-procedure-gates.test.ts.
 * Data only: nothing here grants or checks anything.
 *
 * DEV-961: an "approval code" below is what the shared approval path
 * (`verifyApprovalSecret`) accepts, following the owner's one setting, "Authenticator for
 * approvals": while it is on (the default), the approver's current authenticator code (a staff
 * profile with no web login keeps its PIN); while the owner has it off, everyone's permanent
 * PIN, and no app code. A person who holds no approver right and confirms their own action
 * with their own PIN (a cashier redeeming a voucher) keeps that PIN in both modes. Entries
 * about setting or viewing one's own PIN are about the PIN itself.
 */
export type PharmacyProcedureGate =
  { gate: string; lines: readonly string[] } | { gate: string; none: string };

const accountsGate =
  'adminProcedure (admin:access) + ADMIN role, Pharmacy Finance module, finance:read (a live grant or the system Owner, subject to deny) and an active branch of the organization';
const bookkeepingGate =
  'bookkeepingProcedure: admin:access + Pharmacy Finance module + finance:read (a live grant or the system Owner, subject to deny) + active branch';

export const PHARMACY_PROCEDURE_GATES: Readonly<Record<string, PharmacyProcedureGate>> = {
  'organizationAdmin.roleAccess': {
    gate: 'adminProcedure in a pharmacy, reads role grants in the current workspace',
    none: 'workspace administration only',
  },
  'organizationAdmin.setRoleSubRole': {
    gate: 'adminProcedure in a pharmacy, active owner editing another role, no support session, fresh owner PIN for weighty changes, with every holder checked under the organization lock',
    none: 'owner administration only',
  },
  'pharmacyAccess.navigation': {
    gate: "protectedProcedure; reads the caller's own decisions for the menu",
    none: 'menu only: any signed-in member, about themselves',
  },
  'pharmacyApInvoices.aging': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.approveCreditSetOff': {
    gate: `${accountsGate} + finance:manage + actorMayRefund -> pharmacy:manage + own approval code; a different approver unless no other active ADMIN exists in the organization`,
    lines: [
      'read-finance-accounts/view-accounts',
      'manage-finance-accounts/manage-transactions',
      'run-branches/workspace-administrator-finance-access',
    ],
  },
  'pharmacyApInvoices.creditSetOffs': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.list': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.pay': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyApInvoices.payablesDrafts': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.record': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyApInvoices.rejectCreditSetOff': {
    gate: `${accountsGate} + finance:manage + actorMayRefund -> pharmacy:manage`,
    lines: [
      'read-finance-accounts/view-accounts',
      'manage-finance-accounts/manage-transactions',
      'run-branches/reject-undo-credit-set-offs',
    ],
  },
  'pharmacyApInvoices.requestCreditSetOff': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyApInvoices.reversalAccess': {
    gate: `${accountsGate}; reports whether actorMayRefund (pharmacy:manage) but does not require it`,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.reverseCreditSetOff': {
    gate: `${accountsGate} + finance:manage + actorMayRefund -> pharmacy:manage + own approval code`,
    lines: [
      'read-finance-accounts/view-accounts',
      'manage-finance-accounts/manage-transactions',
      'run-branches/reject-undo-credit-set-offs',
    ],
  },
  'pharmacyApInvoices.reversalSearch': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyApInvoices.reverseInvoice': {
    gate: `${accountsGate} + finance:manage + authorizeReversal -> pharmacy:manage + own approval code (own entry refused while another approver exists)`,
    lines: [
      'read-finance-accounts/view-accounts',
      'manage-finance-accounts/manage-transactions',
      'run-branches/workspace-administrator-finance-access',
    ],
  },
  'pharmacyApInvoices.reverseSettlement': {
    gate: `${accountsGate} + finance:manage + authorizeReversal -> pharmacy:manage + own approval code (own entry refused while another approver exists)`,
    lines: [
      'read-finance-accounts/view-accounts',
      'manage-finance-accounts/manage-transactions',
      'run-branches/workspace-administrator-finance-access',
    ],
  },
  'pharmacyBranchAssignments.assign': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyBranchAssignments.list': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyBranchAssignments.otherBranchAvailability': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyBranchAssignments.setOtherBranchAvailability': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyBranchAssignments.unassign': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.capturePending': {
    gate: 'cameraProcedure = adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.configure': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.configuredConnectionDiagnostics': {
    gate: 'liveProcedure = adminProcedure + pharmacy-core + pharmacy vertical, no support session',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.enrollGateway': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.evidence': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.issueLiveViewGrant': {
    gate: 'liveProcedure = adminProcedure + pharmacy vertical, no support session',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.issueViewerGrant': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.register': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.revokeViewerGrant': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.setRetention': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.testConnection': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCameras.workspace': {
    gate: 'adminProcedure (admin:access) + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyCardTerminal.attempt': {
    gate: 'protectedProcedure + requireCounterReceiptAccess(canonical pharmacy:counter + counter-family ALLOW + branch assignment/org admin)',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacyCardTerminal.availability': {
    gate: 'protectedProcedure + requireCounterReceiptAccess(canonical pharmacy:counter)',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacyCardTerminal.charge': {
    gate: 'protectedProcedure + requireCounterReceiptAccess(canonical pharmacy:counter)',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacyCardTerminal.checkStatus': {
    gate: 'protectedProcedure + requireCounterReceiptAccess(canonical pharmacy:counter)',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacyCardTerminal.providerRefunds': {
    gate: 'protectedProcedure + requireCounterReceiptAccess + pharmacy:manage + finance:read',
    lines: ['take-payment/settle-card-reviews', 'run-branches/settle-cardmachine-payments-under'],
  },
  'pharmacyCardTerminal.reviewHistory': {
    gate: 'protectedProcedure + requireCounterReceiptAccess + pharmacy:manage + finance:read',
    lines: ['take-payment/settle-card-reviews', 'run-branches/settle-cardmachine-payments-under'],
  },
  'pharmacyCardTerminal.recordRefundAction': {
    gate: 'pharmacyRefundPostingMutation (admin:access + finance:manage + finance:read) + requireCounterReceiptAccess + pharmacy:manage + fresh approval code, second-person approval and role comparison for corrections',
    lines: [
      'manage-finance-accounts/manage-transactions',
      'take-payment/settle-card-reviews',
      'run-branches/settle-cardmachine-payments-under',
    ],
  },
  'organizationAdmin.pharmacySettings.refundMapping': {
    gate: 'protectedProcedure + pharmacy-core + pharmacy-finance + finance:read for a live owner or explicitly granted reader',
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyCardTerminal.resolveReview': {
    gate: 'protectedProcedure + pharmacyRefundPostingMutation only for posting outcomes (admin:access + finance:manage + finance:read) + requireCounterReceiptAccess(pharmacy:counter) AND actorMayRefund (pharmacy:manage) + own fresh approval code; not own charge unless no other reviewer',
    lines: [
      'manage-finance-accounts/manage-transactions',
      'take-payment/settle-card-reviews',
      'run-branches/settle-cardmachine-payments-under',
    ],
  },
  'pharmacyDispensing.counterSignStatus': {
    gate: "capabilityProcedure('pharmacy:dispense') + branch assignment (else empty)",
    lines: ['dispense-prescriptions/sign-own-line-alone'],
  },
  'pharmacyDispensing.decideReview': {
    gate: "capabilityProcedure('pharmacy:dispense') + rxReviewSignerDenial (active, assigned to the sale's branch or org ADMIN)",
    lines: ['dispense-prescriptions/check-query-refuse-sign'],
  },
  'pharmacyDispensing.enqueueReview': {
    gate: "capabilityProcedure('pharmacy:dispense') + sale-line branch check",
    lines: ['dispense-prescriptions/ring-up-sale-line'],
  },
  'pharmacyDispensing.recordSubstitution': {
    gate: "capabilityProcedure('pharmacy:dispense') + sale-line branch check",
    lines: ['dispense-prescriptions/check-query-refuse-sign'],
  },
  'pharmacyDispensing.returnVerificationQueue': {
    gate: "capabilityProcedure('pharmacy:dispense') + branch assignment (or session ADMIN)",
    lines: ['dispense-prescriptions/see-returns-awaiting-verification'],
  },
  'pharmacyDispensing.reviewQueue': {
    gate: "capabilityProcedure('pharmacy:dispense')",
    lines: ['dispense-prescriptions/check-query-refuse-sign'],
  },
  'pharmacyDispensing.selfSignReview': {
    gate: "capabilityProcedure('pharmacy:dispense') + solo rule (assertRxSelfSignAllowed) + own fresh approval code",
    lines: ['dispense-prescriptions/sign-own-line-alone'],
  },
  'pharmacyDispensing.substitutionWorkspace': {
    gate: 'auditedProtectedProcedure + pharmacy:dispense OR pharmacy:safety; patient names only with pharmacy:prescriptions',
    lines: [
      'dispense-prescriptions/open-substitution-workspace',
      'controlled-medicines/open-substitution-workspace-review',
      'record-prescriptions/see-patient-names-substitution',
    ],
  },
  'pharmacyFinance.cashFlowForecast': {
    gate: 'ledgerReportProcedure: admin:access + ADMIN role + reports module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.closePeriod': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.createSettlementBatch': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.deliveryRadiusProfitability': {
    gate: 'ledgerReportProcedure: admin:access + reports:operational AND reports:financial',
    lines: [
      'financial-reports/delivery-distance-profitability',
      'operational-reports/delivery-distance-profitability',
    ],
  },
  'pharmacyFinance.financialStatements': {
    gate: 'ledgerReportProcedure: admin:access + ADMIN role + Pharmacy Reports module + reports:operational AND reports:financial + finance:read (a live grant or the system Owner, subject to deny), within an active branch',
    lines: [
      'read-finance-accounts/view-accounts',
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.grossMargin': {
    gate: 'ledgerReportProcedure: admin:access + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.importBankLine': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.leakageReport': {
    gate: 'ledgerReportProcedure: admin:access + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.marginComparison': {
    gate: 'adminProcedure + inline ADMIN role, reports module, can(reports:operational) AND can(reports:financial)',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.perpetualValuation': {
    gate: 'ledgerReportProcedure: admin:access + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.post': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.publishTaxProfile': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.reconcile': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.reopenPeriod': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.reverse': {
    gate: `${bookkeepingGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyFinance.trueProfit': {
    gate: 'ledgerReportProcedure: admin:access + reports:operational AND reports:financial (margin by item/category/hour/staff)',
    lines: [
      'financial-reports/workspace-administrator-use-operational-2',
      'operational-reports/workspace-administrator-use-financial',
    ],
  },
  'pharmacyFinance.workspace': {
    gate: bookkeepingGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyGeneralJournal.cancelDraft': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyGeneralJournal.catalog': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyGeneralJournal.createDraft': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyGeneralJournal.get': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyGeneralJournal.list': {
    gate: accountsGate,
    lines: ['read-finance-accounts/view-accounts'],
  },
  'pharmacyGeneralJournal.post': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyGeneralJournal.reverse': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyGeneralJournal.updateDraft': {
    gate: `${accountsGate} + finance:manage`,
    lines: ['read-finance-accounts/view-accounts', 'manage-finance-accounts/manage-transactions'],
  },
  'pharmacyInventory.acknowledgeRecall': {
    gate: 'regulatory -> pharmacy:safety (any active branch of the tenant, no assignment needed)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.acknowledgeSignal': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch; workspace admin with pharmacy:inventory at any branch, logged)',
    lines: ['manage-stock/work-stock-alerts', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.allocateForSale': {
    gate: "inventoryControl -> pharmacy:inventory (assigned branch / admin exception); FEFO override needs the pharmacist on duty or an approver's approval code",
    lines: [
      'manage-stock/allocate-stock-for-sale',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.allocateRequestedTransfer': {
    gate: "inventoryControl -> pharmacy:inventory (assigned branch / admin exception); owner's transfer switch must be on, no controlled drugs",
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.allocateTransfer': {
    gate: "inventoryControl -> pharmacy:inventory (assigned branch / admin exception); owner's transfer switch must be on, no controlled drugs",
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.approveCount': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); approving own count only as a solo owner with fresh approval code (actorIsPharmacyOwner + no other staff)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/solo-owner-approve-own',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.approveSafetyStock': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/set-safety-stock', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.approveTransfer': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); own allocation only as a solo owner with fresh approval code',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/solo-owner-approve-own',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.branchTransferSettings': {
    gate: 'inventoryControl -> pharmacy:inventory (tenant-wide read: is the switch on, may caller change it)',
    lines: ['manage-stock/run-stock-branches-locations'],
  },
  'pharmacyInventory.breakPack': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/move-stock-break-packs',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.closeRecall': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.coldChainSensors': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/temperature-sensors', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.configureTemperatureMonitoring': {
    gate: "inventoryControl -> pharmacy:inventory (assigned branch / admin exception); sets a zone's expected reading interval and excursion duration",
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.confirmDrapPrice': {
    gate: 'regulatory -> pharmacy:safety, but confirmPriceChanges always throws (DRAP price notices are information only)',
    none: 'always refused for everyone: DRAP price notices never change a price',
  },
  'pharmacyInventory.confirmDrapRecall': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.createCount': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.createDraftAction': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); DRAFT_TRANSFER needs pharmacy:inventory, DRAFT_REQUISITION and DRAFT_CLAIM additionally need pharmacy:procurement (checked in createDraftAction)',
    lines: [
      'manage-stock/turn-stock-alert-into',
      'receive-stock/manage-stock-turn-stock',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.createLocation': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.createRecall': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.dailyCycleCountList': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.dismissDrapRecall': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.dismissSignal': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/work-stock-alerts', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.dispatchTransfer': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); premises/controlled-drug rules re-checked',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.draftExpiryMarkdown': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.draftExpiryReturn': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); drafts an EXPIRY_CLAIM supplier return',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.draftExpiryReturnClaim': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); drafts one EXPIRY_CLAIM supplier return for many positions',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.drapRecallActions': {
    gate: "regulatory -> pharmacy:safety; patient phones unmasked only with inline can('pharmacy:prescriptions')",
    lines: [
      'controlled-medicines/manage-recalls-whole-pharmacy',
      'record-prescriptions/controlled-medicines-safety-see',
    ],
  },
  'pharmacyInventory.drapRecallQueue': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.enrollColdChainSensor': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); returns the push secret once',
    lines: ['manage-stock/temperature-sensors', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.expiryBoardLots': {
    gate: "auditedProtectedProcedure + admittedScopeFor: any signed-in member assigned to the branch (workspace admin with pharmacy:inventory at any branch); cost and PKR value at risk only with inline can('reports:financial')",
    lines: [
      'financial-reports/see-stock-cost-value',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.importTemperatureCsv': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.ingestDrapFile': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy); file may hold PRICE and RECALL notices',
    lines: [
      'controlled-medicines/upload-official-price-notices',
      'controlled-medicines/manage-recalls-whole-pharmacy',
    ],
  },
  'pharmacyInventory.ingestDrapManual': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy); PRICE and RECALL notices',
    lines: [
      'controlled-medicines/upload-official-price-notices',
      'controlled-medicines/manage-recalls-whole-pharmacy',
    ],
  },
  'pharmacyInventory.markStaleSignals': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/work-stock-alerts', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.nearExpiryBoard': {
    gate: 'auditedProtectedProcedure + admittedScopeFor: any signed-in member assigned to the branch; workspace admin with pharmacy:inventory at any branch; value at risk only with reports:financial (null otherwise)',
    lines: [
      'manage-stock/workspace-administrator-reach-stock',
      'financial-reports/see-stock-cost-value',
    ],
  },
  'pharmacyInventory.onHand': {
    gate: 'auditedProtectedProcedure + admittedScopeFor: any signed-in member assigned to the branch; workspace admin with pharmacy:inventory at any branch',
    lines: ['manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.quarantineExpiring': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/quarantine-expiring-stock',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.quarantinePart': {
    gate: 'regulatory -> pharmacy:safety (any active branch of tenant, tenant-only scopeFor)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.recallTrace': {
    gate: 'regulatory = capabilityProcedure(pharmacy:safety); rows limited to active branch assignments, every branch for a verified tenant ADMIN with pharmacy:inventory',
    lines: ['controlled-medicines/trace-recall-their-branches'],
  },
  'pharmacyInventory.receiveLot': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/receive-stock-without-order',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.receiveTransferLine': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.receiveTransferWithVariance': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); shortfall needs a witness approval code',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.recordTemperature': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.recordUnrecordedBatch': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.refreshStockSignals': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/work-stock-alerts', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.registerBatch': {
    gate: 'inventoryControl -> pharmacy:inventory (tenant-wide, no branch scope)',
    lines: ['manage-stock/run-stock-branches-locations'],
  },
  'pharmacyInventory.releaseQuarantinedPart': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.reserveSupplierClaim': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.reverseDrapRecall': {
    gate: 'regulatory -> pharmacy:safety (whole pharmacy)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.revokeColdChainSensor': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/temperature-sensors', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.rotateColdChainSensorSecret': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/temperature-sensors', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.setBatchState': {
    gate: 'regulatory -> pharmacy:safety (organization-wide)',
    lines: ['controlled-medicines/manage-recalls-whole-pharmacy'],
  },
  'pharmacyInventory.setBranchTransfersEnabled': {
    gate: "inventoryControl -> pharmacy:inventory AND owner (hasAllCapabilityAccess: system owner role, or ADMIN with '*' ALLOW, no DENY)",
    lines: ['manage-stock/owner-switch-branch-transfers'],
  },
  'pharmacyInventory.shelfLabels': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.snoozeSignal': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: ['manage-stock/work-stock-alerts', 'manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.stockSignalDashboard': {
    gate: 'auditedProtectedProcedure + admittedScopeFor: any signed-in member assigned to the branch; workspace admin with pharmacy:inventory at any branch',
    lines: ['manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.stockSignalDigest': {
    gate: "auditedProtectedProcedure + admittedScopeFor: a member assigned to the branch (workspace admin with pharmacy:inventory at any branch); only their own digest unless admin:access for another person's",
    lines: ['manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.temperatureZoneStatuses': {
    gate: 'auditedProtectedProcedure + admittedScopeFor: any signed-in member assigned to the branch; workspace admin with pharmacy:inventory at any branch',
    lines: ['manage-stock/workspace-administrator-reach-stock'],
  },
  'pharmacyInventory.transfer': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); moves a lot between two locations in one branch',
    lines: [
      'manage-stock/move-stock-break-packs',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.transferBoard': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInventory.writeOff': {
    gate: 'inventoryControl -> pharmacy:inventory (assigned branch / admin exception); witness approval code required (solo self-witness only under soloSelfWitnessPolicy)',
    lines: [
      'manage-stock/run-stock-branches-locations',
      'manage-stock/workspace-administrator-reach-stock',
    ],
  },
  'pharmacyInvoiceCapture.read': {
    gate: 'auditedProtectedProcedure + inline actorCanProcure -> pharmacy:procurement; active branch',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyJournalEntryLookup.lookup': {
    gate: 'adminProcedure + ADMIN role + Pharmacy Reports module + reports:operational AND reports:financial + finance:read (a live grant or the system Owner, subject to deny), within an active branch',
    lines: [
      'financial-reports/workspace-administrator-use-operational-3',
      'operational-reports/workspace-administrator-use-financial-2',
    ],
  },
  'pharmacyKhata.branches': {
    gate: 'adminProcedure (admin:access) + pharmacy-counter module',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyKhata.ledger': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyKhata.sendReminder': {
    gate: 'adminProcedure (admin:access) + pharmacy-crm module',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.adjustPoints': {
    gate: "requireAdjustAccess -> owner (session ADMIN + admin:access) or requireDrawerManagerAccess (pharmacy:manage, assigned branch) with own approval code and within the owner's manager limit",
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacyLoyalty.branches': {
    gate: 'adminProcedure (admin:access) + pharmacy-crm',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.card': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.customers': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.earnRate': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.history': {
    gate: 'requireHistoryAccess -> owner, or requireDrawerManagerAccess (pharmacy:manage) with history limited to assigned branches',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacyLoyalty.issueCard': {
    gate: 'requireAdjustAccess -> owner or requireDrawerManagerAccess (pharmacy:manage)',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacyLoyalty.liability': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.redemptions': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.revokeCard': {
    gate: 'requireAdjustAccess -> owner or requireDrawerManagerAccess (pharmacy:manage)',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacyLoyalty.setEarnRate': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyLoyalty.setMembership': {
    gate: 'enrol (active=true) -> owner or requireDrawerManagerAccess (pharmacy:manage); deactivate -> owner only',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacyLoyalty.setReminderLanguage': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMarketing.approve': {
    gate: 'protectedProcedure + owner() (admin:access through can(), deny-wins) + pharmacy-crm module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.approveTemplate': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.assist': {
    gate: 'owner() admin:access + CRM module (+ Ask Fathom setting)',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.attributeReceipts': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.basketHistory': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.branches': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.capture': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.createDraft': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.deliveryHistory': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.generateBaskets': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.generateGrowth': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial (+ Ask Fathom on)',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.growthHistory': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.history': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.issueVoucher': {
    gate: "owner() admin:access + CRM module; above the value cap a second approver's approval code (DISCOUNT approver) or solo owner's fresh approval code",
    none: "workspace administrators only (admin:access) with the Pharmacy CRM module; the second approver's part is run-branches/be-second-approver-highvalue, not the issuer's",
  },
  'pharmacyMarketing.preview': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.profileHealth': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.resumeSending': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.review': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.reviewBasket': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.reviewGrowth': {
    gate: 'growthExecute: owner() admin:access + live active ADMIN record + CRM module + reports:operational AND reports:financial',
    lines: [
      'financial-reports/workspace-administrator-use-operational-6',
      'operational-reports/workspace-administrator-use-financial-5',
    ],
  },
  'pharmacyMarketing.reviewReply': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.revokeVoucher': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.sandbox': {
    gate: 'owner() admin:access + CRM module; sandbox transaction re-checks active ADMIN',
    none: 'workspace administrators only (admin:access and a live active ADMIN record) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.sandboxDue': {
    gate: 'owner() admin:access + CRM module; sandbox transaction re-checks active ADMIN',
    none: 'workspace administrators only (admin:access and a live active ADMIN record) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.sendPolicy': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.updateSendPolicy': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.voucherApprovers': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMarketing.vouchers': {
    gate: 'owner() admin:access + CRM module',
    none: 'workspace administrators only (admin:access) with the Pharmacy CRM module',
  },
  'pharmacyMedicine.addAlias': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.addBarcode': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.addMedicineDraft': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit',
    lines: ['suggest-catalogue-edits/only-workspace-administrator-add'],
  },
  'pharmacyMedicine.catalogueEdits': {
    gate: 'auditedProtectedProcedure + inline catalogueAccess: pharmacy:catalogue-review OR (admin:access AND pharmacy:catalogue-edit)',
    lines: [
      'review-catalogue/approve-reject-others-catalogue',
      'suggest-catalogue-edits/only-workspace-administrator-add',
    ],
  },
  'pharmacyMedicine.catalogueQueueAccess': {
    gate: "auditedProtectedProcedure; returns only the caller's own flags",
    none: 'any signed-in member (UI flags only)',
  },
  'pharmacyMedicine.catalogueSelfApproval': {
    gate: "auditedProtectedProcedure + inline catalogueAccess, as decideCatalogueEdit: pharmacy:catalogue-review, OR owner fallback (admin:access AND pharmacy:catalogue-edit, live owner, no other active reviewer); caller's own organization only; names of this organization's active members who can approve the caller's edits",
    lines: [
      'review-catalogue/approve-reject-others-catalogue',
      'suggest-catalogue-edits/owner-approve-no-reviewer',
    ],
  },
  'pharmacyMedicine.configureReferenceConnector': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.confirmPrices': {
    gate: "capabilityProcedure('pharmacy:safety'), but confirmPriceChanges always throws",
    none: 'always refused for everyone: DRAP price notices never change a price',
  },
  'pharmacyMedicine.createIngredient': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.createMedicine': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit; always saleable:false',
    lines: ['suggest-catalogue-edits/only-workspace-administrator-add'],
  },
  'pharmacyMedicine.createPackLevel': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.createStagedMedicines': {
    gate: 'contextualCapabilityProcedure(catalogueCommandAuthority) -> admin:access AND pharmacy:catalogue-edit to request; reorder levels kept only if requester also holds pharmacy:inventory at that branch (maySetStockThresholds); approval replay under pharmacy:catalogue-review (or owner fallback) requires an admitted active branch and admission to the requested reorder branch, if any',
    lines: [
      'suggest-catalogue-edits/request-create-imported-medicines',
      'manage-stock/set-reorder-levels-when',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.decideCatalogueEdit': {
    gate: 'auditedProtectedProcedure + inline catalogueAccess: pharmacy:catalogue-review, OR owner fallback (admin:access AND pharmacy:catalogue-edit, live owner, no other active reviewer, fresh approval code); staged import decisions also require the same branch admission as proposedImport',
    lines: [
      'review-catalogue/approve-reject-others-catalogue',
      'suggest-catalogue-edits/owner-approve-no-reviewer',
    ],
  },
  'pharmacyMedicine.decideReferenceConnectorProposal': {
    gate: "capabilityProcedure('pharmacy:catalogue-review'); independent reviewer or solo approval code",
    lines: ['review-catalogue/confirm-reject-imported-referencedata'],
  },
  'pharmacyMedicine.deriveLooseUnitPrice': {
    gate: 'auditedProtectedProcedure',
    none: 'any signed-in member',
  },
  'pharmacyMedicine.dismissDrapPriceAlert': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/upload-official-price-notices'],
  },
  'pharmacyMedicine.drapPriceAlerts': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/view-official-price-notices'],
  },
  'pharmacyMedicine.drapReferenceSearch': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit (pre-fills the add-medicine form)',
    lines: ['suggest-catalogue-edits/only-workspace-administrator-add'],
  },
  'pharmacyMedicine.duplicateGroups': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.get': {
    gate: "auditedProtectedProcedure: any signed-in member; purchase price shown only with inline can('pharmacy:manage')",
    lines: ['run-branches/see-purchase-price-paid'],
  },
  'pharmacyMedicine.ingestPriceNotices': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/upload-official-price-notices'],
  },
  'pharmacyMedicine.priceNotices': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/view-official-price-notices'],
  },
  'pharmacyMedicine.priceOverrides': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.proposedImport': {
    gate: "capabilityProcedure('pharmacy:catalogue-review'); pending import in the caller's workspace, an admitted active branch, and the proposed file checksum; only its approver can reopen the approved file for creation",
    lines: ['review-catalogue/approve-reject-others-catalogue'],
  },
  'pharmacyMedicine.proposeCatalogueEdit': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit',
    lines: ['suggest-catalogue-edits/only-workspace-administrator-add'],
  },
  'pharmacyMedicine.publishAssertions': {
    gate: 'reviewerProcedure: pharmacy:catalogue-review, OR owner fallback (admin:access AND pharmacy:catalogue-edit, owner, no other reviewer)',
    lines: [
      'review-catalogue/approve-reject-others-catalogue',
      'suggest-catalogue-edits/owner-approve-no-reviewer',
    ],
  },
  'pharmacyMedicine.recordPrintedMrp': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.recordReviewDecision': {
    gate: "reviewerProcedure: pharmacy:catalogue-review, OR owner fallback (admin:access AND pharmacy:catalogue-edit, owner, no other reviewer, fresh approval code); reviewer must differ from each assertion's editor",
    lines: [
      'review-catalogue/review-medicine-details',
      'suggest-catalogue-edits/owner-approve-no-reviewer',
    ],
  },
  'pharmacyMedicine.referenceCandidates': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.referenceConnectorProposals': {
    gate: "capabilityProcedure('pharmacy:catalogue-review')",
    lines: ['review-catalogue/confirm-reject-imported-referencedata'],
  },
  'pharmacyMedicine.referenceConnectorState': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.resolveScan': {
    gate: 'auditedProtectedProcedure',
    none: 'any signed-in member',
  },
  'pharmacyMedicine.revisePackLevel': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.runReferenceConnectorNow': {
    gate: 'adminProcedure -> admin:access',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyMedicine.runStagedMedicineCreation': {
    gate: 'auditedProtectedProcedure + inline catalogueAccess: pharmacy:catalogue-review OR (admin:access AND pharmacy:catalogue-edit); needs an APPROVED request',
    lines: [
      'review-catalogue/create-approved-imported-medicines',
      'suggest-catalogue-edits/request-create-imported-medicines',
    ],
  },
  'pharmacyMedicine.search': { gate: 'auditedProtectedProcedure', none: 'any signed-in member' },
  'pharmacyMedicine.setPackBarcode': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.setPackPrice': {
    gate: 'catalogueCommandProcedure -> admin:access AND pharmacy:catalogue-edit to submit (queued); applied on approval replay under pharmacy:catalogue-review (or owner fallback)',
    lines: [
      'suggest-catalogue-edits/only-workspace-administrator-add',
      'review-catalogue/approve-reject-others-catalogue',
    ],
  },
  'pharmacyMedicine.setRetailDetails': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit (submits a catalogue edit for review)',
    lines: ['suggest-catalogue-edits/only-workspace-administrator-add'],
  },
  'pharmacyMedicine.stagedMedicineCreation': {
    gate: 'auditedProtectedProcedure + inline catalogueAccess: pharmacy:catalogue-review OR (admin:access AND pharmacy:catalogue-edit)',
    lines: [
      'review-catalogue/create-approved-imported-medicines',
      'suggest-catalogue-edits/request-create-imported-medicines',
    ],
  },
  'pharmacyMedicine.supersedePublication': {
    gate: 'reviewerProcedure: pharmacy:catalogue-review, OR owner fallback (admin:access AND pharmacy:catalogue-edit, owner, no other reviewer)',
    lines: [
      'review-catalogue/approve-reject-others-catalogue',
      'suggest-catalogue-edits/owner-approve-no-reviewer',
    ],
  },
  'pharmacyOffline.counters': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch)',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.enroll': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch)',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.preparationPlan': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); read only, the quota grant itself is the manager-only counter route',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.offlineCashSelling': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); read only (the switch is off and not available until sending offline sales is ready)',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.receiptNumberGaps': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); read only',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.recordUnsentOfflineSale': {
    gate: "adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); records a manager's account of one unsent offline sale a revoked counter kept, audited; books nothing",
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.revoke': {
    gate: "adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); releases the counter's open stock quotas in the same transaction, audited",
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.rotate': {
    gate: 'adminProcedure (admin:access) + managedBranch: an active branch and counterBranchAssignmentDenial (ADMIN role spans the organization; anyone else needs an active assignment to the branch); moves the credential expiry 30 days on; a counter ever issued a receipt lease also requires its current device session, bound to the same actor and branch',
    none: 'administrators only; anyone else with admin:access needs an active assignment to the branch',
  },
  'pharmacyOffline.setOfflineCashSelling': {
    gate: 'adminProcedure (admin:access) + managedBranch + isPharmacistCheckPolicyOwner (owner only); switching offline cash selling on is refused in this phase (PRECONDITION_FAILED) for everyone',
    none: 'owner only; in this phase nobody can switch it on',
  },
  'pharmacyOnboarding.fbrTier1Status': {
    gate: 'fbrTier1Procedure = adminProcedure + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.licenceRenewals': {
    gate: 'fbrTier1Procedure = adminProcedure + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.overview': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.pharmacistCoverage': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.recordFbrTier1Check': {
    gate: 'fbrTier1Procedure = adminProcedure + pharmacy-core',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.recordGate': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.regulatory': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.savePharmacistCoverage': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.saveRegulatoryProfile': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOnboarding.setBranchProvince': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOrdering.approveSubscriptionCycle': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment (staffScopeFor); the approval code entered must belong to an active pharmacist holding pharmacy:dispense (verifyRefillCyclePharmacistPin, REFILL_CYCLE_APPROVAL_CAPABILITY); solo owner-pharmacist may self-approve with a fresh approval code",
    lines: [
      'customer-orders/run-refill-cycles',
      'dispense-prescriptions/approve-refillsubscription-cycles-pin',
    ],
  },
  'pharmacyOrdering.branches': {
    gate: 'protectedProcedure',
    none: 'any signed-in member (customer storefront: active branch list, currency and their own customer record)',
  },
  'pharmacyOrdering.cancelMine': {
    gate: 'protectedProcedure (scopeFor only)',
    none: 'any signed-in member, cancelling their own customer order',
  },
  'pharmacyOrdering.catalog': {
    gate: 'protectedProcedure (scopeFor only)',
    none: 'any signed-in member (customer storefront catalogue)',
  },
  'pharmacyOrdering.complete': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment or tenant admin/owner",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOrdering.createSubscription': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.customers': {
    gate: "capabilityProcedure('pharmacy:orders'); customers seen at their assigned branches (all for tenant admin/owner)",
    lines: ['customer-orders/place-orders-customer-see'],
  },
  'pharmacyOrdering.deliveryCommand': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment; a physical return that refunds cash/returns a completed sale also needs pharmacy:manage (actorMayRefund) + own approval code; REMIT into a till they do not run needs pharmacy:manage (actorManagesBranchDrawers)",
    lines: [
      'customer-orders/work-customer-order-queue',
      'customer-orders/record-failed-returned-deliveries',
      'run-branches/refund-sales-take-returns',
    ],
  },
  'pharmacyOrdering.mine': {
    gate: 'protectedProcedure',
    none: 'any signed-in member, seeing their own customer orders',
  },
  'pharmacyOrdering.openDueSubscriptionCycles': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/run-refill-cycles'],
  },
  'pharmacyOrdering.openSubscriptionCycle': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/run-refill-cycles'],
  },
  'pharmacyOrdering.place': {
    gate: 'protectedProcedure; ordering for another customer (customerId) requires pharmacy:orders (isStaff) + branch assignment; ordering for oneself is open to any signed-in member',
    lines: ['customer-orders/place-orders-customer-see'],
  },
  'pharmacyOrdering.portalConfirmPayment': {
    gate: "capabilityProcedure('pharmacy:counter') + branch assignment (staffScopeFor)",
    lines: ['take-payment/see-customerapp-request-queue'],
  },
  'pharmacyOrdering.portalDecide': {
    gate: 'protectedProcedure + holds(): pharmacy:dispense decides REFILL/RX_ORDER, pharmacy:counter decides KHATA_PAYMENT (OR); branch assignment',
    lines: [
      'dispense-prescriptions/see-online-customer-requests',
      'take-payment/see-customerapp-request-queue',
    ],
  },
  'pharmacyOrdering.portalLink': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOrdering.portalQueue': {
    gate: 'protectedProcedure + pharmacy:dispense OR pharmacy:counter OR pharmacy:orders; branch assignment',
    lines: [
      'take-payment/see-customerapp-request-queue',
      'customer-orders/place-orders-customer-see',
      'dispense-prescriptions/see-online-customer-requests',
    ],
  },
  'pharmacyOrdering.refillProgram': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.releaseSubscriptionCycle': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/run-refill-cycles'],
  },
  'pharmacyOrdering.runners': {
    gate: "capabilityProcedure('pharmacy:orders'); runners at their assigned branches",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOrdering.setSubscriptionStatus': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment (pause/resume/cancel)",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.staffQueue': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOrdering.startCheckout': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment (hands a customer order to counter checkout)",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOrdering.startSubscriptionCycleCheckout': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.subscriptionCatalog': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.subscriptionCycleApprovers': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment (lists dispense-holding pharmacists at the branch)",
    lines: ['customer-orders/run-refill-cycles'],
  },
  'pharmacyOrdering.subscriptionCyclePrescriptions': {
    gate: "capabilityProcedure('pharmacy:orders') AND holds('pharmacy:dispense'); branch assignment",
    lines: [
      'customer-orders/dispense-see-refill-prescriptions',
      'dispense-prescriptions/handle-customer-orders-see',
    ],
  },
  'pharmacyOrdering.subscriptions': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment",
    lines: ['customer-orders/create-pause-cancel-repeatrefill'],
  },
  'pharmacyOrdering.transition': {
    gate: "capabilityProcedure('pharmacy:orders') + branch assignment (accept/pack/ready/dispatch/cancel/expire, assign runner)",
    lines: ['customer-orders/work-customer-order-queue'],
  },
  'pharmacyOwnerImport.commit': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOwnerImport.options': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOwnerImport.preview': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyOwnerImport.upload': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyPackLabel.read': {
    gate: 'auditedProtectedProcedure + inline actorCanProcure -> pharmacy:procurement; order line out for delivery to the branch',
    lines: ['receive-stock/read-pack-label-photo'],
  },
  'pharmacyPharmacistCheck.history': {
    gate: 'auditedProtectedProcedure + isPharmacistCheckPolicyOwner, no support session',
    none: 'owner only',
  },
  'pharmacyPharmacistCheck.policy': {
    gate: 'protectedProcedure',
    none: 'any signed-in member (reads the setting in force)',
  },
  'pharmacyPharmacistCheck.setPolicy': {
    gate: "protectedProcedure + isPharmacistCheckPolicyOwner + owner's fresh approval code, no support session",
    none: 'owner only',
  },
  'pharmacyPin.members': {
    gate: 'protectedProcedure + managesStaffPins (owner/all-capability, role ADMIN, or staff:manage)',
    none: 'workspace administrators, the owner, or members with staff:manage (not a pharmacy catalogue action)',
  },
  'pharmacyPin.resetForMember': {
    gate: 'protectedProcedure + password re-auth + pinResetDenial (owner; ADMIN or staff:manage for members below them)',
    none: 'workspace administrators, the owner, or members with staff:manage (not a pharmacy catalogue action)',
  },
  'pharmacyPin.setMine': {
    gate: 'protectedProcedure + current password; never a support session',
    none: 'any signed-in member, for their own PIN',
  },
  'pharmacyPin.status': {
    gate: 'protectedProcedure',
    none: 'any signed-in member, for their own PIN state',
  },
  'pharmacyPrepaid.move': {
    gate: 'adminProcedure + live organization owner (actorIsPharmacyOwner) AND requireDrawerManagerAccess; refunds also pharmacy:manage + own approval code',
    none: 'owner only',
  },
  'pharmacyPrepaid.overview': {
    gate: 'adminProcedure + live organization owner (actorIsPharmacyOwner)',
    none: 'owner only',
  },
  'pharmacyPrepaid.save': { gate: 'adminProcedure + live organization owner', none: 'owner only' },
  'pharmacyPrepaid.setPin': {
    gate: 'adminProcedure + live organization owner',
    none: 'owner only',
  },
  'pharmacyRxSoloShift.declaredSignOffs': {
    gate: 'auditedProtectedProcedure + ownerOnly (isPharmacistCheckPolicyOwner), no support session',
    none: 'owner only',
  },
  'pharmacyRxSoloShift.history': {
    gate: 'auditedProtectedProcedure + ownerOnly (isPharmacistCheckPolicyOwner), no support session',
    none: 'owner only',
  },
  'pharmacyRxSoloShift.overview': {
    gate: 'protectedProcedure; settings only for the owner (isPharmacistCheckPolicyOwner), no support session',
    none: 'owner only (anyone else is told only that they may not see it)',
  },
  'pharmacyRxSoloShift.setPolicy': {
    gate: "protectedProcedure + isPharmacistCheckPolicyOwner + the owner's fresh approval code, no support session",
    none: 'owner only, with a fresh approval code',
  },
  'pharmacyPrescriptions.capture': {
    gate: 'fileProcedure: pharmacy-dispensing module + pharmacy:prescriptions (dispense rules alias in; tenant-admin fallback); own uploaded photo only',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.captureRefillReminder': {
    gate: "capabilityProcedure('pharmacy:dispense') + branch assignment (counterBranchAssignmentDenial) + the fill's dispensing branch (DEV-962; ADMIN excepted)",
    lines: ['dispense-prescriptions/record-fills-noncontrolled-prescriptions'],
  },
  'pharmacyPrescriptions.counterPatientPanel': {
    gate: 'auditedProtectedProcedure + requireCounterPatientAccess: pharmacy:counter OR pharmacy:dispense',
    lines: [
      'take-payment/search-patients-open-patients',
      'dispense-prescriptions/search-counter-patients-open',
    ],
  },
  'pharmacyPrescriptions.counterPatients': {
    gate: 'protectedProcedure + requireCounterPatientAccess: pharmacy:counter OR pharmacy:dispense',
    lines: [
      'take-payment/search-patients-open-patients',
      'dispense-prescriptions/search-counter-patients-open',
    ],
  },
  'pharmacyPrescriptions.createPatient': {
    gate: 'fileProcedure (module + pharmacy:prescriptions)',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.createPrescriber': {
    gate: 'fileProcedure (module + pharmacy:prescriptions)',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.draftCartFromSource': {
    gate: 'fileProcedure (module + pharmacy:prescriptions); off unless PHARMACY_RX_OCR_ADAPTER configured; photo must be readable (own upload, captured, or customer-app RX order)',
    lines: [
      'record-prescriptions/read-prescription-photo-draft-bill',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.exportPatient': {
    gate: "capabilityProcedure('pharmacy:prescriptions')",
    lines: [
      'record-prescriptions/export-patients-record-consents',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.extractSource': {
    gate: 'fileProcedure (module + pharmacy:prescriptions); off unless PHARMACY_RX_OCR_ADAPTER configured; proposal only',
    lines: [
      'record-prescriptions/read-prescription-photo-draft-bill',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.fill': {
    gate: "capabilityProcedure('pharmacy:dispense'); non-controlled lines only; + branch assignment (counterBranchAssignmentDenial) when a dispensing branchId is sent (DEV-962)",
    lines: ['dispense-prescriptions/record-fills-noncontrolled-prescriptions'],
  },
  'pharmacyPrescriptions.readPatient': {
    gate: "capabilityProcedure('pharmacy:prescriptions')",
    lines: [
      'record-prescriptions/view-patients-masked-record',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.readSource': {
    gate: 'fileProcedure (module + pharmacy:prescriptions); readableSourceFile binding',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.recordConsent': {
    gate: "capabilityProcedure('pharmacy:prescriptions')",
    lines: [
      'record-prescriptions/record-patients-consent-dispensing',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.uploadSource': {
    gate: 'fileProcedure (module + pharmacy:prescriptions)',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrescriptions.workspace': {
    gate: 'fileProcedure (module + pharmacy:prescriptions); reminder branches limited to assigned branches',
    lines: [
      'record-prescriptions/open-prescription-workspace-register',
      'dispense-prescriptions/everything-record-prescriptions',
    ],
  },
  'pharmacyPrinting.bridges': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyPrinting.enqueueReceipt': {
    gate: 'requireCounterReceiptAccess: counter family ALLOW (pharmacy:counter OR pharmacy:dispense exact, or legacy pharmacy:receipt) + branch assignment (or session ADMIN any branch)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacyPrinting.enrollBridge': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyPrinting.jobStatus': {
    gate: 'requireCounterReceiptAccess (pharmacy:counter OR pharmacy:dispense + branch assignment)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacyPrinting.printerStatus': {
    gate: 'requireCounterReceiptAccess (pharmacy:counter OR pharmacy:dispense + branch assignment)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacyPrinting.retryJob': {
    gate: 'requireCounterReceiptAccess (pharmacy:counter OR pharmacy:dispense + branch assignment)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacyPrinting.revokeBridge': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacyPurchasing.allocateCentralReceipt': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement; lib requireOrganizationPurchaser: owner or organization-wide central purchasing grant',
    lines: ['receive-stock/central-purchasing'],
  },
  'pharmacyPurchasing.allocateSupplierCredit': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.approvePurchaseOrder': {
    gate: 'meta APPROVAL -> pharmacy:procurement-approve (assigned to order + requisition branch); self-approval only for solo owner via verifyPurchaseApprover, which also needs pharmacy:procurement + approval code',
    lines: [
      'approve-purchase-orders/approve-reject-purchase-orders',
      'approve-purchase-orders/order-receive-stock-approve',
    ],
  },
  'pharmacyPurchasing.authenticatePack': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.centralDemand': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement; lib purchasingAccess: owner or central purchasing grant (branch or org-wide)',
    lines: ['receive-stock/central-purchasing'],
  },
  'pharmacyPurchasing.compareQuotes': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.controlledReversalWitnesses': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch) AND inline can(pharmacy:safety)',
    lines: [
      'receive-stock/controlled-witnesses',
      'controlled-medicines/order-receive-stock-reverse',
    ],
  },
  'pharmacyPurchasing.controlledWitnesses': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch) AND inline can(pharmacy:safety) OR can(pharmacy:dispense)',
    lines: [
      'receive-stock/controlled-witnesses',
      'dispense-prescriptions/order-receive-stock-see',
      'controlled-medicines/order-receive-stock-see',
    ],
  },
  'pharmacyPurchasing.createCentralPurchaseOrder': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (receiving branch assigned); lib requireOrganizationPurchaser: owner or org-wide central grant',
    lines: ['receive-stock/central-purchasing'],
  },
  'pharmacyPurchasing.createGoodsReceipt': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch); direct purchase needs a different approver holding pharmacy:procurement + pharmacy:procurement-approve at the branch, with their approval code (solo owner exception)',
    lines: [
      'receive-stock/run-purchasing-branches-add',
      'approve-purchase-orders/order-receive-stock-approve',
    ],
  },
  'pharmacyPurchasing.createPurchaseOrder': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (order/requisition branches)',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.createPurchaseReturn': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.createRequisition': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.createSupplier': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (tenant-wide record)',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.debitNotePositions': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.decideReceiptDebitNote': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: ['receive-stock/proposed-debit-notes', 'financial-reports/decide-proposed-debit-notes'],
  },
  'pharmacyPurchasing.dispatchPurchaseReturn': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.legacySupplierDispatches': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch), live owner for historical dispatch data',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.goodsReceipts': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.ignoreLostDemandAdvice': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/restock-advice'],
  },
  'pharmacyPurchasing.issueDebitNote': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.landedCost': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.lostDemandAdvice': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/restock-advice'],
  },
  'pharmacyPurchasing.lostDemandTriggerSettings': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/restock-advice'],
  },
  'pharmacyPurchasing.lotsFromReceipt': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.officialPriceAlerts': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement; returns [] unless inline can(pharmacy:safety)',
    lines: ['receive-stock/official-price-alerts', 'controlled-medicines/order-receive-stock-see'],
  },
  'pharmacyPurchasing.postGoodsReceipt': {
    gate: "meta PROCUREMENT + assertProcurement -> pharmacy:procurement (assigned branch); legacy direct-purchase drafts re-check the approver's approval code (procurement + procurement-approve); controlled lines need the receipt's qualified person (pharmacy:dispense, not the poster) to enter their approval code",
    lines: [
      'receive-stock/run-purchasing-branches-add',
      'approve-purchase-orders/order-receive-stock-approve',
      'dispense-prescriptions/sign-controlledmedicine-delivery-pin',
    ],
  },
  'pharmacyPurchasing.provisionMyPurchasePin': {
    gate: 'meta PROCUREMENT_AND_APPROVAL -> pharmacy:procurement AND pharmacy:procurement-approve; password re-entry; first PIN only',
    lines: [
      'receive-stock/approve-purchase-orders-authorize',
      'approve-purchase-orders/order-receive-stock-authorize',
    ],
  },
  'pharmacyPurchasing.purchaseOrders': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned/central branches)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.purchaseReturns': {
    gate: 'meta FINANCIAL_FOLLOW_UP -> reports:financial; supplierFollowUpScope: procurement module + reports:financial + assigned branch (no pharmacy:procurement needed)',
    lines: ['financial-reports/view-supplier-returns-claims'],
  },
  'pharmacyPurchasing.receiptDebitNotes': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/proposed-debit-notes'],
  },
  'pharmacyPurchasing.receivedAgainstOrder': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (order branches)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.receivingExceptionQueue': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/receiving-exceptions'],
  },
  'pharmacyPurchasing.receivingExceptions': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/receiving-exceptions'],
  },
  'pharmacyPurchasing.recordQuote': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.recordSupplierCredit': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.recordSupplierLicence': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement; filing as already verified only for solo owner',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.reorderDrafts': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/restock-advice'],
  },
  'pharmacyPurchasing.requestLostDemandTransfer': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned at both destination and source branch)',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.requisitions': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned/central branches)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.resolveReceivingException': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/receiving-exceptions'],
  },
  'pharmacyPurchasing.resolveScan': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.returnableLots': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.reverseGoodsReceipt': {
    gate: 'meta PROCUREMENT + assertProcurement -> pharmacy:procurement (assigned branch); controlled receipts: actor needs pharmacy:safety and a witness with pharmacy:dispense + approval code (sole pharmacist may self-witness with fresh approval code)',
    lines: [
      'receive-stock/run-purchasing-branches-add',
      'controlled-medicines/order-receive-stock-reverse',
      'dispense-prescriptions/witness-controlled-delivery-reversal',
    ],
  },
  'pharmacyPurchasing.sendPurchaseOrder': {
    gate: 'meta APPROVAL -> pharmacy:procurement-approve (order branches)',
    lines: ['approve-purchase-orders/approve-reject-purchase-orders'],
  },
  'pharmacyPurchasing.setLostDemandTriggerSettings': {
    gate: 'meta APPROVAL -> pharmacy:procurement-approve (assigned branch)',
    lines: ['approve-purchase-orders/approve-reject-purchase-orders'],
  },
  'pharmacyPurchasing.setSupplierAuthorization': {
    gate: 'meta PROCUREMENT_AND_APPROVAL -> pharmacy:procurement AND pharmacy:procurement-approve',
    lines: [
      'receive-stock/approve-purchase-orders-authorize',
      'approve-purchase-orders/order-receive-stock-authorize',
    ],
  },
  'pharmacyPurchasing.submitPurchaseOrder': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (order branches)',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.submitPurchaseReturn': {
    gate: 'meta PROCUREMENT_AND_FINANCE -> pharmacy:procurement AND reports:financial (assigned branch)',
    lines: [
      'receive-stock/use-financial-reports-return',
      'financial-reports/order-receive-stock-issue',
    ],
  },
  'pharmacyPurchasing.submitRequisition': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/run-purchasing-branches-add'],
  },
  'pharmacyPurchasing.supplierCredits': {
    gate: 'meta FINANCIAL_FOLLOW_UP -> reports:financial; supplierFollowUpScope: procurement module + assigned branch',
    lines: ['financial-reports/view-supplier-returns-claims'],
  },
  'pharmacyPurchasing.suppliers': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyPurchasing.verifySupplierLicence': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement; refused for the filer unless solo owner',
    lines: ['receive-stock/verify-supplier-licence'],
  },
  'pharmacyPurchasing.workspace': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/open-purchasing-screens-read'],
  },
  'pharmacyReports.acknowledgeAnomaly': {
    gate: 'reports builder (reports:operational) + requireFinancialReports (reports:financial) + requireOwnerBranch (role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.acknowledgePackAuthenticationFlag': {
    gate: 'reports:operational + reports:financial + role ADMIN (requireOwnerBranch)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.anomalySignals': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.branchComparison': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.branches': {
    gate: 'auditedProtectedProcedure + pharmacy-reports module; reports:operational/Manager see more branches, others see their assigned branches',
    none: 'any signed-in member of the licensed workspace (branch picker list)',
  },
  'pharmacyReports.catalog': {
    gate: 'branchReports: reports:operational (all branches) OR pharmacy:manage (assigned branches, unless reports:operational denied)',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/read-reports-centre-replenishment',
    ],
  },
  'pharmacyReports.categoryGrowth': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.commandCentre': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches); money figures only with reports:financial; safety queue hidden for branch-scoped Managers',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'operational-reports/see-stock-alert-lost',
      'run-branches/read-reports-centre-replenishment',
      'financial-reports/see-sales-margin-cash',
    ],
  },
  'pharmacyReports.createPharmacovigilanceReport': {
    gate: 'auditedProtectedProcedure + requirePvFiling (pharmacy:safety OR pharmacy:dispense) + assigned register branch',
    lines: [
      'dispense-prescriptions/file-adversereaction-medicationerror-reports',
      'controlled-medicines/file-adversereaction-medicationerror-productquality',
    ],
  },
  'pharmacyReports.dailyWorkPack': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches); anomaly/expiry items only for ADMIN + reports:financial',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/read-reports-centre-replenishment',
      'financial-reports/workspace-administrator-run-orderplanning',
    ],
  },
  'pharmacyReports.deleteSeasonalWindow': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.digestOverview': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'financial-reports/workspace-administrator-use-operational-7',
      'operational-reports/run-seasonal-calendar-demandspike',
      'operational-reports/workspace-administrator-use-financial-6',
    ],
  },
  'pharmacyReports.expiryAdvice': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.exportPharmacovigilanceDrap': {
    gate: "capabilityProcedure('pharmacy:safety') + assigned register branch",
    lines: ['controlled-medicines/review-mark-ready-submit'],
  },
  'pharmacyReports.getPreferences': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches)',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/save-reports-dashboard-layout',
    ],
  },
  'pharmacyReports.lostSalesRecovery': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/admin-view-repeat-lostsales-packflags',
      'operational-reports/admin-view-repeat-lostsales-packflags',
    ],
  },
  'pharmacyReports.marketing': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.packAuthenticationFlags': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/admin-view-repeat-lostsales-packflags',
      'operational-reports/admin-view-repeat-lostsales-packflags',
    ],
  },
  'pharmacyReports.proposeExpiryReturn': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.recordPharmacovigilanceSubmission': {
    gate: "capabilityProcedure('pharmacy:safety') + assigned register branch",
    lines: ['controlled-medicines/review-mark-ready-submit'],
  },
  'pharmacyReports.refreshAnomalies': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.repeatPurchasing': {
    gate: 'reports:operational + ownerFilters (reports:financial + role ADMIN)',
    lines: [
      'financial-reports/admin-view-repeat-lostsales-packflags',
      'operational-reports/admin-view-repeat-lostsales-packflags',
    ],
  },
  'pharmacyReports.replenishment': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches); order-planning scenario figures only for ADMIN + reports:financial',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/read-reports-centre-replenishment',
      'financial-reports/workspace-administrator-run-orderplanning',
    ],
  },
  'pharmacyReports.saltSpikes': {
    gate: "capabilityProcedure('reports:operational')",
    lines: ['operational-reports/run-seasonal-calendar-demandspike'],
  },
  'pharmacyReports.saveSeasonalWindow': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.seasonalCalendar': {
    gate: "capabilityProcedure('reports:operational'); canEdit flag only for ADMIN + reports:financial",
    lines: ['operational-reports/run-seasonal-calendar-demandspike'],
  },
  'pharmacyReports.snoozeAnomaly': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.staffingSuggestions': {
    gate: "capabilityProcedure('reports:operational')",
    lines: ['operational-reports/run-seasonal-calendar-demandspike'],
  },
  'pharmacyReports.suppliers': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches)',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/read-reports-centre-replenishment',
    ],
  },
  'pharmacyReports.transitionPharmacovigilanceReport': {
    gate: "capabilityProcedure('pharmacy:safety') + assigned register branch (solo owner may mark own report READY with approval code)",
    lines: ['controlled-medicines/review-mark-ready-submit'],
  },
  'pharmacyReports.updateDigestSetting': {
    gate: 'reports:operational + requireFinancialReports + role ADMIN',
    lines: [
      'financial-reports/workspace-administrator-use-operational',
      'operational-reports/run-seasonal-calendar-demandspike',
    ],
  },
  'pharmacyReports.updatePreferences': {
    gate: 'branchReports (reports:operational OR pharmacy:manage on assigned branches)',
    lines: [
      'operational-reports/open-reports-centre-replenishment',
      'run-branches/save-reports-dashboard-layout',
    ],
  },
  'pharmacySafety.access': {
    gate: 'protectedProcedure; returns whether caller holds pharmacy:safety',
    none: 'any signed-in member (only reports whether they hold Controlled medicines and safety)',
  },
  'pharmacySafety.approveRegisterIncident': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.branches': {
    gate: "capabilityProcedure('pharmacy:safety'); their assigned register branches",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.controlledPharmacists': {
    gate: 'protectedProcedure + pharmacy:safety OR pharmacy:dispense',
    lines: [
      'controlled-medicines/see-which-pharmacists-can',
      'dispense-prescriptions/see-which-pharmacists-can',
    ],
  },
  'pharmacySafety.controlledRegister': {
    gate: "capabilityProcedure('pharmacy:safety') + branch scope (organizationBranch)",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.createInspectionPack': {
    gate: "capabilityProcedure('pharmacy:safety') + branch scope",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.installSopLibrary': {
    gate: "capabilityProcedure('pharmacy:safety') (whole pharmacy)",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.legalHoldStatus': {
    gate: "capabilityProcedure('pharmacy:safety')",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.recordCorrection': {
    gate: "capabilityProcedure('pharmacy:safety') + branch scope; approval code must be a different active person holding pharmacy:dispense",
    lines: [
      'controlled-medicines/view-controlled-medicines-register',
      'dispense-prescriptions/witness-controlledregister-corrections-controlled',
    ],
  },
  'pharmacySafety.recordLegalHold': {
    gate: "capabilityProcedure('pharmacy:safety') (place or release)",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySafety.setRetentionClass': {
    gate: "capabilityProcedure('pharmacy:safety'); lengthen only",
    lines: ['controlled-medicines/view-controlled-medicines-register'],
  },
  'pharmacySales.acknowledgeDuplicateSalt': {
    gate: 'requireCartWriteAccess -> pharmacy:counter or exact pharmacy:dispense (counter family not DENIED) at assigned branch or ADMIN',
    lines: [
      'take-payment/ring-up-medicines',
      'dispense-prescriptions/ring-up-medicines-without-counter',
    ],
  },
  'pharmacySales.addLine': {
    gate: "requireCartWriteAccess (pharmacy:counter or pharmacy:dispense, assigned branch or ADMIN); discount -> pharmacy:discount or a pharmacy:manage approval code; batch override -> pharmacy:dispense on duty or a dispense approval code; scanned pack out of FEFO -> pharmacy:manage approval code; Rx/restricted line and prescription fill -> pharmacy:dispense; controlled -> pharmacy:dispense + a different pharmacist's approval code (unless owner switched check off); voucher -> own approval code",
    lines: [
      'take-payment/ring-up-medicines',
      'dispense-prescriptions/ring-up-medicines-without-counter',
      'take-payment/open-hold-resume-void',
      'give-discounts/give-counter-discounts-without',
      'run-branches/approve-someone-elses-counter',
      'dispense-prescriptions/approve-selling-from-batch',
      'run-branches/approve-selling-pack-that',
      'dispense-prescriptions/sell-prescriptiononly-restricted-medicines',
      'dispense-prescriptions/ring-up-sale-line',
      'dispense-prescriptions/sell-controlled-medicines-counter',
      'dispense-prescriptions/witness-colleagues-controlledmedicine-sale',
    ],
  },
  'pharmacySales.changeLine': {
    gate: "protectedProcedure + requireCartWriteAccess (pharmacy:counter or pharmacy:dispense, assigned branch or ADMIN), the addLine builder and gate; Rx/restricted line -> pharmacy:dispense; another's bill -> pharmacy:manage (as a void); refused for a paid, held or closed bill, a controlled or prescription line, or a discount, voucher or batch override approved for the old quantity; on a cash-shift branch refused between shifts (the payment rule) and for a bill whose shift has closed",
    lines: [
      'take-payment/ring-up-medicines',
      'dispense-prescriptions/ring-up-medicines-without-counter',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/sell-prescriptiononly-restricted-medicines',
    ],
  },
  'pharmacySales.addRestockInterest': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter + counter family, assigned branch or ADMIN',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.checkBillLinePack': {
    gate: 'auditedProtectedProcedure; requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch or ADMIN; bill owner or manager',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.authenticatePack': {
    gate: 'assignedBranchScope then requireCartWriteAccess -> pharmacy:counter or exact pharmacy:dispense (counter family not DENIED)',
    lines: [
      'take-payment/ring-up-medicines',
      'dispense-prescriptions/ring-up-medicines-without-counter',
    ],
  },
  'pharmacySales.recordCounterDemand': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch or ADMIN',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.captureDemand': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch or ADMIN',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.captureSafeRestockArrival': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch or ADMIN',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.closeAnomalyCheck': {
    gate: 'adminProcedure (admin:access) AND session role ADMIN AND reports:financial (requireOwnerFinancialReports)',
    lines: ['financial-reports/workspace-administrator-run-dayclose'],
  },
  'pharmacySales.closeDay': {
    gate: 'requireCloseAccess -> session ADMIN, or pharmacy:close (any branch), or pharmacy:manage at an assigned branch unless pharmacy:close is DENIED',
    lines: [
      'close-the-day/review-reconciliation-close-day',
      'run-branches/close-day-branches-unless',
    ],
  },
  'pharmacySales.closeDrawer': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage (counter family not DENIED), assigned branch or ADMIN',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacySales.closePreview': {
    gate: 'requireCloseAccess -> ADMIN, pharmacy:close, or pharmacy:manage at assigned branch unless close DENIED',
    lines: [
      'close-the-day/review-reconciliation-close-day',
      'run-branches/close-day-branches-unless',
    ],
  },
  'pharmacySales.closeShift': {
    gate: "auditedProtectedProcedure + cashShiftScope: requireDrawerManagerAccess (pharmacy:manage, counter family not DENIED, assigned branch or ADMIN) closes any shift of the branch; otherwise requireCounterReceiptAccess(canonical true) -> pharmacy:counter, own shift only; over or short above the tolerance -> the caller's right to close that shift is checked before any PIN; approver passes actorManagesBranchDrawers + their PIN or code through verifyApprovalSecret, and is neither the shift's cashier nor the caller unless no other approver with a live PIN exists (solo policy, or the solo-pharmacy rule); guesses typed by someone else never strike the approver's credential and are capped per approver",
    lines: ['take-payment/open-close-own-cash-shift', 'run-branches/run-cash-shifts-branches'],
  },
  'pharmacySales.counterBranches': {
    gate: "protectedProcedure; lists the caller's own assigned active branches (all for ADMIN)",
    none: 'any signed-in member, for their own branch assignments',
  },
  'pharmacySales.counterCart': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterEvidence': {
    gate: 'adminProcedure (admin:access) + pharmacy-core module',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.counterKeymap': {
    gate: "protectedProcedure; reads the caller's own keymap",
    none: 'any signed-in member, for their own account',
  },
  'pharmacySales.counterLotOptions': {
    gate: 'assignedBranchScope only; no capability checked',
    none: 'any signed-in member assigned to the branch (or a workspace administrator); no permission action is checked',
  },
  'pharmacySales.counterReceipt': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptBrowserPrint': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptBrowserPrintDispatched': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptBrowserPrintFailed': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptFormat': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptPrintJob': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterReceiptWhatsApp': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt, assigned branch or ADMIN',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterSaveKeymap': {
    gate: "protectedProcedure; saves the caller's own keymap (unconfirmed presets ADMIN only)",
    none: 'any signed-in member, for their own account',
  },
  'pharmacySales.counterSaveReceiptFormat': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.counterSearch': {
    gate: 'assignedBranchScope then requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.counterVoucher': {
    gate: 'assignedBranchScope then requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.create': {
    gate: 'requireCartWriteAccess -> pharmacy:counter or pharmacy:dispense; a pharmacy:counter holder also needs an open drawer for a non-quotation bill',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.createPromotion': {
    gate: "capabilityProcedure('pharmacy:manage') + promotionScope (assigned branch or ADMIN)",
    lines: ['run-branches/create-view-switch-off'],
  },
  'pharmacySales.customerDirectory': {
    gate: 'adminProcedure (admin:access) + pharmacy-crm module',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.customerSnapshot': {
    gate: 'assignedBranchScope then requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt (points history limited to assigned branches unless ADMIN)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.dailyClose': {
    gate: 'requireCloseAccess -> ADMIN, pharmacy:close, or pharmacy:manage at assigned branch unless close DENIED',
    lines: [
      'close-the-day/review-reconciliation-close-day',
      'run-branches/close-day-branches-unless',
    ],
  },
  'pharmacySales.dailyCloseEvidence': {
    gate: 'adminProcedure (admin:access) + pharmacy-core module',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.dayCloseBranches': {
    gate: 'dayCloseBranchIds -> ADMIN or pharmacy:close (all branches), else pharmacy:manage assigned branches unless pharmacy:close DENIED',
    lines: [
      'close-the-day/review-reconciliation-close-day',
      'run-branches/close-day-branches-unless',
    ],
  },
  'pharmacySales.dayEndHour': {
    gate: 'protectedProcedure + requireDrawerManagerAccess -> pharmacy:manage (counter family not DENIED), assigned branch or ADMIN',
    lines: ['run-branches/set-when-business-day'],
  },
  'pharmacySales.dayReopenAccess': {
    gate: 'protectedProcedure; returns {authorized} from requireDrawerManagerAccess without throwing',
    none: 'any signed-in member (only reports whether they may reopen the day)',
  },
  'pharmacySales.declineSubstitute': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter; records a SUBSTITUTE_DECLINED demand',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.demandAggregate': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage, assigned branch or ADMIN',
    lines: ['run-branches/see-demand-lostsales-restockrecovery'],
  },
  'pharmacySales.disablePromotion': {
    gate: "capabilityProcedure('pharmacy:manage') + promotionScope",
    lines: ['run-branches/create-view-switch-off'],
  },
  'pharmacySales.discardTenderAttempt': {
    gate: "pharmacy:counter (canonical gate, or khataScope write for khata attempts) AND a pharmacy:manage approver's approval code (TENDER_DISCARD; solo rule allows own approval code)",
    lines: [
      'take-payment/discard-unknown-card-payment',
      'run-branches/approve-discarding-card-payment',
    ],
  },
  'pharmacySales.discountApprovers': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: ['take-payment/see-till-approvers', 'dispense-prescriptions/see-till-approvers'],
  },
  'pharmacySales.discountBillLine': {
    gate: 'protectedProcedure; requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch or ADMIN; bill owner or manager; DISCOUNT approval',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.applyBillDiscount': {
    gate: "requireCartWriteAccess (pharmacy:counter or pharmacy:dispense, assigned branch or ADMIN) + the owner's whole-bill discount switch on; approved as an item discount: the operator's own pharmacy:discount, or a pharmacy:manage approver's approval code (solo: the sole approver's own approval code); removing it (zero) needs no approval",
    lines: [
      'take-payment/whole-bill-discount',
      'dispense-prescriptions/whole-bill-discount',
      'give-discounts/give-counter-discounts-without',
      'run-branches/approve-someone-elses-counter',
    ],
  },
  'pharmacySales.billDiscountSetting': {
    gate: "branchScopeOrForbidden only (branch in caller's organization); no capability or assignment",
    none: 'any signed-in member of the workspace (reads whether it is on; canChange is true only for the owner)',
  },
  'pharmacySales.discountMaximum': {
    gate: "branchScopeOrForbidden only (branch in caller's organization); no capability or assignment",
    none: 'any signed-in member of the workspace (read-only; canChange is true only for the owner)',
  },
  'pharmacySales.discountPolicy': {
    gate: "marginScopeFor(['pharmacy:manage']) -> assigned branch or ADMIN",
    lines: ['run-branches/see-discount-policy-log'],
  },
  'pharmacySales.discountSuggestions': {
    gate: "marginScopeFor(['pharmacy:dispense','pharmacy:manage']) -> assigned branch or ADMIN",
    lines: [
      'dispense-prescriptions/see-brand-margins-branch',
      'run-branches/see-discount-policy-log',
    ],
  },
  'pharmacySales.drawerCashiers': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage, assigned branch or ADMIN',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacySales.drawerMovement': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage, assigned branch or ADMIN',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacySales.drawerStatus': {
    gate: 'assignedBranchScope only; no capability checked',
    none: 'any signed-in member assigned to the branch (or a workspace administrator); no permission action is checked',
  },
  'pharmacySales.handoverDrawer': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage, assigned branch or ADMIN',
    lines: ['run-branches/run-cash-drawers-branches'],
  },
  'pharmacySales.higherMarginBrandMix': {
    gate: "marginScopeFor(['pharmacy:procurement','pharmacy:dispense','pharmacy:manage']) -> assigned branch or ADMIN",
    lines: [
      'receive-stock/see-highermargin-brand-suggestions',
      'dispense-prescriptions/see-brand-margins-branch',
      'run-branches/see-brand-margins-highermargin',
    ],
  },
  'pharmacySales.khataAccounts': {
    gate: 'khataScope read -> pharmacy:counter, or reports:financial (read only); counter family excl. dispense; assigned branch or ADMIN',
    lines: [
      'take-payment/view-khata-accounts-statements',
      'financial-reports/view-customer-khata-accounts',
    ],
  },
  'pharmacySales.khataOverLimitApprovers': {
    gate: 'khataScope write -> pharmacy:counter only',
    lines: ['take-payment/see-till-approvers'],
  },
  'pharmacySales.khataPaymentAccounts': {
    gate: 'khataScope read -> pharmacy:counter or reports:financial',
    lines: [
      'take-payment/view-khata-accounts-statements',
      'financial-reports/view-customer-khata-accounts',
    ],
  },
  'pharmacySales.khataReminderSettings': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.khataSignup': {
    gate: 'khataScope write -> pharmacy:counter only',
    lines: ['take-payment/view-khata-accounts-statements'],
  },
  'pharmacySales.khataStatement': {
    gate: 'khataScope read -> pharmacy:counter or reports:financial',
    lines: [
      'take-payment/view-khata-accounts-statements',
      'financial-reports/view-customer-khata-accounts',
    ],
  },
  'pharmacySales.linkCustomer': {
    gate: 'requireCartWriteAccess -> pharmacy:counter or pharmacy:dispense',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.linkRestockRecoveries': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.lookupReceiptByNumber': {
    gate: 'counterReceiptGrant default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt; searches assigned branches (ADMIN audited exception)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.lostSalesSummary': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage',
    lines: ['run-branches/see-demand-lostsales-restockrecovery'],
  },
  'pharmacySales.manualPaymentSettings': {
    gate: 'session ADMIN: branch in org; otherwise requireCounterReceiptAccess(canonical true) -> pharmacy:counter, assigned branch',
    lines: ['take-payment/take-payment-branches-by'],
  },
  'pharmacySales.openBills': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.openDrawer': {
    gate: 'empty drawer for self -> pharmacy:counter (canonical); opening float > 0 or naming another cashier -> requireDrawerManagerAccess (pharmacy:manage)',
    lines: ['take-payment/take-payment-branches-by', 'run-branches/run-cash-drawers-branches'],
  },
  'pharmacySales.openShift': {
    gate: 'auditedProtectedProcedure; naming another cashier -> requireDrawerManagerAccess (pharmacy:manage); own shift -> cashShiftScope: requireDrawerManagerAccess, else requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/open-close-own-cash-shift', 'run-branches/run-cash-shifts-branches'],
  },
  'pharmacySales.optOutRestockInterest': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.promotions': {
    gate: "capabilityProcedure('pharmacy:manage') + promotionScope",
    lines: ['run-branches/create-view-switch-off'],
  },
  'pharmacySales.recordCompetitorPrice': {
    gate: "marginScopeFor(['pharmacy:manage'])",
    lines: ['run-branches/see-discount-policy-log'],
  },
  'pharmacySales.recordKhataPayment': {
    gate: "khataScope write -> pharmacy:counter; cash into another's till only if actorManagesBranchDrawers (pharmacy:manage)",
    lines: ['take-payment/view-khata-accounts-statements'],
  },
  'pharmacySales.recoverDemand': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.recoverRestockInterest': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.redeemPoints': {
    gate: "capabilityProcedure('pharmacy:dispense') AND requireCounterReceiptAccess default (assigned branch)",
    lines: ['dispense-prescriptions/redeem-customers-loyalty-points'],
  },
  'pharmacySales.refundAccess': {
    gate: 'protectedProcedure; returns whether actorMayRefund (pharmacy:manage)',
    none: 'any signed-in member (only reports whether they may refund)',
  },
  'pharmacySales.refundTender': {
    gate: "requireCounterReceiptAccess (pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt; khata-credit tenders need khataScope write = pharmacy:counter) AND actorMayRefund (pharmacy:manage) AND the actor's own approval code; integrated terminal liabilities also require pharmacyRefundPostingMutation (admin:access + finance:manage + finance:read)",
    lines: [
      'manage-finance-accounts/manage-transactions',
      'run-branches/refund-sales-take-returns',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.reopenDay': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage, assigned branch or ADMIN, plus own approval code',
    lines: ['run-branches/reopen-closed-day-branches'],
  },
  'pharmacySales.restockRecoveryReport': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage',
    lines: ['run-branches/see-demand-lostsales-restockrecovery'],
  },
  'pharmacySales.removeLine': {
    gate: "protectedProcedure + requireCartWriteAccess (pharmacy:counter or pharmacy:dispense, assigned branch or ADMIN), the addLine builder and gate; Rx/restricted line -> pharmacy:dispense; another's bill -> pharmacy:manage (as a void); refused for a paid, held or closed bill and a controlled or prescription line; on a cash-shift branch refused between shifts (the payment rule) and for a bill whose shift has closed",
    lines: [
      'take-payment/ring-up-medicines',
      'dispense-prescriptions/ring-up-medicines-without-counter',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/sell-prescriptiononly-restricted-medicines',
    ],
  },
  'pharmacySales.returnAndRefund': {
    gate: "requireCounterReceiptAccess default (pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt) AND pharmacy:manage AND own approval code; khata refund needs pharmacy:counter; controlled line needs pharmacy:dispense + a witnessing pharmacist's approval code; integrated terminal liabilities also require pharmacyRefundPostingMutation (admin:access + finance:manage + finance:read)",
    lines: [
      'manage-finance-accounts/manage-transactions',
      'run-branches/refund-sales-take-returns',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
      'dispense-prescriptions/void-return-controlledmedicine-sale',
      'dispense-prescriptions/witness-controlled-stock-going',
    ],
  },
  'pharmacySales.returnHistory': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/see-returns-refund-value',
      'dispense-prescriptions/see-returns-refund-value',
    ],
  },
  'pharmacySales.returnLines': {
    gate: 'requireCounterReceiptAccess default as returnLine/returnAndRefund (receipt, dispensing or counter capability family; DENY wins), assigned branch or ADMIN AND pharmacy:manage AND own approval code; khata refund needs pharmacy:counter; controlled line needs pharmacy:dispense + witness approval code',
    lines: [
      'run-branches/refund-sales-take-returns',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
      'dispense-prescriptions/void-return-controlledmedicine-sale',
      'dispense-prescriptions/witness-controlled-stock-going',
    ],
  },
  'pharmacySales.returnLine': {
    gate: 'requireCounterReceiptAccess default (pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt) AND pharmacy:manage AND own approval code; controlled line needs pharmacy:dispense + witness approval code',
    lines: [
      'run-branches/refund-sales-take-returns',
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
      'dispense-prescriptions/void-return-controlledmedicine-sale',
      'dispense-prescriptions/witness-controlled-stock-going',
    ],
  },
  'pharmacySales.returnQuote': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/see-returns-refund-value',
      'dispense-prescriptions/see-returns-refund-value',
    ],
  },
  'pharmacySales.saleReadiness': {
    gate: 'counterReceiptGrant default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt (unassigned branch reported, not thrown)',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.sameSaltMarginRanking': {
    gate: "marginScopeFor(['pharmacy:dispense','pharmacy:manage'])",
    lines: [
      'dispense-prescriptions/see-brand-margins-branch',
      'run-branches/see-brand-margins-highermargin',
    ],
  },
  'pharmacySales.sandboxPayment': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.saveBillDiscountSetting': {
    gate: "protectedProcedure + owner (readMaxDiscountSettings canChange) + the owner's fresh approval code; support sessions refused; audited",
    none: 'owner only, with a fresh approval code',
  },
  'pharmacySales.saveDayEndHour': {
    gate: 'auditedProtectedProcedure + requireDrawerManagerAccess -> pharmacy:manage (counter family not DENIED), assigned branch or ADMIN; revision-checked and audited; no PIN',
    lines: ['run-branches/set-when-business-day'],
  },
  'pharmacySales.saveDiscountMaximum': {
    gate: "protectedProcedure + isOrganizationOwner + owner's approval code; support sessions refused",
    none: 'owner only',
  },
  'pharmacySales.saveDiscountPolicy': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.saveKhataReminderSettings': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.saveManualPaymentSettings': {
    gate: 'adminProcedure (admin:access)',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySales.scanLoyaltyCard': {
    gate: 'requireCartWriteAccess -> pharmacy:counter or pharmacy:dispense',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.scannedPackFefoApprovers': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: ['take-payment/see-till-approvers', 'dispense-prescriptions/see-till-approvers'],
  },
  'pharmacySales.setDemandOutcome': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/follow-up-outofstock-requests'],
  },
  'pharmacySales.settleLostSales': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage',
    lines: ['run-branches/see-demand-lostsales-restockrecovery'],
  },
  'pharmacySales.settlementAccess': {
    gate: 'protectedProcedure; returns whether can(pharmacy:counter)',
    none: 'any signed-in member (only reports whether they may take payment)',
  },
  'pharmacySales.shiftApprovers': {
    gate: "cashShiftScope: requireDrawerManagerAccess (pharmacy:manage), else requireCounterReceiptAccess(canonical true) -> pharmacy:counter; lists members passing actorManagesBranchDrawers with a live PIN other than the shift's cashier and the caller, or those two when nobody else can",
    lines: ['take-payment/open-close-own-cash-shift', 'run-branches/run-cash-shifts-branches'],
  },
  'pharmacySales.shiftHandoverNote': {
    gate: 'adminProcedure (admin:access) AND session role ADMIN AND reports:financial',
    lines: ['financial-reports/workspace-administrator-run-dayclose'],
  },
  'pharmacySales.shiftReport': {
    gate: 'cashShiftScope: requireDrawerManagerAccess (pharmacy:manage) reads any shift of the branch; otherwise requireCounterReceiptAccess(canonical true) -> pharmacy:counter, own shift only',
    lines: ['take-payment/open-close-own-cash-shift', 'run-branches/run-cash-shifts-branches'],
  },
  'pharmacySales.substituteProposals': {
    gate: 'assignedBranchScope only; no capability checked',
    none: 'any signed-in member assigned to the branch (or a workspace administrator); no permission action is checked',
  },
  'pharmacySales.tender': {
    gate: "non-khata -> pharmacy:counter (canonical), cash into another's till only for pharmacy:manage, wallet needs customer's prepaid PIN; khata -> khataScope write (pharmacy:counter), over limit -> a pharmacy:manage approver's approval code (or sole manager password re-auth)",
    lines: [
      'take-payment/take-payment-branches-by',
      'take-payment/view-khata-accounts-statements',
      'run-branches/approve-charging-customers-khata',
    ],
  },
  'pharmacySales.tenderDiscardApprovers': {
    gate: 'requireCounterReceiptAccess(canonical true) -> pharmacy:counter',
    lines: ['take-payment/see-till-approvers'],
  },
  'pharmacySales.tenderOutcome': {
    gate: 'khata/credit -> khataScope read (pharmacy:counter or reports:financial); card/manual wallet -> pharmacy:counter; cash, wallet, bank transfer -> assignedBranchScope only (any assigned member)',
    lines: [
      'take-payment/take-payment-branches-by',
      'financial-reports/view-customer-khata-accounts',
    ],
  },
  'pharmacySales.tradingDayStatus': {
    gate: 'requireCounterReceiptAccess default -> pharmacy:counter, pharmacy:dispense or legacy pharmacy:receipt',
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
    ],
  },
  'pharmacySales.transition': {
    gate: "requireCartWriteAccess (pharmacy:counter or pharmacy:dispense) for hold/resume/convert/void; voiding another's bill -> pharmacy:manage; controlled line void -> pharmacy:dispense + witness approval code",
    lines: [
      'take-payment/open-hold-resume-void',
      'dispense-prescriptions/use-counter-without-counter',
      'run-branches/refund-sales-take-returns',
      'dispense-prescriptions/void-return-controlledmedicine-sale',
      'dispense-prescriptions/witness-controlled-stock-going',
    ],
  },
  'pharmacySales.updateLostSalesSettings': {
    gate: 'requireDrawerManagerAccess -> pharmacy:manage',
    lines: ['run-branches/see-demand-lostsales-restockrecovery'],
  },
  'pharmacySales.upsellSuggestions': {
    gate: 'assignedBranchScope only; no capability checked',
    none: 'any signed-in member assigned to the branch (or a workspace administrator); no permission action is checked',
  },
  'pharmacySop.access': {
    gate: 'protectedProcedure; returns canManage/canComplete/canVerify flags',
    none: 'any signed-in member, to learn which procedure permissions they hold',
  },
  'pharmacySop.addReworkNote': {
    gate: 'completeProcedure (sop:complete) + own work, back in progress after a send-back',
    lines: ['do-procedures/add-rework-notes'],
  },
  'pharmacySop.assignments': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.board': {
    gate: 'auditedProtectedProcedure + requireAnyCapability(sop:complete, sop:verify); review list needs sop:verify + verifier role',
    lines: ['do-procedures/see-procedures-board-open', 'check-procedures/see-review-queue-open'],
  },
  'pharmacySop.branches': {
    gate: 'requireAnyCapability(sop:complete, sop:manage, sop:verify)',
    lines: [
      'do-procedures/see-which-branches-use',
      'set-up-procedures/see-which-branches-use',
      'check-procedures/see-which-branches-use',
    ],
  },
  'pharmacySop.claim': {
    gate: 'completeProcedure (sop:complete)',
    lines: ['do-procedures/start-claim-tick-off'],
  },
  'pharmacySop.completeStep': {
    gate: 'completeProcedure (sop:complete)',
    lines: ['do-procedures/start-claim-tick-off'],
  },
  'pharmacySop.createAssignment': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.enableSite': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.evidenceTarget': {
    gate: 'completeProcedure (sop:complete) + own in-progress work (authorizes a proof upload)',
    lines: ['do-procedures/start-claim-tick-off'],
  },
  'pharmacySop.generate': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.installLibrary': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.joinSite': {
    gate: 'requireAnyCapability(sop:complete, sop:verify, sop:manage)',
    lines: [
      'do-procedures/see-which-branches-use',
      'set-up-procedures/see-which-branches-use',
      'check-procedures/see-which-branches-use',
    ],
  },
  'pharmacySop.linkRecord': {
    gate: 'completeProcedure (sop:complete) + own in-progress work',
    lines: ['do-procedures/link-records-to-procedures'],
  },
  'pharmacySop.linkableRecords': {
    gate: 'completeProcedure (sop:complete) + occurrence visible',
    lines: ['do-procedures/link-records-to-procedures'],
  },
  'pharmacySop.occurrence': {
    gate: 'requireAnyCapability(sop:complete, sop:verify) + assertOccurrenceVisible (owner/claimer, pool role holder, verifier with sop:verify, or sop:manage)',
    lines: [
      'do-procedures/see-procedures-board-open',
      'check-procedures/see-review-queue-open',
      'set-up-procedures/do-check-procedure-checklists',
    ],
  },
  'pharmacySop.onDemandTemplates': {
    gate: 'completeProcedure (sop:complete) + held procedure role',
    lines: ['do-procedures/start-on-demand-procedures'],
  },
  'pharmacySop.overdueEscalation': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.reject': {
    gate: 'verifyProcedure (sop:verify) + independent verifier role at site; a qualified-person-only verifier also needs pharmacy:dispense',
    lines: [
      'check-procedures/approve-send-back-submitted',
      'dispense-prescriptions/check-procedure-tasks-others',
    ],
  },
  'pharmacySop.report': {
    gate: 'requireAnyCapability(sop:manage, sop:verify)',
    lines: [
      'set-up-procedures/view-procedures-compliance-report',
      'check-procedures/view-procedures-compliance-report',
    ],
  },
  'pharmacySop.roleHoldings': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.setAssignmentActive': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.setAutoSchedule': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.setOverdueEscalation': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.setRoleHolding': {
    gate: 'manageProcedure (sop:manage); never self-grant a verifier role; qualified-person target must hold pharmacy:dispense',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.siteSettings': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.start': {
    gate: 'completeProcedure (sop:complete)',
    lines: ['do-procedures/start-claim-tick-off'],
  },
  'pharmacySop.startOnDemand': {
    gate: 'completeProcedure (sop:complete) + held procedure role for an event-triggered pack',
    lines: ['do-procedures/start-on-demand-procedures'],
  },
  'pharmacySop.submit': {
    gate: 'completeProcedure (sop:complete)',
    lines: ['do-procedures/start-claim-tick-off'],
  },
  'pharmacySop.templates': {
    gate: 'manageProcedure (sop:manage)',
    lines: ['set-up-procedures/branches-view-change-procedure'],
  },
  'pharmacySop.verify': {
    gate: 'verifyProcedure (sop:verify) + independent verifier role at site; a qualified-person-only verifier also needs pharmacy:dispense',
    lines: [
      'check-procedures/approve-send-back-submitted',
      'dispense-prescriptions/check-procedure-tasks-others',
    ],
  },
  'pharmacyStagedReview.pharmacyMedicine.catalogueProducts': {
    gate: 'adminProcedure -> admin:access',
    none: 'the tenant medicine catalogue administration screen requires workspace admin access',
  },
  'pharmacyStagedReview.pharmacyMedicine.starterHistory': {
    gate: 'contextualCapabilityProcedure -> admin:access for administrators, pharmacy:catalogue-review for catalogue reviewers; tenant scope required',
    lines: ['review-catalogue/review-medicine-details'],
  },
  'pharmacyStagedReview.pharmacyMedicine.stageBatch': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit',
    none: 'preparing import files requires both workspace administrator and catalogue edit access',
  },
  'pharmacyStagedReview.pharmacyMedicine.stagedBatches': {
    gate: 'adminProcedure -> admin:access',
    none: 'the full staged import workbench is workspace administrator-only',
  },
  'pharmacyStagedReview.pharmacyMedicine.stagedBranches': {
    gate: 'adminProcedure -> admin:access',
    none: 'the full staged import workbench is workspace administrator-only',
  },
  'pharmacyStagedReview.pharmacyMedicine.stagedDetail': {
    gate: 'adminProcedure -> admin:access',
    none: 'the full staged import workbench is workspace administrator-only',
  },
  'pharmacyStagedReview.pharmacyMedicine.stagedRows': {
    gate: 'adminProcedure -> admin:access',
    none: 'the full staged import workbench is workspace administrator-only',
  },
  'pharmacyStagedReview.pharmacyMedicine.stagingUpload': {
    gate: 'catalogueEditProcedure -> admin:access AND pharmacy:catalogue-edit',
    none: 'preparing import files requires both workspace administrator and catalogue edit access',
  },
  'pharmacySupplierCompliance.history': {
    gate: 'auditedProtectedProcedure + supplierPolicyAuthority: tenant owner or ADMIN, AND can(pharmacy:manage); no support session',
    lines: ['run-branches/supplier-compliance-history'],
  },
  'pharmacySupplierCompliance.policy': {
    gate: 'protectedProcedure (any signed-in member, module gate)',
    none: 'any signed-in member can read whether supplier checks are on',
  },
  'pharmacySupplierCompliance.setPolicy': {
    gate: 'protectedProcedure + supplierPolicyAuthority: tenant owner or ADMIN, AND can(pharmacy:manage); no support session',
    lines: ['run-branches/owner-workspace-administrator-turn'],
  },
  'pharmacySupplierCompliance.skips': {
    gate: 'auditedProtectedProcedure + assertCanReadEvidence: (owner/ADMIN with pharmacy:manage) OR actorCanProcure (pharmacy:procurement)',
    lines: ['run-branches/supplier-compliance-history', 'receive-stock/supplier-check-skips'],
  },
  'pharmacySupplierLinks.approveProposal': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/link-suppliers-branch-issue'],
  },
  'pharmacySupplierLinks.createRelationship': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/link-suppliers-branch-issue'],
  },
  'pharmacySupplierLinks.get': {
    gate: 'publicProcedure (supplier link token)',
    none: 'public supplier response link: the supplier opens it with the link token, no staff permission involved',
  },
  'pharmacySupplierLinks.issue': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/link-suppliers-branch-issue'],
  },
  'pharmacySupplierLinks.recordManual': {
    gate: 'meta PROCUREMENT -> pharmacy:procurement (assigned branch)',
    lines: ['receive-stock/link-suppliers-branch-issue'],
  },
  'pharmacySupplierLinks.revoke': {
    gate: "meta PROCUREMENT -> pharmacy:procurement (link's branch assigned)",
    lines: ['receive-stock/revoke-supplier-links'],
  },
  'pharmacySupplierLinks.submit': {
    gate: 'publicProcedure (supplier link token)',
    none: 'public supplier response link: the supplier submits with the link token, no staff permission involved',
  },
  'pharmacySupplierLinks.uploadDocument': {
    gate: 'publicProcedure (supplier link token)',
    none: 'public supplier response link: the supplier uploads with the link token, no staff permission involved',
  },
  'pharmacySupplierPriceLists.decide': {
    gate: 'meta PRICE_LIST_APPROVAL -> admin:access; importer cannot approve own list unless solo owner with approval code',
    none: 'workspace administrators only (admin:access)',
  },
  'pharmacySupplierPriceLists.import': {
    gate: 'meta PRICE_LIST_PROCUREMENT -> pharmacy:procurement (tenant-wide)',
    lines: ['receive-stock/import-supplier-price-lists'],
  },
  'pharmacySupplierPriceLists.list': {
    gate: 'meta PRICE_LIST_PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/import-supplier-price-lists'],
  },
  'pharmacySupplierPriceLists.options': {
    gate: 'meta PRICE_LIST_PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/import-supplier-price-lists'],
  },
  'pharmacySupplierPriceLists.review': {
    gate: 'meta PRICE_LIST_PROCUREMENT -> pharmacy:procurement',
    lines: ['receive-stock/import-supplier-price-lists'],
  },
};
