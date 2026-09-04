'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { CommandField } from '@/components/platform/platform-command-form';

const PlatformCommandForm = dynamic(
  () =>
    import('@/components/platform/platform-command-form').then(
      (module) => module.PlatformCommandForm
    ),
  { ssr: false }
);

const PlatformCommandButton = dynamic(
  () =>
    import('@/components/platform/platform-command-form').then(
      (module) => module.PlatformCommandButton
    ),
  { ssr: false }
);

export function OperatorEditor({
  children,
  fields,
  mfaReset,
}: {
  children: React.ReactNode;
  fields: CommandField[];
  mfaReset?: { id: string; email: string };
}) {
  const [opened, setOpened] = useState(false);

  return (
    <details className="group" onToggle={(event) => setOpened(event.currentTarget.open)}>
      {children}
      {opened ? (
        <div className="border-t border-border-subtle bg-surface-sunken/30 px-5">
          <PlatformCommandForm
            compact
            action="operator.upsert"
            submitLabel="Update operator"
            fields={fields}
          />
          {mfaReset ? (
            <div className="border-t border-border-subtle py-4">
              <PlatformCommandButton
                action="operator.mfa.reset"
                label="Reset MFA and revoke sessions"
                tone="danger"
                confirm={`Reset MFA for ${mfaReset.email}? They will be signed out immediately.`}
                payload={{
                  id: mfaReset.id,
                  reason: 'Emergency MFA reset by a super administrator',
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export function CreateOperatorForm({ fields }: { fields: CommandField[] }) {
  return (
    <PlatformCommandForm
      compact
      action="operator.upsert"
      submitLabel="Create operator"
      fields={fields}
    />
  );
}
