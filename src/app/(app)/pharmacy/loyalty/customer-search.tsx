'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const LOYALTY_SEARCH_DELAY_MS = 300;

export function loyaltySearchHref(branchId: string, query: string) {
  const params = new URLSearchParams({ branchId });
  if (query.trim()) params.set('query', query.trim());
  return `/pharmacy/loyalty?${params}`;
}

// Plain GET form so search still works without JavaScript; with it, results follow typing.
export function LoyaltyCustomerSearch({
  branches,
  branchId,
  query,
}: {
  branches: { id: string; name: string }[];
  branchId: string;
  query: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(query);
  const [branch, setBranch] = useState(branchId);
  const [pending, startTransition] = useTransition();
  const sent = useRef(loyaltySearchHref(branchId, query));

  useEffect(() => {
    const href = loyaltySearchHref(branch, text);
    if (href === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = href;
      startTransition(() => router.replace(href, { scroll: false }));
    }, LOYALTY_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [branch, text, router]);

  return (
    <form
      action="/pharmacy/loyalty"
      method="get"
      role="search"
      aria-busy={pending}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="grid w-full gap-2 text-sm sm:w-auto">
        Branch
        <select
          name="branchId"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          className="min-h-11 max-w-full rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid w-full gap-2 text-sm sm:w-80">
        Name, phone or loyalty number
        <Input
          type="search"
          name="query"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={100}
          autoComplete="off"
          className="min-h-11"
        />
      </label>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? 'Searching…' : 'Search'}
      </Button>
    </form>
  );
}
