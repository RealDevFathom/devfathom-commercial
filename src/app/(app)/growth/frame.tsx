import type { ReactNode } from 'react';

import { PageHeader } from '@/components/ui/page-header';
import { GrowthNav } from '@/components/growth/growth-nav';

function note(value: string | undefined) {
  const text = value?.trim();
  if (!text) return null;
  return text.slice(0, 300);
}

export function GrowthFrame({
  heading,
  description,
  actions,
  current,
  notice,
  error,
  children,
}: {
  heading: string;
  description: string;
  actions?: ReactNode;
  current: 'inbox' | 'settings' | 'detail';
  notice?: string;
  error?: string;
  children: ReactNode;
}) {
  const saved = note(notice);
  const failed = note(error);
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Growth"
        eyebrowMuted
        heading={heading}
        description={description}
        actions={actions}
      />
      <GrowthNav current={current} />
      {saved ? (
        <p
          role="status"
          className="rounded-md border border-border-subtle bg-surface-sunken px-4 py-3 text-sm text-text-body"
        >
          {saved}
        </p>
      ) : null}
      {failed ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {failed}
        </p>
      ) : null}
      {children}
    </div>
  );
}
