import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';

export const metadata: Metadata = { title: 'Accounts · Pharmacy' };

type AccountsLink = { href: string; title: string; detail: string };

/**
 * DEV-502: `/pharmacy/accounts` was a bare 404. This index only links to the
 * accounts pages; each destination keeps its own sign-in, module and permission
 * checks, so listing a link never grants access to the report behind it.
 */
const ACCOUNTS_SECTIONS: ReadonlyArray<{ title: string; links: readonly AccountsLink[] }> = [
  {
    title: 'Statements',
    links: [
      {
        href: '/pharmacy/accounts/profit-loss',
        title: 'Profit and loss',
        detail: 'Posted-ledger result by recorded currency.',
      },
      {
        href: '/pharmacy/accounts/balance-sheet',
        title: 'Balance sheet',
        detail: 'Classified posted balances and accounting-equation gaps.',
      },
      {
        href: '/pharmacy/accounts/cash-flow',
        title: 'Classified cash-flow projection',
        detail: 'Posted-ledger projection with transfer netting.',
      },
      {
        href: '/pharmacy/accounts/liquidity-kpi',
        title: 'Posted cash coverage',
        detail: 'Cash and bank balances against posted payables.',
      },
    ],
  },
  {
    title: 'Ledger controls',
    links: [
      {
        href: '/pharmacy/accounts/trial-balance-control',
        title: 'Trial-balance control',
        detail: 'Opening, movement and closing controls per account code.',
      },
      {
        href: '/pharmacy/accounts/general-journal',
        title: 'General journal vouchers',
        detail: 'Non-trade operating accrual vouchers for one branch.',
      },
      {
        href: '/pharmacy/accounts/journal-entry-lookup',
        title: 'Journal entry lookup',
        detail: 'Look up one journal entry.',
      },
      {
        href: '/pharmacy/accounts/journal-evidence-export',
        title: 'Journal evidence export',
        detail: 'Export one authorized journal page.',
      },
      {
        href: '/pharmacy/accounts/account-activity-bridge',
        title: 'Account activity bridge',
        detail: 'Isolate one posted account from statement totals.',
      },
      {
        href: '/pharmacy/accounts/account-code-reference',
        title: 'Account code reference',
        detail: 'Account codes and their normal debit or credit side.',
      },
    ],
  },
  {
    title: 'Payables, cheques and tax',
    links: [
      {
        href: '/pharmacy/accounts/provider-refunds',
        title: 'Card provider refunds',
        detail: 'Refunds owed, provider settlements and linked corrections.',
      },
      {
        href: '/pharmacy/accounts/ap-aging',
        title: 'Supplier expense invoice aging',
        detail: 'Outstanding supplier expense invoices by due date.',
      },
      {
        href: '/pharmacy/accounts/cheque-maturity',
        title: 'Recorded cheque maturity',
        detail: 'Recorded cheque due dates and statuses.',
      },
      {
        href: '/pharmacy/accounts/tax-profile-review',
        title: 'Tax profile review',
        detail: 'Compare two approved branch tax configurations.',
      },
      {
        href: '/pharmacy/accounts/fiscal-exceptions',
        title: 'Fiscal exception evidence',
        detail: 'Queued, rejected and dead fiscal documents.',
      },
    ],
  },
];

export default function PharmacyAccountsPage() {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Accounts"
        description="Statements, ledger controls, payables and tax evidence for your pharmacy. Each page checks your access when it opens."
      />
      {ACCOUNTS_SECTIONS.map((section) => (
        <SectionCard key={section.title} title={section.title} titleLevel={2}>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {section.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="group flex min-h-11 items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-card p-4 transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-text-strong">
                      {link.title}
                    </span>
                    <span className="mt-1 block text-sm text-text-muted">{link.detail}</span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ))}
    </div>
  );
}
