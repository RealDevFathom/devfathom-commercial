import { formatWorkspaceDateTime } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { formatMinor } from './counter-receipt';

/** Display copy only. Keys can be translated without changing report contracts or permissions. */
export const PHARMACY_COPY = {
  details: 'Details',
  calculation: 'How is this calculated?',
  reportsDescription: 'Sales, stock and accounts for your shop.',
  allBranches: 'All branches',
  selectedBranch: 'Selected branch',
  unavailable: 'Unavailable',
  currencyUnconfirmed: 'currency not confirmed',
  workPack: {
    title: 'Daily work pack',
    checkNote1:
      'Latest stock alerts for all staff; due dates checked at the time shown. Selected dates do not apply.',
    checkNote2:
      'Your saved stock alerts: overdue, due in the next 24 hours, needing a new check or reminders resuming. Selected dates do not apply.',
    checkNote3: 'Saved money checks for the selected dates; these checks have not been run again.',
    checkNote4:
      'Available stock not yet expired, compared with sales from the last 30 days. Selected dates do not apply.',
    checkNote5:
      'Latest supplier claims, credits and returns; ages and send-by dates checked at the time shown. Selected dates do not apply.',
    checkNote6:
      'This digest shows your alerts only. Alerts due later or still postponed are excluded. Some also appear on the stock dashboard.',
    checkNote7: 'Some stock information is missing.',
    checkNote8: 'This alert needs a new check. Confirm the stock before acting.',
    checkNote9: 'This money check is old. Confirm the records before acting.',
    checkNote10: 'This record includes information added after the selected check time.',
    loading: 'Checking your records. Other reports are still available.',
    failed:
      'Daily work pack could not load. Refresh to try again, or ask your administrator to check your access.',
    refresh: 'Refresh daily work pack',
    retry: 'Retry daily work pack',
    preparation: 'Things to check today',
    prepared: 'How this list was prepared',
    moneyHidden: 'Money-related checks are not shown for your role.',
    explanation:
      'This list only reads your records; it does not change stock or create drafts. Supplier, ingredient and batch filters do not apply. Amounts are shown to two decimal places; a dash means the figure was not available, not zero.',
    nothing: 'Nothing to act on from these checks.',
    partialEmpty: 'Nothing to do from the checks that loaded.',
    nothingToActOn: 'Nothing to act on',
    reviewItems: 'Items to review',
    checked: 'Checked',
    couldNotCheck: "Couldn't check — records or access are unavailable. Refresh to try again.",
    incomplete: 'The latest check may not include every item.',
    sourceNames: {
      'stock-dashboard': 'Stock dashboard',
      'stock-digest': 'Your stock digest',
      anomalies: 'Money checks',
      expiry: 'Expiry advice',
      'supplier-credit': 'Supplier credit',
    },
    titles: {
      'inventory-review': 'Check stock and expiry',
      'anomaly-review': 'Check unusual payments and amounts',
      'supplier-credit-review': 'Follow up supplier claims and returns',
    },
    results: {
      'inventory-review': 'Stock or expiry needs your attention.',
      'anomaly-review': 'Some payments or amounts need a check.',
      'supplier-credit-review': 'Supplier claims or returns need follow-up.',
    },
    actions: {
      'inventory-review': 'Review stock',
      'anomaly-review': 'Review money checks',
      'supplier-credit-review': 'Review supplier returns',
    },
    completeness:
      'Checks can overlap. Figures are estimates or recorded values, not savings to add together. An empty list does not mean every item was checked.',
    savedCheck: 'Saved checks may not reflect the latest records.',
    currentCheck: 'These are current records, not records saved for an earlier date.',
    expiryFailureDetail:
      'No stock or supplier-return data was changed. Expiry risk has not been assessed.',
    emptyCheck: 'No items were returned by this check; other items may still need attention.',
    failedCheck: 'This check could not load. Refresh or open the report to try again.',
    expiryFailure:
      'Expiry advice could not load; refresh to try again.',
  },
  account: {
    exportCsv: 'Download CSV',
    amountUnconfirmed: 'Amount unavailable (currency not confirmed)',
    noTotals: 'No account totals found',
    totalsMismatch: 'These totals do not match',
    allZero: 'All supplied amounts are zero',
    totalsChecked: 'Totals checked',
    chequeStates: {
      PDC: 'Post-dated',
      CLEARED: 'Cleared',
      BOUNCED: 'Bounced',
      REVERSED: 'Reversed',
      UNKNOWN: 'Not confirmed',
    },
    cashFlowClasses: {
      OPERATING: 'Day-to-day trade',
      INVESTING: 'Assets',
      FINANCING: 'Funding',
      UNCLASSIFIED: 'Needs a category',
    },
  },
  tender: {
    balance: 'Balance due',
    payments: 'Recorded payments',
    nextPayment: 'Payment',
    remaining: 'Remaining after this payment',
    cashShort: 'Cash received is less than the payment amount.',
    locked: 'Payment locked',
  },
  owner: {
    currentStock:
      'Stock figures show the latest records; sales and money figures use the selected dates.',
    amountNote: 'Amounts use two decimal places. A dash means unavailable, not zero.',
    currencyNote:
      'The currency is your current shop setting; older payments may use a different currency.',
    noCurrency: 'The currency could not be confirmed.',
    short: 'short',
    over: 'over',
    balanced: 'Balanced',
    noClose: 'Not computed · no final day close in period',
  },
} as const;

/** Format an instant for display without changing its filtering or business-day meaning. */
export function formatShopTime(
  value: string | Date | null | undefined,
  timeZone = 'Asia/Karachi',
  now = new Date()
): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return PHARMACY_COPY.unavailable;
  const formatted = formatWorkspaceDateTime(value, timeZone);
  if (pharmacyCalendarDay(timeZone, new Date(value)) !== pharmacyCalendarDay(timeZone, now)) return formatted;
  return `Today ${formatted.split(', ')[1]}`;
}

/** Calendar date labels deliberately keep the report's selected dates, not shifted instants. */
export function formatShopPeriod(from: string, to: string): string {
  const label = (value: string) => {
    const date = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(date.getTime())) return PHARMACY_COPY.unavailable;
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(from.slice(0, 4) !== to.slice(0, 4) ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    }).format(date);
  };
  return from === to ? label(from) : `${label(from)} – ${label(to)}`;
}

export function cashVarianceLabel(value: number | null, currency: string | null): string {
  if (value === null || !Number.isSafeInteger(value)) return '—';
  if (value === 0) return PHARMACY_COPY.owner.balanced;
  const amount = formatMinor(Math.abs(value))
    .replace(/\B(?=(\d{3})+\.)/g, ',')
    .replace(/\.00$/, '');
  const prefix = currency ? `${currency} ` : '';
  return `${prefix}${amount}${currency ? '' : ` (${PHARMACY_COPY.currencyUnconfirmed})`} ${value < 0 ? PHARMACY_COPY.owner.short : PHARMACY_COPY.owner.over}`;
}

const WORK_PACK_STATES: Readonly<Record<string, string>> = {
  RECORDED: 'Recorded',
  OPEN: 'Open',
  ACKNOWLEDGED: 'Seen',
  SNOOZED: 'Postponed',
  STALE: 'Needs a new check',
  CLOSED: 'Closed',
  AT_RISK: 'Needs review',
  RETURNABLE: 'Can be returned',
  INSUFFICIENT_HISTORY: 'Not enough sales history',
  OUTSTANDING: 'Still due',
  overdue: 'Overdue',
  due: 'Due',
  upcoming: 'Due soon',
  unknown: 'Not confirmed',
  ready: 'Ready',
  blocked: 'Needs review',
};

export function workPackStateLabel(state: string): string {
  return WORK_PACK_STATES[state] ?? 'Needs review';
}

// Existing report-copy API retained while the remaining screens adopt keyed copy.
/**
 * Plain-language copy for the reports overview and Daily work pack.
 * Every sentence lives under a key so a translation (Urdu) can replace the
 * English text without touching the screens.
 */
export const plainCopy = {
  'workPack.badge.partial': 'Some information is missing',
  'workPack.badge.unknown': 'Not everything was checked',
  'workPack.details': 'Details',
  'workPack.refresh': 'Refresh daily work pack',
  'workPack.refreshNote':
    'Refresh reads the latest saved records. It does not create drafts or change any stock or money.',
  'workPack.amountNote':
    'Amounts are shown to two decimal places. The currency of these source records is not confirmed. A dash means the amount is not available, not zero.',
  'workPack.noResult':
    'Nothing needs review from the sources we could read. This does not mean everything is fine; open Details to see what was missing.',
  'workPack.sourcesHeading': 'Where this came from',
  'workPack.title': 'Daily work pack',
  'workPack.eyebrow': 'Today',
  'workPack.retry': 'Try again',
  'workPack.loading': 'Getting your daily work pack. Other reports are still available.',
  'workPack.failed':
    'The daily work pack could not load. Try again, or ask your administrator to check your access. Nothing was changed.',
  'workPack.noMoney': 'Money sources were not read for your role.',
  'workPack.notAvailable': 'Not available',
  'workPack.seen': 'Seen',
  'workPack.workedOut': 'Worked out',
  'workPack.dueOrExpires': 'Due or expires',
  'workPack.recordsRead': 'Records read',
  'workPack.checked': 'Checked',
  'workPack.limitReached': 'Only the first records were read; some may be left out.',
  'workPack.savedRecords': 'Saved records; may be out of date.',
  'workPack.currentRecords': 'Current records.',
  'workPack.couldNotLoad': 'Could not load',
  'workPack.noEligibleStock': 'No eligible stock',
  'workPack.adviceReady': 'Advice ready',
  'workPack.currencyUnverified': 'currency not confirmed',
  'workPack.updated': 'Updated',
  'workPack.periodNote':
    'Each source below keeps its own dates. Supplier, ingredient and batch filters do not apply here. These are current records, not a past snapshot.',
  'overview.outOfDate': 'Out of date',
  'overview.currencyKnown': "Amounts are in {currency}, your pharmacy's current currency setting.",
  'overview.currencyUnknown': 'Amounts have no currency because your pharmacy has not set one.',
  'overview.title': 'Reports',
  'overview.description': 'Your pharmacy figures for the dates and branch you choose.',
  'wp.title.supplier': 'Review supplier claims and deliveries',
  'wp.title.inventory': 'Review stock alerts',
  'wp.title.anomaly': 'Review unusual money records',
  'wp.completeness':
    'These groups are not separate problems; the same item can appear in more than one. Amounts are what was recorded, not savings you can add up. An empty list does not prove everything is fine.',
  'wp.savedNote': 'These are saved records and may not be fully up to date.',
  'wp.currentNote': 'These are current records, not a snapshot of the past.',
  'wp.capReached': 'Only the first 200 records were read; some may be left out.',
  'wp.capIncomplete': 'Only the first 200 records are read, so the list may be incomplete.',
  'wp.noneReturned': 'Nothing was returned; this is not an all-clear result.',
  'wp.dashboardBasis': 'Current stock alerts across all owners. The chosen dates do not apply.',
  'wp.digestBasis': 'Current stock alerts assigned to you only. The chosen dates do not apply.',
  'wp.staleRecord': 'This saved record is out of date; check the original facts.',
  'wp.afterAsOf': 'This record was updated after the time you are viewing.',
  'overview.details': 'Details',
  'overview.allBranches': 'All branches',
  'overview.updated': 'Updated',
  'overview.shortPrefix': 'PKR',
  'overview.detailsBody':
    'Sales, margin, cash, cash variance and refunds cover the selected dates. Stock alerts, recommended orders and expiry value are as of now; expiry value is not a loss yet. Margin is not cash. Margin comes from the same accounting entries as Finance, including returns and reversals, by posting date, so it can differ from sales by business date. Missing entries show as a dash. Supplier, ingredient and batch filters narrow sales, margin and stock figures. Cash, cash variance and refunds show a dash when those filters are used. The daily work pack and observed demand use branch and date filters only.',
} as const;

/** English catalog for the shop-language sweep; stable keys keep display copy ready for translation. */
export const SHOP_SCREEN_COPY = {
  dateWindow: {
    from: 'From',
    toExclusive: 'To, exclusive',
    scopeAndPeriod: 'Scope and period',
  },
  reports: {
    pharmacyOperations: 'Pharmacy operations',
    reports: 'Reports',
    reportsUnavailable: 'Reports unavailable',
    subReports: 'Sub-reports',
    replenishment: 'Replenishment',
    repeatPurchasing: 'Repeat purchasing',
    supplierCreditFollowUp: 'Supplier-credit follow-up',
    compareBranches: 'Compare branches',
    reportFilters: 'Report filters',
    branch: 'Branch',
    allAvailable: 'All available',
    supplier: 'Supplier',
    allSuppliers: 'All suppliers',
    selectedSupplierUnavailable: 'Selected supplier unavailable',
    supplierNamesCouldNotLoadApplyFiltersAgain:
      'Supplier names could not load. Apply filters again to retry.',
    ingredientId: 'Ingredient ID',
    batchId: 'Batch ID',
    from: 'From',
    to: 'To',
    applyFilters: 'Apply filters',
    dailyWorkPackUnavailable: 'Daily work pack unavailable',
    enterValidDatesWithFromOnOrBefore:
      'Enter valid dates with From on or before To. No report was loaded.',
    reportCouldNotLoad: 'Report could not load',
    updated: 'Updated ',
    salesDetail: 'Sales detail',
    salesAndMarginForTheSelectedPeriod: 'Sales and margin for the selected period',
    reportPeriod: 'Report period: ',
    to2: ' to ',
    inclusiveBusinessDatesBranchScope: ' (inclusive business dates). Branch scope:',
    meansUnavailableNotZero: '. — means unavailable, not zero.',
    backToOverview: 'Back to overview',
    ownerCommandCentre: 'Owner command centre',
    selectedPeriodAtAGlance: 'Selected period at a glance',
    amountsUseThePharmacyMinorUnitScaleShown:
      'Amounts are shown to two decimal places. — means unavailable, not zero. Sales, gross margin, cash, cash variance and refunds cover the selected period. Stock signals, recommended orders and expiry exposure are current snapshots; expiry exposure is not realized loss. Gross margin is not cash flow. Gross margin uses the same exact posted journal as Finance, including returns and reversals, on postings from the start of the first selected date to the start of the day after the last, in ',
    financeAposSMarginComparisonSplitsDaysTheSameWay:
      ". Finance's margin comparison splits days the same way. It may differ from sales grouped by business date. Missing journal evidence is unavailable; posted totals do not establish complete source or cost coverage. Supplier, ingredient and batch filters narrow sales, gross margin, stock signals, recommended orders and expiry exposure to the matching stock lots and products. Cash, cash variance and refunds cannot be traced to a supplier, ingredient or batch, so they show — while one is selected. The daily work pack and observed demand use branch/date scope only.",
    theSelectedBranchDoesNotApplyToThis:
      'The selected branch does not apply to this queue. Date, supplier, ingredient and batch filters do not apply either. Unsigned pharmacist review items plus open controlled-register incidents, from pharmacist review and controlled-register records at read time.',
    advisoryOnly: 'Advisory only',
    expiryAndSupplierReturnAdvisor: 'Expiry and supplier-return advisor',
    rankedByProjectedStockValueLeftAtExpiry:
      "Ranked by projected stock value left at expiry, using only each branch's recent completed dispensing and sales. Draft proposals do not reserve, move, quarantine, write off, or return stock; a human must review and submit them. Supplier, ingredient and batch filters narrow the lots listed.",
    draftExpiryClaimCreatedForHumanReview: 'Draft expiry claim created for human review.',
    theDraftCouldNotBeCreatedEligibilityOr:
      'The draft could not be created. Eligibility or access may have changed.',
    batch: 'Batch: ',
    onHand: 'On hand: ',
    units: ' units',
    valueAtRisk: 'Value at risk:',
    supplier2: 'Supplier: ',
    createDraftProposal: 'Create draft proposal',
    noFutureExpiryLotsWithAvailableStockMatch:
      'No future-expiry lots with available stock match this scope.',
    couldNotLoad: 'Could not load',
    expiryAdviceCouldNotLoadApplyTheFilters:
      'Expiry advice could not load. Apply the filters again to retry. No stock or supplier-return data was changed.',
    ownerOnly: 'Owner only',
    financialReportAndOwnerPermissionsAreRequiredTo:
      'Financial report and owner permissions are required to view value-at-risk advice.',
    reviewOnly: 'Review only',
    anomalyReviewSignals: 'Anomaly review signals',
    refreshSignals: 'Refresh signals',
    deterministicEventChecksOnlySignalsNeverRankStaff:
      'Deterministic event checks only. Signals never rank staff, imply misconduct, or create orders, stock movements, price changes, or finance postings. A human opens and reviews the source records.',
    anomalySignalStateUpdated: 'Anomaly signal state updated.',
    theAnomalyActionCouldNotBeCompletedCheck:
      'The anomaly action could not be completed. Check the reason, date, and access.',
    scope: 'Scope ·',
    window: 'Window ',
    sourceObserved: ' · source observed',
    policy: ' · policy',
    staffDrillDown: 'Staff drill-down · ',
    openRelatedAuditTrail: 'Open related audit trail',
    relatedAuditTrailRequiresAnAdministrator: 'Related audit trail requires an administrator.',
    estimateMethod: 'Estimate method:',
    window2: 'Window: ',
    exclusions: 'Exclusions:',
    confidence: 'Confidence:',
    acknowledgementReason: 'Acknowledgement reason',
    acknowledge: 'Acknowledge',
    snoozeUntil: 'Snooze until',
    snoozeReason: 'Snooze reason',
    snoozeWithReason: 'Snooze with reason',
    refreshSourceDataBeforeReviewingThisSignal: 'Refresh source data before reviewing this signal.',
    noAnomalySignalsMatchTheseFiltersRefreshTo:
      'No anomaly signals match these filters. Refresh to evaluate the current ledger window; no operational data will be changed.',
    financialReportAndOwnerPermissionsAreRequiredTo2:
      'Financial report and owner permissions are required to view anomaly records.',
    safe05Advisory: 'SAFE-05 · Advisory',
    packAuthenticationFlags: 'Pack authentication flags',
    receivingAndDispensingScansCompareGtinBatchExpiry:
      'Receiving and dispensing scans compare GTIN, batch, expiry, and serial evidence with this workspace. An unverifiable pack is never labelled counterfeit and never blocks a sale by itself. Recalled batches remain blocked by the recall path. Ingredient and batch filters narrow flags to scans matched to that medicine or batch.',
    authenticationFlagAcknowledged: 'Authentication flag acknowledged.',
    theFlagCouldNotBeAcknowledgedCheckThe:
      'The flag could not be acknowledged. Check the reason and access.',
    scan: ' scan',
    gtin: 'GTIN ',
    batch2: ' · batch',
    serial: ' · serial',
    acknowledged: 'Acknowledged: ',
    acknowledgeFlag: 'Acknowledge flag',
    noPackAuthenticationFlagsMatchTheseBranches:
      'No pack authentication flags match these branches.',
    reportCatalog: 'Report catalog',
    availableReports: 'Available reports',
    metricContractsFilters: ' metric contracts · filters: ',
    sourceLabel: 'Source: ',
    scope2: 'Scope: ',
    access: 'Access: ',
    drillThrough: 'Drill through',
    drillThroughUnavailable: 'Drill-through unavailable',
    scheduledDelivery: 'Scheduled delivery',
    dailyOwnerDigest: 'Daily owner digest',
    optInPerBranchTimesUseYourWorkspace:
      'Opt in per branch. Times use your workspace timezone. Capture history is always stored; WhatsApp remains disabled until a provider integration is implemented.',
    eachDigestOpensWithAFiveLineBriefing:
      'Each digest opens with a five-line briefing: sales and cash, estimated lost demand and walk-outs, the top gap with its purchase status, recovered sales, and expiry at risk with khata due. A seven-day summary is added once a week. Item names for the top gap appear only here; the owner WhatsApp version carries figures only.',
    digestSettingsSaved: 'Digest settings saved.',
    digestSettingsCouldNotBeSavedCheckThe:
      'Digest settings could not be saved. Check the time and try again.',
    digestTime: 'Digest time',
    whatsapp: 'WhatsApp',
    capturedDelivery: 'Captured delivery',
    digestHistory: 'Digest history',
    noDigestsCapturedYetTurnOnABranch:
      'No digests captured yet. Turn on a branch digest; history appears after its scheduled time.',
    digestSettingsAndHistoryRequireOwnerPermissionReports:
      'Digest settings and history require owner permission. Reports remain available on demand.',
    noReportableBranches: 'No reportable branches',
    pharmacyReports: 'Pharmacy reports',
    sales: 'Sales',
    grossMargin: 'Gross margin',
    cash: 'Cash',
    cashVariance: 'Cash variance',
    refunds: 'Refunds',
    stockAlerts: 'Stock alerts',
    recommendedOrders: 'Recommended orders',
    expiringIn30Days: 'Expiring in 30 days',
    expiringIn90Days: 'Expiring in 90 days',
    selectAnAvailableBranchScopeAndAValid:
      'Select an available branch scope and a valid, unambiguous date range. No work-pack sources were queried.',
    checkTheDateRangeAndBranchScopeThen:
      'Check the date range and branch scope, then apply the filters again. No data was changed.',
    organizationWideSafetyQueue: 'Organization-wide safety queue',
    allBranchesLatestRecords: 'All branches · latest records',
    packScansRecordTheMedicineAndBatchThey:
      'Pack scans record the medicine and batch they matched, not the supplier, so these flags cannot be filtered by supplier. Clear the supplier filter to review them.',
    anActivePharmacyBranchIsRequiredBeforeReports:
      'An active pharmacy branch is required before reports can be shown. Ask your workspace administrator to activate one.',
  },
  workPack: {
    couldNotCheck: 'Could not check ',
    justNowRefreshToTryAgainTheRest:
      ' just now. Refresh to try again; the rest of this list is still good to use.',
    period: 'Period: ',
    branches: '. Branches:',
    preparedAt: 'Prepared at ',
    sourceLabel: 'Source:',
    observed: 'Observed: ',
    computed: '. Computed:',
    secondsSinceLastCheck: '. Allowed age of this check (seconds):',
    endNotIncluded: ' (end not included)',
    selectedDatesNotApplied: 'Selected dates do not apply',
    limitReached: 'The check reached its limit; more items may exist.',
    dueOrExpiryTime: '. Due or expiry time:',
    whatWasChecked: 'What was checked',
    noAvailableUnexpiredStockWasFoundForExpiry:
      'No available, unexpired stock was found for expiry advice in this branch. This does not assess expired or quarantined stock. Refresh daily work pack after stock is received or updated.',
    itemsReturned: 'Items returned: ',
    maximumItems: '. Maximum items:',
    window: 'Window:',
    evaluatedAsOf: '. Evaluated as of: ',
    readAt: '. Read at: ',
    lastCheck: '. Last check:',
  },
  branchComparison: {
    ownerOnly: 'Owner only',
    branchComparison: 'Branch comparison',
    compareSalesMarginRecordedLostDemandEstimatesExpiry:
      'Compare sales, margin, recorded lost-demand estimates, expiry exposure and overdue khata across active branches.',
    comparisonDates: 'Comparison dates',
    branchComparisonDates: 'Branch comparison dates',
    from: 'From',
    to: 'To',
    applyDates: 'Apply dates',
    comparisonUnavailable: 'Comparison unavailable',
    branchPerformance: 'Branch performance',
    to2: ' to ',
    inclusive: ', inclusive.',
    moneyUsesMinorUnitValuesShownToTwo:
      'Money is shown to two decimal places; — means unavailable, not zero. Expiry at risk is available stock expiring in 30 days and is not realized loss. Lost demand is an ',
    estimate: 'Estimate',
    excludes: ' Excludes',
    branch: 'Branch',
    sales: 'Sales',
    margin: 'Margin',
    lostDemandEstimate: 'Lost demand estimate',
    expiryAtRisk: 'Expiry at risk',
    khataOverdue: 'Khata overdue',
    events: ' events)',
    noActiveBranchesAreAvailable: 'No active branches are available.',
    branchComparisonPharmacyReports: 'Branch comparison · Pharmacy reports',
  },
  marginComparison: {
    previous: 'Previous: ',
    to: ' to',
    current: '. Current:',
    periodsAreStartInclusiveEndExclusiveSameBranch:
      '. Periods are start inclusive, end exclusive. Same branch, equal elapsed duration.',
    noMatchingPostedJournalGroupsIn: 'No matching sales entries in',
    ledgerTotalsAreZeroForThatPeriodThis:
      '. Ledger totals are zero for that period; this does not prove complete source data.',
    accountingDecompositionCurrencyNotConfirmedPostedRevenueDiscounts:
      'Accounting decomposition · currency not confirmed · posted revenue, discounts and cost of goods, including reversals and returns.',
    account: 'Account',
    previous2: 'Previous',
    current2: 'Current',
    effectOnGrossMargin: 'Effect on gross margin',
    revenueDelta: 'Revenue delta ',
    minusDiscountDelta: ' minus discount delta',
    minusCogsDelta: ' minus COGS delta ',
    grossMarginChange: ' gross-margin change.',
    accountingDecompositionNotACausalPriceVolumeMix:
      'Accounting decomposition, not a causal price/volume/mix explanation. Quantity, unit-price, unit-cost and expense evidence is not provided here; missing evidence is not zero. Gross margin is not net profit or contribution. Percentage change is omitted, including when the previous margin is zero or negative.',
    grossMarginComparison: 'Gross-margin comparison',
    marginChanges: 'Margin changes',
    branch: 'Branch: ',
    compareUpTo92DaysWithTheImmediately:
      '. Compare up to 92 days with the immediately preceding equal-length period.',
    // Picked dates start at the workspace's midnight; the zone label follows.
    fromMidnight: 'From (midnight, ',
    untilMidnight: 'Until (midnight, ',
    closeZone: ')',
    closeZoneNotIncluded: ', not included)',
    comparePeriods: 'Compare periods',
  },
  cashFlow: {
    pharmacyAccounts: 'Pharmacy accounts',
    cashFlow: 'Cash flow',
    cashComingInAndGoingOutGroupedBy: 'Cash coming in and going out, grouped by purpose.',
    branchAndDates: 'Branch and dates',
    activeBranch: 'Active branch',
    noActiveBranchesAvailable: 'No active branches available',
    showCashFlow: 'Show cash flow',
    projectionUnavailable: 'Projection unavailable',
    noFinancialDataIsShown: ' No financial data is shown.',
    openingAndClosingCash: 'Opening and closing cash',
    recordedCurrencyMinorUnitTotalsFromEveryScoped:
      'Recorded currency totals from every scoped posted cash/bank line. Retrieved',
    completenessUnknown: '. Completeness: unknown —',
    discrepancyIsCanonicalCashPlusBankAccountClosing:
      ' Discrepancy is canonical CASH plus BANK account closing from the financial statements, read in the same snapshot, minus the projected closing.',
    noScopedCashPostingsThisDoesNotProve:
      'No cash movements were found for these dates. Other activity may be missing.',
    paymentsAndReversals: 'Cash movements',
    classificationRequiresSupportedSourceAndCounterpartEvidenceAmbiguous:
      'Classification requires supported source and counterpart evidence. Ambiguous, mixed, and future policies remain unclassified; this is not a statutory or audited statement.',
    showing: 'Showing ',
    of: ' of ',
    cashMovingEntriesTotalsAboveIncludeEveryEntry:
      'cash-moving entries; totals above include every entry in the period.',
    entry: 'Entry ',
    sourceLabel: ' · source ',
    classificationJournalLines: 'Classification journal lines',
    evidencePages: 'Cash movement pages',
    previousEvidence: 'Previous cash movements',
    nextEvidence: 'Next cash movements',
  },
  journalExport: {
    pharmacyAccounts: 'Pharmacy / accounts',
    journalEvidenceExport: 'Download account entries',
    downloadTheEntriesOnOnePageForThe: 'Download the entries on one page for the selected branch.',
    evidenceCouldNotBeRead: 'Entries could not load',
    accessCouldNotBeVerifiedNoCsvIs:
      'Access could not be verified. No CSV is available; retry or ask your workspace administrator.',
    permissionRequired: 'Permission required',
    ownerFinancialReportPermissionAndPharmacyReportsAccess:
      'Owner financial-report permission and Pharmacy Reports access are required. No CSV is available.',
    downloadTheEntriesOnThisPageOtherEntries:
      'Download the entries on this page. Other entries are not included.',
    evidenceWindow: 'Branch and dates',
    branch: 'Branch',
    chooseABranch: 'Choose a branch',
    // Picked dates start at the workspace's midnight; the zone label follows.
    fromMidnight: 'From (midnight, ',
    untilMidnight: 'Until (midnight, ',
    closeZone: ')',
    closeZoneNotIncluded: ', not included)',
    page: 'Page',
    readAuthorizedPage: 'Read authorized page',
    chooseAValidEvidenceWindow: 'Choose valid dates',
    chooseAnAuthorizedBranchAUtcDateWindow:
      'Choose an authorized branch, a date window of at most 92 days, and a page from 1 to 10,000. Invalid input is not read or exported.',
    accessMayBeDeniedOrTheReadFailed:
      'Access may be denied or the read failed. No CSV is available; retry or ask your workspace administrator.',
    entriesOnThisPage: 'Entries on this page',
    otherActivityMayNotBeIncluded: '· Other activity may not be included',
    page2: 'Page ',
    entriesReturnedPageCap: ' entries returned · page cap',
    entriesCountedInTheWindow: ' entries counted in the window.',
    theCsvContainsOnlyThisPageDtoIt:
      'The CSV contains only this page DTO. It is not a complete-ledger export, is not an atomic snapshot, and cannot establish unposted activity. Entry currency, source and reversal IDs, and exact amounts as whole numbers of the smallest currency unit are retained.',
    journalEvidenceExportPharmacyAccounts: 'Download account entries · Pharmacy accounts',
  },
  accountActivity: {
    permissionRequired: 'Permission required',
    organizationAdministratorAccessIsRequired: 'Organization administrator access is required.',
    invalidFilters: 'Invalid filters',
    chooseOneValueForEachFilter: 'Choose one value for each filter.',
    branchUnavailable: 'Branch unavailable',
    chooseAnActiveBranchInThisOrganization: 'Choose an active branch in this organization.',
    noActiveBranch: 'No active branch',
    createAnActivePharmacyBranchFirst: 'Create an active pharmacy branch first.',
    invalidDateWindow: 'Invalid date window',
    chooseAValidUtcDateWindowWithAn: 'Choose a valid date window with an exclusive end.',
    chooseADateWindowOfAtMost92: 'Choose a date window of at most 92 days.',
    pharmacyAccounts: 'Pharmacy accounts',
    accountActivityBridge: 'Account activity',
    isolateOnePostedAccountAndRecordedCurrencyFrom:
      'Isolate one posted account and recorded currency from financial-statement aggregates.',
    chooseAnAccount: 'Choose an account',
    branch: 'Branch',
    accountCurrency: 'Account / currency',
    chooseAnAccountCurrency: 'Choose an account / currency',
    readBridge: 'Read bridge',
    accountTotals: 'Account totals',
    noUniqueCompleteAggregateMatchesThisAccountAnd:
      'No unique, complete aggregate matches this account and recorded currency. Missing values are not treated as zero.',
    postedCoverageIsUnknownThisEvidenceIsNot:
      'Posted coverage is unknown. This evidence is not a running ledger, trial balance, maturity report, statement, or wallet view.',
    minorUnits: ' (smallest currency unit)',
    openingBalanceMoneyInAndOutAndClosing:
      'Opening balance, money in and out, and closing balance for one account.',
  },
  cheques: {
    pharmacyAccounts: 'Pharmacy accounts',
    recordedChequeMaturity: 'Cheques due',
    seeWhenYourRecordedChequesAreDue: 'See when your recorded cheques are due.',
    financialReportAccessRequired: 'Financial report access required',
    ownerFinancialReportCapabilityPharmacyReportsAndExisting:
      'Owner financial-report capability, Pharmacy Reports, and existing Finance workspace authorization are required. No cheque evidence was read.',
    branch: 'Branch',
    authorizedActiveBranch: 'Authorized active branch',
    selectABranch: 'Select a branch',
    showCheques: 'Show cheques',
    branchUnavailable: 'Branch unavailable',
    selectAnAuthorizedActiveBranchNoOutOf:
      'Select an authorized active branch. No out-of-scope evidence was read.',
    chooseABranch: 'Choose a branch',
    thisIsolatedReadNeverCombinesBranchChequeRecords:
      'This isolated read never combines branch cheque records.',
    chequeEvidenceUnavailable: 'Cheques could not load',
    theLiveFinanceWorkspaceReadFailedNoCached:
      'The live Finance workspace read failed. No cached data is shown and no financial record was changed.',
    aboutThisList: 'About this list',
    latestRecordedChequesTheListMayBeIncomplete:
      'Latest recorded cheques; the list may be incomplete.',
    recordedChequesRetainedFromTheLatestWorkspaceResponse:
      ' recorded cheques retained from the latest workspace response. Empty does not prove no cheques; exactly 50 means the read cap was reached. Dates use UTC. This does not infer contractual AP maturity, perform BANK deductions, repair postings, or establish historical currency.',
    noRecordedChequesInThisRead: 'No recorded cheques in this read',
    theRecentCappedLiveResponseContainedNoSafe:
      'No cheques were found in the latest records. Other cheques may still be missing from this list.',
    unknownRecordedDueDate: 'Unknown recorded due date',
    theseChequeRecordsHaveNoUsableRecordedMaturity:
      'These cheque records have no usable recorded maturity date; no date was inferred.',
    dueDateUtc: 'Due date',
    reference: 'Reference',
    cheque: 'Cheque',
    status: 'Status',
    recordedAmount: 'Recorded amount',
    recordedChequeMaturityPharmacyAccounts: 'Recorded cheque maturity · Pharmacy accounts',
  },
  marketing: {
    campaignResults: 'Campaign results',
    reviewCampaigns: 'Review campaigns',
    campaignResultsUnavailableForThisDateBranchOr:
      'Campaign results unavailable for this date, branch or permission scope. No zero totals inferred.',
    evidenceCutoff: '); evidence cutoff',
    branchAndDateFiltersApplySupplierIngredientAnd:
      '. Branch and date filters apply. Supplier, ingredient and batch filters do not scope these figures.',
    sandboxOnly: 'Sandbox only: ',
    captures: ' captures, ',
    delivered: ' delivered,',
    failed: ' failed, ',
    unknownTheseCountsDoNotProveLiveDelivery: ' unknown. These counts do not prove live delivery.',
    excludedUnverifiedLinks: 'Excluded unverified links: ',
    competingReceiptLinksExcluded: '. Competing receipt links excluded: ',
    messageCostUnavailable: '. Message cost unavailable.',
    details: 'Details',
  },
} as const;
