'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { CommandField } from '@/components/platform/platform-command-form';

const PlatformCommandForm = dynamic(() =>
  import('@/components/platform/platform-command-form').then((module) => module.PlatformCommandForm)
);

export function DeploymentCommandDisclosure({
  children,
  fields,
  action,
  submitLabel,
  defaultOpen = false,
  className,
  panelClassName,
}: {
  children: React.ReactNode;
  fields: CommandField[];
  action: 'deployment.create' | 'deployment.update';
  submitLabel: string;
  defaultOpen?: boolean;
  className?: string;
  panelClassName?: string;
}) {
  const [opened, setOpened] = useState(defaultOpen);

  return (
    <details
      open={opened}
      className={className}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      {children}
      {opened ? (
        <div className={panelClassName}>
          <PlatformCommandForm compact action={action} submitLabel={submitLabel} fields={fields} />
        </div>
      ) : null}
    </details>
  );
}
