import { PageHeader } from '@/components/ui/page-header';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';

const toneByStatus: Record<string, StatusTone> = {
  ACTIVE: 'success',
  READY: 'success',
  SUCCEEDED: 'success',
  PAID: 'success',
  WON: 'success',
  VERIFIED: 'success',
  COMPLETED: 'success',
  ONBOARDING: 'warning',
  GRACE: 'warning',
  PENDING: 'warning',
  PENDING_SIGNATURE: 'warning',
  QUEUED: 'warning',
  PROVISIONING: 'warning',
  RUNNING: 'info',
  OPEN: 'info',
  SENT: 'info',
  PROSPECT: 'info',
  OVERDUE: 'danger',
  FAILED: 'danger',
  SUSPENDED: 'danger',
  TERMINATED: 'danger',
  PURGING: 'danger',
  REVOKED: 'danger',
  INACTIVE: 'neutral',
  REDACTED: 'neutral',
  PACKAGE_DEFAULT: 'neutral',
};

export function PlatformStatus({ value }: { value: string }) {
  return (
    <StatusPill status={value} tone={toneByStatus[value]} label={value.replaceAll('_', ' ')} />
  );
}

export function PlatformPageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <PageHeader
      className="platform-page-heading"
      eyebrow={eyebrow}
      heading={title}
      description={description}
      actions={action}
    />
  );
}
