'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeWhatsAppE164 } from '@/lib/growth/whatsapp/phone';
import { trpc } from '@/lib/trpc';

type OptInInput = { customerId: string; whatsappOptIn: boolean; phone?: string };

/**
 * POS consent control. Reuses Studio checkbox, input, and button. Hidden by the
 * counter unless the growth_ai module is granted.
 */
export function WhatsAppOfferConsent({
  customerId,
  initialPhone,
  initialOptIn = false,
  pending = false,
  onSave,
}: {
  customerId: string;
  initialPhone: string;
  initialOptIn?: boolean;
  pending?: boolean;
  onSave: (input: OptInInput) => Promise<unknown> | unknown;
}) {
  const [optIn, setOptIn] = useState(initialOptIn);
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const parsed = normalizeWhatsAppE164(phone);
    if (optIn && !parsed) {
      setError('Enter a WhatsApp mobile number.');
      return;
    }
    setError(null);
    try {
      await onSave({
        customerId,
        whatsappOptIn: optIn,
        ...(parsed ? { phone: parsed } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save WhatsApp preference.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="growth-whatsapp-phone">WhatsApp number</Label>
        <Input
          id="growth-whatsapp-phone"
          value={phone}
          disabled={pending}
          inputMode="tel"
          autoComplete="tel"
          placeholder="03xx xxx xxxx"
          className="h-11"
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>
      <div className="flex items-start gap-3">
        <Checkbox
          id="growth-whatsapp-opt-in"
          checked={optIn}
          disabled={pending}
          onCheckedChange={(value) => setOptIn(value === true)}
        />
        <Label htmlFor="growth-whatsapp-opt-in">Send me offers on WhatsApp</Label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-11" disabled={pending} onClick={() => void save()}>
        {pending ? 'Saving…' : 'Save WhatsApp preference'}
      </Button>
    </div>
  );
}

/** Mounted by the pharmacy counter only when growth_ai is on, so the hook stays off otherwise. */
export function CounterWhatsAppOffer({
  customerId,
  initialPhone,
}: {
  customerId: string;
  initialPhone: string;
}) {
  const consent = trpc.growth.customers.consent.useQuery({ customerId });
  const setOptIn = trpc.growth.customers.setOptIn.useMutation({
    onSuccess: () => {
      void consent.refetch();
    },
  });
  if (consent.isLoading) return <p role="status">Loading WhatsApp preference…</p>;
  if (consent.error) return <p role="alert">Could not load WhatsApp preference.</p>;
  return (
    <WhatsAppOfferConsent
      key={`${customerId}:${consent.data?.whatsappOptIn}:${consent.data?.whatsappE164}`}
      customerId={customerId}
      initialPhone={consent.data?.whatsappE164 ?? initialPhone}
      initialOptIn={consent.data?.whatsappOptIn ?? false}
      pending={setOptIn.isPending}
      onSave={(input) => setOptIn.mutateAsync(input)}
    />
  );
}
