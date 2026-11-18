import Link from 'next/link';

import { isNoPinSetMessage, OWN_PIN_PATH } from '@/lib/pharmacy/own-pin-policy';

/**
 * DEV-931 — a refusal as the server worded it. When it is the shared "no PIN set" refusal,
 * it also links to "Your PIN", so the person can create their PIN and come back.
 */
export function PinAwareMessage({ message }: { message: string }) {
  if (!isNoPinSetMessage(message)) return <>{message}</>;
  return (
    <>
      {message}{' '}
      <Link
        href={OWN_PIN_PATH}
        className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        Set up your PIN
      </Link>
    </>
  );
}

/** For "nobody can approve" notices: where a manager or owner creates their own PIN. */
export function OwnPinLink({ children = 'Set up your PIN' }: { children?: React.ReactNode }) {
  return (
    <Link
      href={OWN_PIN_PATH}
      className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </Link>
  );
}
