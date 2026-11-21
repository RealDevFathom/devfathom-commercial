import type { Locator } from '@playwright/test';

/** The successful form control behind a visible Studio SelectField trigger. */
export async function selectFieldNative(trigger: Locator): Promise<Locator> {
  const enhanced = trigger.and(trigger.page().locator('[data-select-field-trigger]'));
  const id = await enhanced.getAttribute('data-native-control');
  if (!id) throw new Error('Expected a Studio SelectField trigger.');
  return trigger.page().locator(`select[data-select-field-native][id=${JSON.stringify(id)}]`);
}

/** Select through the visible menu, preserving the control's interaction lifecycle. */
export async function chooseSelectField(
  trigger: Locator,
  selection: string | { label: string }
): Promise<void> {
  await trigger.and(trigger.page().locator('[data-select-field-trigger]')).click();
  const listbox = trigger.page().getByRole('listbox');
  const option =
    typeof selection === 'string'
      ? listbox.locator(`[role="option"][data-value=${JSON.stringify(selection)}]`)
      : listbox.getByRole('option', { name: selection.label, exact: true });
  await option.click();
}
