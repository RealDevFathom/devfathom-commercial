'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import {
  AGREEMENT_TITLE,
  AGREEMENT_PREAMBLE,
  AGREEMENT_CLAUSES,
  AGREEMENT_SIGNATURE_NOTE,
  OWNER,
} from '@/lib/legal-agreement';

/**
 * One-time Confidentiality & Non-Replication Agreement.
 *
 * Mounted once inside the authenticated AppShell. On first use, any account that
 * has not yet accepted the current agreement version sees this full-screen,
 * non-dismissible overlay and must sign (typed name) + agree before reaching the
 * app. Acceptance is persisted server-side per account (legal.accept) and logged
 * to the audit trail, so it shows exactly once per user — across devices and
 * sessions. The agreement text comes from the same shared source the server
 * hashes, so what is shown is exactly what is recorded as accepted.
 */
export function LegalGate() {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const { data: status, isLoading } = trpc.legal.status.useQuery(undefined, {
    enabled: !!session?.user?.id,
  });

  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);

  const accept = trpc.legal.accept.useMutation({
    onSuccess: () => utils.legal.status.invalidate(),
  });

  // Nothing to gate until we know the user and their status — and once accepted,
  // the overlay is gone for good.
  if (!session?.user?.id || isLoading || !status || status.accepted) return null;

  const canSubmit = agreed && name.trim().length >= 2 && !accept.isPending;
  const today = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#08221F]/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 bg-[#0C2E2C] px-6 py-5 text-[#F7F5EF]">
          <FathomMark className="h-8 w-8" variant="brand" />
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">{AGREEMENT_TITLE}</h2>
            <p className="text-xs text-[#F7F5EF]/65">
              {OWNER.legalName} · please read and accept to continue to {OWNER.product}.
            </p>
          </div>
        </div>

        {/* Agreement body (scrollable) */}
        <div className="space-y-3 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-foreground">
          <p>{AGREEMENT_PREAMBLE}</p>

          {AGREEMENT_CLAUSES.map((clause, i) => (
            <div key={clause.heading}>
              <h3 className="font-display text-[15px] font-semibold">
                {i + 1}. {clause.heading}
              </h3>
              <p className="text-muted-foreground">{clause.body}</p>
            </div>
          ))}
        </div>

        {/* Sign + accept */}
        <div className="border-t border-border bg-muted/40 px-6 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Type your full legal name to sign"
              autoComplete="name"
              className="flex-1"
              disabled={accept.isPending}
            />
            <span className="text-xs text-muted-foreground">Date: {today}</span>
          </div>

          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={accept.isPending}
              className="mt-0.5 h-4 w-4 accent-[#0C2E2C]"
            />
            <span>
              I have read and agree to this Agreement, and I understand it binds me each time I access
              or use {OWNER.product}.
            </span>
          </label>

          {accept.error && <p className="mb-2 text-xs text-destructive">{accept.error.message}</p>}

          <Button onClick={() => accept.mutate({ name: name.trim() })} disabled={!canSubmit}>
            {accept.isPending ? 'Saving…' : 'Agree and continue'}
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground">{AGREEMENT_SIGNATURE_NOTE}</p>
        </div>
      </div>
    </div>
  );
}
