import Link from 'next/link';

import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import type { GrowthConnection } from '@/lib/growth/view';

const links = [
  { href: '/growth', id: 'inbox', label: 'Inbox' },
  { href: '/growth/settings', id: 'settings', label: 'Settings' },
] as const;

export function GrowthNav({ current }: { current: 'inbox' | 'settings' | 'detail' }) {
  return (
    <nav aria-label="Growth" className="flex flex-wrap gap-2">
      {links.map((link) => {
        const active = link.id === current;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring',
              active
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-sunken text-text-body hover:bg-muted'
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ConnectionChip({ connection }: { connection: GrowthConnection }) {
  const paired = connection.status === 'connected';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <StatusPill
        status={paired ? 'connected' : 'needs-pairing'}
        tone={paired ? 'success' : 'warning'}
        label={paired ? 'WhatsApp connected' : 'WhatsApp needs pairing'}
      />
      {connection.managerUrl ? (
        <a
          href={connection.managerUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {paired ? 'Open manager' : 'Pair in the manager'}
        </a>
      ) : (
        <p className="text-sm text-text-muted">Add the Evolution URL in settings to pair.</p>
      )}
      {paired ? null : (
        <p className="w-full text-sm text-text-muted">Pair a shop number, not a personal one.</p>
      )}
    </div>
  );
}
