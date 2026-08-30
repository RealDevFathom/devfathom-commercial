import type { Metadata } from 'next';

import { MoneyConsole, type MoneyTab } from '@/components/restaurant/money/money-console';

export const metadata: Metadata = { title: 'Restaurant Finance' };

const MONEY_TABS = new Set<MoneyTab>(['bills', 'payments', 'drawers', 'daily-close', 'terminal']);

function validTab(value: string | string[] | undefined): MoneyTab {
  return typeof value === 'string' && MONEY_TABS.has(value as MoneyTab)
    ? (value as MoneyTab)
    : 'bills';
}

export default async function RestaurantMoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const query = await searchParams;
  return <MoneyConsole initialTab={validTab(query.tab)} />;
}
