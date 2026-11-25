'use client';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { saveDelegation } from './actions';

export function ConsentForm({ challans, urdu }: { challans: string[]; urdu: boolean }) {
  const t = (a: string, b: string) => (urdu ? b : a);
  const [permission, setPermission] = useState('FINANCIAL_SUMMARY');
  const [state, action, pending] = useActionState(saveDelegation.bind(null, 'consent'), {
    ok: true,
    message: '',
  });
  return (
    <form action={action} className="grid max-w-xl gap-4">
      <label className="grid gap-1">
        {t('Recipient email used to sign in', 'وصول کنندہ کا سائن اِن ای میل')}
        <Input name="email" type="email" maxLength={254} required />
      </label>
      <label className="grid gap-1">
        {t('Recipient relationship', 'وصول کنندہ کا رشتہ')}
        <SelectField name="relationship" defaultValue="GUARDIAN" required>
          <option value="GUARDIAN">{t('Guardian', 'سرپرست')}</option>
          <option value="SPONSOR">{t('Sponsor', 'مالی معاون')}</option>
        </SelectField>
      </label>
      <label className="grid gap-1">
        {t('Information to share', 'شیئر کی جانے والی معلومات')}
        <SelectField
          name="permission"
          value={permission}
          onChange={(e) => setPermission(e.currentTarget.value)}
          required
        >
          <option value="FINANCIAL_SUMMARY">
            {t(
              'Account balance, overdue balance and number of open challans',
              'اکاؤنٹ بیلنس، واجب الادا رقم اور کھلے چالانوں کی تعداد'
            )}
          </option>
          <option value="SPECIFIC_CHALLAN">
            {t(
              'One challan with fee type, amount, balance and due date',
              'ایک چالان کی فیس، رقم، بقایا اور آخری تاریخ'
            )}
          </option>
        </SelectField>
      </label>
      {permission === 'SPECIFIC_CHALLAN' && (
        <label className="grid gap-1">
          {t('Challan reference', 'چالان حوالہ')}
          <SelectField name="challanReference" defaultValue="" required>
            <option value="">{t('Select a challan', 'چالان منتخب کریں')}</option>
            {challans.map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </SelectField>
        </label>
      )}
      <label className="grid gap-1">
        {t('Access through this date (Pakistan time)', 'پاکستانی وقت کے مطابق رسائی کی آخری تاریخ')}
        <Input name="endsOn" type="date" required />
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="consent" value="yes" required className="mt-1" />
        {t(
          'I authorize this recipient to view the selected financial information until the expiry date. I can withdraw access at any time.',
          'میں وصول کنندہ کو آخری تاریخ تک منتخب مالی معلومات دیکھنے کی اجازت دیتا/دیتی ہوں۔ میں کسی بھی وقت رسائی ختم کر سکتا/سکتی ہوں۔'
        )}
      </label>
      <Button type="submit" disabled={pending} className="w-fit">
        {t('Grant access', 'رسائی دیں')}
      </Button>
      {state.message && <p role={state.ok ? 'status' : 'alert'}>{state.message}</p>}
    </form>
  );
}
export function RevokeForm({ id, urdu }: { id: string; urdu: boolean }) {
  const [state, action, pending] = useActionState(saveDelegation.bind(null, 'revoke'), {
    ok: true,
    message: '',
  });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button variant="outline" type="submit" disabled={pending}>
        {urdu ? 'رسائی ختم کریں' : 'Revoke access'}
      </Button>
      {state.message && <span role={state.ok ? 'status' : 'alert'}>{state.message}</span>}
    </form>
  );
}
