'use client';

import { createElement, useId, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

export type FinancialComparisonExportFile = {
  filename: string;
  csv: string;
  identity: { from: string; to: string; branchIds: string[] };
};

type Query = Pick<URLSearchParams, 'get' | 'getAll'>;
const filters = ['branch', 'from', 'to'] as const;

function queryIdentity(query: Query) {
  return JSON.stringify(filters.map((key) => query.getAll(key)));
}

function matchesResult(query: Query, file: FinancialComparisonExportFile) {
  if (filters.some((key) => query.getAll(key).length > 1)) return false;
  const { from, to, branchIds } = file.identity;
  if (!branchIds.length) return false;
  if (query.get('from') !== null && query.get('from') !== from) return false;
  if (query.get('to') !== null && query.get('to') !== to) return false;
  const branch = query.get('branch');
  return (
    branch === 'all' || (branchIds.length === 1 && (branch === null || branch === branchIds[0]))
  );
}

/** Only the server-created artifact crosses this client boundary, never money/DB modules. */
export function FinancialComparisonExportButton({
  file,
}: {
  file: FinancialComparisonExportFile | null;
}) {
  const query = useSearchParams();
  // Parent keys this component by the response identity. Changed URL + old response stays denied.
  const [originalQuery] = useState(() => (query ? queryIdentity(query) : null));
  const [error, setError] = useState<string | null>(null);
  const messageId = useId();
  const staleMessage = 'Filters changed. Apply the report filters again before exporting.';
  const current =
    !!file && !!query && queryIdentity(query) === originalQuery && matchesResult(query, file);
  const message = file && !current ? staleMessage : error;

  function download() {
    if (!current || !file) return;
    const liveQuery = new URLSearchParams(window.location.search);
    if (queryIdentity(liveQuery) !== originalQuery || !matchesResult(liveQuery, file)) {
      setError(staleMessage);
      return;
    }
    setError(null);
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.appendChild(anchor);
      anchor.click();
    } catch {
      setError('CSV download could not start. Try exporting again.');
    } finally {
      anchor?.remove();
      if (url) URL.revokeObjectURL(url);
    }
  }

  return createElement(
    'div',
    { className: 'space-y-2' },
    createElement(
      Button,
      {
        type: 'button',
        variant: 'secondary',
        className: 'min-h-11',
        disabled: !current,
        onClick: download,
        'aria-describedby': message ? messageId : undefined,
      },
      'Export comparison CSV'
    ),
    message
      ? createElement(
          'p',
          { id: messageId, role: 'status', className: 'text-sm text-text-muted' },
          message
        )
      : null
  );
}
