'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';
import { MANUAL_TENDER_TYPES, manualPaymentSettingsSchema, merchantQrSchema,
  type ManualPaymentSettings, type ManualTenderType } from '@/lib/pharmacy/manual-payments';

export function ManualPaymentSettingsPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.manualPaymentSettings.useQuery({ branchId });
  const save = trpc.pharmacySales.saveManualPaymentSettings.useMutation();
  const [draft, setDraft] = useState<ManualPaymentSettings | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const settings = draft ?? query.data?.settings ?? {};
  const disabled = query.isLoading || query.isError || save.isPending || uploading;
  function changeDraft(next: ManualPaymentSettings) {
    setDraftRevision(draftRevision ?? query.data?.revision ?? null);
    setDraft(next);
  }
  function update(type: ManualTenderType, change: Partial<NonNullable<ManualPaymentSettings['RAAST']>>) {
    setNotice('');
    changeDraft({ ...settings, [type]: { destination: '', allowReferenceSkip: false, ...settings[type], ...change } });
  }
  return (
    <SectionCard title="Raast / wallet merchant details" eyebrow="Branch payment policy">
      <p className="mb-4 text-sm text-text-muted">Enable each wallet the shop accepts. A static merchant QR and an IBAN or till number are optional; the counter shows them only when entered. Cashiers confirm payment manually; no bank or wallet API verifies it.</p>
      {query.isLoading ? <p role="status">Loading merchant details…</p> : null}
      {query.isError ? <div role="alert" className="space-y-2"><p>Merchant details are unavailable. An authorized pharmacy administrator can manage this branch.</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></div> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {MANUAL_TENDER_TYPES.map((type) => (
          <fieldset key={type} disabled={disabled} className="min-w-0 space-y-3 rounded-md border border-border-default p-4">
            <legend className="px-1 text-sm font-medium">{type}</legend>
            <Label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={Boolean(settings[type])} onChange={(event) => {
                if (event.target.checked) update(type, {});
                else { const next = { ...settings }; delete next[type]; changeDraft(next); setNotice(''); }
              }} /> Enable {type}
            </Label>
            {settings[type] ? <>
              <Label htmlFor={`merchant-destination-${type}`}>IBAN or till number (optional)</Label>
              <Input id={`merchant-destination-${type}`} className="min-h-11" maxLength={120} value={settings[type]?.destination ?? ''} onChange={(event) => update(type, { destination: event.target.value })} />
              <Label htmlFor={`merchant-qr-${type}`}>Merchant QR (optional; PNG, JPEG or WebP; up to 250 KB)</Label>
              <Input id={`merchant-qr-${type}`} className="min-h-11" type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 250_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('Choose a PNG, JPEG or WebP image up to 250 KB.'); return; }
                setUploading(true);
                try {
                  const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(new Error('The image could not be read.'));
                    reader.readAsDataURL(file);
                  });
                  update(type, { qrImageDataUrl: merchantQrSchema.parse(data) });
                } catch { setNotice('The image could not be read. Choose another image.'); }
                finally { setUploading(false); }
              }} />
              {settings[type]?.qrImageDataUrl ? <>
                {/* Embedded merchant raster must remain readable without an image proxy. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={settings[type]?.qrImageDataUrl} alt={`${type} merchant QR`} className="h-48 w-full rounded-sm bg-surface-card object-contain" />
                <Button type="button" variant="outline" onClick={() => {
                  const next = { ...settings[type]! }; delete next.qrImageDataUrl;
                  changeDraft({ ...settings, [type]: next });
                }}>Remove QR</Button>
              </> : <p className="text-sm text-text-muted">No QR uploaded.</p>}
              <Label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={settings[type]?.allowReferenceSkip ?? false} onChange={(event) => update(type, { allowReferenceSkip: event.target.checked })} /> Allow cashiers to skip the transaction reference
              </Label>
            </> : <p className="text-sm text-text-muted">Disabled at this branch.</p>}
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button className="min-h-11" disabled={disabled || draft === null} onClick={async () => {
          const parsed = manualPaymentSettingsSchema.safeParse(settings);
          if (!parsed.success) { setNotice(parsed.error.issues[0]?.message ?? 'Check merchant details.'); return; }
          if (draftRevision === null) return;
          try {
            await save.mutateAsync({ branchId, revision: draftRevision, settings: parsed.data });
            const refreshed = await query.refetch();
            if (refreshed.error) { setNotice('Saved. Reload merchant details before making further changes.'); return; }
            setDraft(null); setDraftRevision(null); setNotice('Merchant details saved. Refresh offline counters to receive the new policy.');
          } catch { setNotice('Could not save. Reload merchant details to check access and concurrent changes.'); }
        }}>{save.isPending ? 'Saving…' : 'Save merchant details'}</Button>
        <Button variant="outline" disabled={disabled} onClick={async () => {
          const refreshed = await query.refetch();
          if (refreshed.error) { setNotice('Merchant details could not be reloaded. Your draft is preserved.'); return; }
          setDraft(null); setDraftRevision(null); setNotice('');
        }}>Reload merchant details</Button>
      </div>
      {notice ? <p role="status" className="mt-3 text-sm text-text-body">{notice}</p> : null}
    </SectionCard>
  );
}
