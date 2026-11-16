import type { CashCloseFinding } from './cash-close-check';
import { formatCloseMoney } from './cash-close-check';

export type ShiftHandoverFacts = {
  pendingRx: number;
  openOrders: number;
  restockPromises: number;
  expectedMinor: number;
  countedMinor: number;
  varianceMinor: number;
};

/** Internal, read-only draft. All figures are supplied by the database. */
export function buildShiftHandover(
  facts: ShiftHandoverFacts,
  businessDate: string,
  currency: string,
  findings: CashCloseFinding[]
) {
  const money = (value: number) => formatCloseMoney(value, currency);
  return [
    `Shift handover — drawer closed on business date ${businessDate}`,
    'Draft for internal review. Outstanding work is current at preparation time.',
    '',
    `Pending Rx: ${facts.pendingRx} emergency supplies awaiting their prescription.`,
    `Promised items: ${facts.openOrders} unfinished customer orders; ${facts.restockPromises} independent restock promises.`,
    `Drawer cash: ${money(facts.countedMinor)} counted; ${money(facts.expectedMinor)} expected; signed variance ${money(facts.varianceMinor)}.`,
    '',
    'Branch/day cash-close review (may include other drawers):',
    ...findings.map((finding) => `${finding.severity}: ${finding.explanation}`),
    ...(findings.length ? [] : ['No existing cash-close rule flagged this branch/day.']),
    'Discount anomalies are not covered by the existing cash-close check.',
    'Review outstanding work and these prompts before handing over. They are not findings of misconduct.',
  ].join('\n');
}
