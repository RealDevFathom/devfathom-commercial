export const PHARMACY_WIDGET_KEYS = [
  'trade',
  'stock',
  'expiry',
  'safety',
  'finance',
  'coverage',
  'exceptions',
  'branches',
] as const;

export type PharmacyWidgetKey = (typeof PHARMACY_WIDGET_KEYS)[number];
export type PharmacyWidgetDefinition = {
  key: PharmacyWidgetKey;
  label: string;
  description: string;
  metrics: string[];
  permission: 'reports:operational' | 'reports:financial';
  defaultSpan: 'compact' | 'wide';
};

export const PHARMACY_WIDGET_REGISTRY: readonly PharmacyWidgetDefinition[] = [
  {
    key: 'trade',
    label: "Today's trade",
    description: 'Sales, margin, cash and refunds',
    metrics: ['salesMinor', 'marginMinor', 'cashVarianceMinor', 'refundsMinor'],
    permission: 'reports:financial',
    defaultSpan: 'wide',
  },
  {
    key: 'stock',
    label: 'Stock actions',
    description: 'Low stock, stockouts and recommended orders',
    metrics: ['openStockSignals', 'recommendedOrders'],
    permission: 'reports:operational',
    defaultSpan: 'compact',
  },
  {
    key: 'expiry',
    label: 'Expiry exposure',
    description: 'Stock value expiring within 30, 60, 90 and 180 days',
    metrics: [
      'expiryValueMinor30',
      'expiryValueMinor60',
      'expiryValueMinor90',
      'expiryValueMinor180',
    ],
    permission: 'reports:operational',
    defaultSpan: 'wide',
  },
  {
    key: 'safety',
    label: 'Recalls & quarantine',
    description: 'Open recalls and quarantined units',
    metrics: ['openRecalls', 'quarantineUnits', 'safetyQueue'],
    permission: 'reports:operational',
    defaultSpan: 'wide',
  },
  {
    key: 'finance',
    label: 'Claims & aging',
    description: 'Supplier claims, AP, AR and khata aging',
    metrics: ['openClaims', 'accountsPayableMinor', 'accountsReceivableMinor', 'khataAgingMinor'],
    permission: 'reports:financial',
    defaultSpan: 'wide',
  },
  {
    key: 'coverage',
    label: 'Pharmacist coverage',
    description: 'Qualified-person coverage across selected branches',
    metrics: ['pharmacistCoverage'],
    permission: 'reports:operational',
    defaultSpan: 'compact',
  },
  {
    key: 'exceptions',
    label: 'Operational exceptions',
    description: 'Receiving, device, fiscal and offline exceptions',
    metrics: [
      'openReceivingExceptions',
      'agingFiscalDocuments',
      'rejectedFiscalDocuments',
      'deviceFiscalOfflineExceptions',
    ],
    permission: 'reports:operational',
    defaultSpan: 'compact',
  },
  {
    key: 'branches',
    label: 'Branch comparison',
    description: 'Compare the currently selected branch scope',
    metrics: [],
    permission: 'reports:operational',
    defaultSpan: 'wide',
  },
];

export type PharmacyDashboardPreference = {
  version: 1;
  widgets: Array<{ key: PharmacyWidgetKey; visible: boolean; span: 'compact' | 'wide' }>;
};

/** A page the dashboard offers, already checked against the viewer's grants. */
export type PharmacyDashboardLink = { key: string; href: string; label: string; detail: string };

/**
 * What the signed-in viewer may see on the pharmacy dashboard, resolved on the
 * server (`resolvePharmacyDashboardAccess`) before anything renders.
 *
 * `reports` is the `reports:operational` grant every command-centre read and the
 * layout save check. Without it the dashboard asks Pharmacy Reports nothing,
 * never offers edit mode, and shows the viewer's own tools instead.
 */
export type PharmacyDashboardAccess = {
  reports: boolean;
  /** The viewer's working pages, offered when the dashboard holds no reports. */
  tools: readonly PharmacyDashboardLink[];
  /** Advice pages the viewer's grants open (reorder, expiry, growth). */
  advice: readonly PharmacyDashboardLink[];
};

/** Fail closed: no reports, no edit mode, nothing offered. */
export const CLOSED_PHARMACY_DASHBOARD_ACCESS: PharmacyDashboardAccess = {
  reports: false,
  tools: [],
  advice: [],
};

export function pharmacyDashboardDefault(
  role: string | null | undefined
): PharmacyDashboardPreference {
  const financial = role === 'ADMIN' || role === 'HR';
  return {
    version: 1,
    widgets: PHARMACY_WIDGET_REGISTRY.map((widget) => ({
      key: widget.key,
      visible: financial || widget.permission === 'reports:operational',
      span: widget.defaultSpan,
    })),
  };
}
