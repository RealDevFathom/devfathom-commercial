/**
 * Locate the successful form control behind a shared SelectField trigger.
 * Value/submission assertions still inspect the real native control; focus and
 * accessible-name assertions should continue to inspect the visible trigger.
 * Unmigrated native controls and text inputs are returned unchanged.
 */
export function selectFieldControl<T extends Element | null | undefined>(element: T): T {
  if (!element) return element;
  const nativeId = element.getAttribute('data-native-control');
  if (!nativeId) return element;
  const native = element.ownerDocument.getElementById(nativeId);
  if (!(native instanceof HTMLSelectElement)) {
    throw new Error(`SelectField trigger has no native form control: ${nativeId}`);
  }
  return native as unknown as T;
}
