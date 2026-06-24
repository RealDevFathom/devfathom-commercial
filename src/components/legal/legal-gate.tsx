'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { FathomMark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';

/**
 * One-time Confidentiality & Non-Replication Agreement.
 *
 * Mounted once inside the authenticated AppShell. On first use, any account that
 * has not yet accepted the current agreement version sees this full-screen,
 * non-dismissible overlay and must sign (typed name) + agree before reaching the
 * app. Acceptance is persisted server-side per account (legal.accept), so it
 * shows exactly once per user and never again — across devices and sessions.
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
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Confidentiality &amp; Non-Replication Agreement
            </h2>
            <p className="text-xs text-[#F7F5EF]/65">
              Please read and accept to continue to DevFathom Hub.
            </p>
          </div>
        </div>

        {/* Agreement body (scrollable) */}
        <div className="space-y-3 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-foreground">
          <p>
            This Agreement is between you, the person accessing and using DevFathom Hub
            (&ldquo;you&rdquo; or the &ldquo;Recipient&rdquo;), and <strong>Saad Ajmal</strong>, the
            original creator and owner of DevFathom Hub (the &ldquo;Owner&rdquo;). By signing below
            and continuing, you agree to be bound by it.
          </p>

          <div>
            <h3 className="font-display text-[15px] font-semibold">1. Confidential information</h3>
            <p className="text-muted-foreground">
              Everything you see or learn while accessing or using DevFathom Hub, including its
              features, design, workflows, structure, and underlying ideas (the &ldquo;Confidential
              Information&rdquo;), is the confidential and proprietary property of the Owner. You will
              keep it strictly confidential and will not disclose it to any third party without the
              Owner&rsquo;s prior written permission.
            </p>
          </div>

          <div>
            <h3 className="font-display text-[15px] font-semibold">2. Ownership</h3>
            <p className="text-muted-foreground">
              DevFathom Hub, together with its concept, design, and implementation, is and remains
              the exclusive property of the Owner, Saad Ajmal. Nothing here transfers any ownership,
              license, or right to you, other than a limited, revocable right to use it.
            </p>
          </div>

          <div>
            <h3 className="font-display text-[15px] font-semibold">3. Non-replication and non-compete</h3>
            <p className="text-muted-foreground">
              You agree that you will not, directly or indirectly, and whether alone or with or
              through any other person or company, build, develop, reproduce, copy, commission,
              distribute, market, or sell any product or service that is the same as or substantially
              similar to DevFathom Hub, in whole or in any material part, anywhere in the market,
              without the prior written permission of Saad Ajmal.
            </p>
          </div>

          <div>
            <h3 className="font-display text-[15px] font-semibold">4. No reverse engineering</h3>
            <p className="text-muted-foreground">
              You will not reverse engineer, decompile, or otherwise attempt to derive the source
              code, structure, or methods of DevFathom Hub.
            </p>
          </div>

          <div>
            <h3 className="font-display text-[15px] font-semibold">5. Term and remedies</h3>
            <p className="text-muted-foreground">
              These obligations continue indefinitely and survive the end of your access to DevFathom
              Hub, and they apply each time you access or use it. You acknowledge that a breach may
              cause the Owner harm that money alone cannot fully remedy, and that the Owner may seek
              injunctive relief in addition to any other remedy available at law. This Agreement is
              governed by the laws of the jurisdiction in which the Owner maintains his principal
              place of residence or business.
            </p>
          </div>
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
              or use DevFathom Hub.
            </span>
          </label>

          {accept.error && (
            <p className="mb-2 text-xs text-destructive">{accept.error.message}</p>
          )}

          <Button onClick={() => accept.mutate({ name: name.trim() })} disabled={!canSubmit}>
            {accept.isPending ? 'Saving…' : 'Agree and continue'}
          </Button>
          <p className="mt-2 text-[11px] text-muted-foreground">
            By clicking &ldquo;Agree and continue&rdquo; you adopt your typed name as your electronic
            signature for this Agreement.
          </p>
        </div>
      </div>
    </div>
  );
}
