import { reportRatePercent } from './report-kpi-flags';
export const CHARTS = {
  profitDay: 'Gross profit by day',
  marginDay: 'Gross margin by day',
  profitCategory: 'Gross profit by category',
  topMargin: 'Medicines with the highest margin',
  bottomMargin: 'Medicines with the lowest margin',
  salesDay: 'Sales by day',
  salesHour: 'Sales by hour',
  salesWeekday: 'Sales by weekday',
  salesPayment: 'Sales by payment method',
  salesCashier: 'Sales by cashier',
  salesCategory: 'Sales by category',
  returnsDay: 'Refunds and sales by day',
  returnRate: 'Return rate',
  returnMedicine: 'Top returned medicines',
  returnReason: 'Reasons for refunds',
} as const;
export type ChartId = keyof typeof CHARTS;
export const REPORT_CHARTS = {
  Sales: ['salesDay', 'salesHour', 'salesWeekday', 'salesPayment', 'salesCashier', 'salesCategory'],
  Profit: ['profitDay', 'marginDay', 'profitCategory', 'topMargin', 'bottomMargin'],
  Returns: ['returnsDay', 'returnRate', 'returnMedicine', 'returnReason'],
} as const satisfies Record<string, readonly ChartId[]>;
export type ChartRow = {
  key: string;
  label: string;
  value: number | null;
  base: number;
  amount: number;
  excluded: number;
};
export function chartValue(chart: ChartId, amount: number, base: number) {
  if (
    chart === 'returnRate' ||
    chart === 'marginDay' ||
    chart === 'topMargin' ||
    chart === 'bottomMargin'
  )
    return reportRatePercent(amount, base);
  return amount;
}
