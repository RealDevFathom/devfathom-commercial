'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isUrduMedicineName } from '@/lib/pharmacy/medicine-alias';
import { trpc } from '@/lib/trpc';

export function MedicineUrduAlias({ medicineId }: { medicineId: string }) {
  const t = useTranslations('MedicineAliases');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const utils = trpc.useUtils();
  const save = trpc.pharmacyMedicine.addUrduAlias.useMutation();
  return (
    <form
      className="mt-6 space-y-3 border-t border-border-subtle pt-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (save.isPending || !isUrduMedicineName(value)) return;
        setSaved(false);
        try {
          await save.mutateAsync({ medicineId, value: value.trim() });
          setValue('');
          setSaved(true);
          await utils.pharmacyMedicine.get.invalidate({ id: medicineId });
        } catch {
          /* The mutation retains the entered value and supplies its refusal state. */
        }
      }}
    >
      <Label htmlFor="medicine-urdu-alias">{t('label')}</Label>
      <Input
        id="medicine-urdu-alias"
        lang="ur"
        dir="rtl"
        value={value}
        maxLength={300}
        required
        disabled={save.isPending}
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
          save.reset();
        }}
      />
      <p className="text-sm text-text-muted">{t('help')}</p>
      <Button type="submit" disabled={save.isPending || !isUrduMedicineName(value)}>
        {save.isPending ? t('saving') : t('save')}
      </Button>
      {saved ? (
        <p role="status" className="text-sm text-success">
          {t('saved')}
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error.data?.code === 'FORBIDDEN' ? t('forbidden') : t('failed')}
        </p>
      ) : null}
    </form>
  );
}
