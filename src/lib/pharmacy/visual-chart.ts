export const CHARTS = {
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
  if (chart === 'returnRate') return base > 0 ? Math.round((amount * 10000) / base) / 100 : null;
  return amount;
}
