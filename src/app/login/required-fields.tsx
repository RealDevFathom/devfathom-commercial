/** Inline messages for a sign-in submitted with an empty field. */
export type RequiredFieldErrors = { email?: string; password?: string };

export const EMAIL_REQUIRED = 'Email is required';
export const PASSWORD_REQUIRED = 'Password is required';

export function requiredFieldErrors(email: string, password: string): RequiredFieldErrors {
  return {
    ...(email.trim() ? {} : { email: EMAIL_REQUIRED }),
    ...(password ? {} : { password: PASSWORD_REQUIRED }),
  };
}

/** The ids an input's `aria-describedby` names, or undefined when there are none. */
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const named = ids.filter(Boolean).join(' ');
  return named || undefined;
}

/**
 * A field's inline message. It is announced as it appears (`role="alert"`) and
 * is referenced by the input's `aria-describedby`. The caller places it where it
 * occupies space that already exists, so showing it never moves the form.
 */
export function FieldError({
  id,
  message,
  className = '',
}: {
  id: string;
  message: string | undefined;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={`text-xs font-medium text-destructive ${className}`}>
      {message}
    </p>
  );
}
