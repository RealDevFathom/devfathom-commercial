/** Carry the selected report filters when navigating back to the operational workspace. */
export function operationalReportsHref(filters: {
  branch?: unknown;
  from?: unknown;
  to?: unknown;
}) {
  const params = new URLSearchParams();
  for (const key of ['branch', 'from', 'to'] as const) {
    const value = filters[key];
    if (typeof value === 'string' && value) params.set(key, value);
  }
  return '/pharmacy/reports/operations' + (params.size ? '?' + params.toString() : '');
}
