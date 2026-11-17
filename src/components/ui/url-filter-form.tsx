'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/** Read-only selectors replace URL state so Back leaves the board in one step. */
export function UrlFilterForm({
  action,
  className,
  children,
}: {
  action: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const apply = (form: HTMLFormElement) => {
    if (!form.reportValidity()) return;
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string') query.append(key, value);
    }
    router.replace(`${action}?${query}`, { scroll: false });
  };
  return (
    <form
      action={action}
      method="get"
      className={className}
      onChange={(event) => apply(event.currentTarget)}
      onSubmit={(event) => {
        event.preventDefault();
        apply(event.currentTarget);
      }}
    >
      {children}
      <noscript>
        <button type="submit">Apply filters</button>
      </noscript>
    </form>
  );
}
