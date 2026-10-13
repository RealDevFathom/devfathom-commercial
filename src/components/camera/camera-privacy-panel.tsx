import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { CameraPrivacyVertical, CameraPrivacyView } from '@/lib/cameras/privacy';

const RETENTION = { min: 1, max: 90 };

const PURPOSE: Record<CameraPrivacyVertical, { en: string; ur: string }> = {
  pharmacy: {
    en: 'This pharmacy uses cameras for safety, to verify sales and refunds, and to monitor medicine refrigerators.',
    ur: 'یہ فارمیسی حفاظت، فروخت اور رقم کی واپسی کی تصدیق، اور ادویات کے فریج کی نگرانی کے لیے کیمرے استعمال کرتی ہے۔',
  },
  restaurant: {
    en: 'This restaurant uses cameras for safety, kitchen hygiene, and to verify sales at the counter.',
    ur: 'یہ ریسٹورنٹ حفاظت، باورچی خانے کی صفائی، اور کاؤنٹر پر فروخت کی تصدیق کے لیے کیمرے استعمال کرتا ہے۔',
  },
};

/** The notice to print and display at the entrance, in English and Urdu. */
export function cameraSignage(vertical: CameraPrivacyVertical, retentionDays: number | null) {
  const purpose = PURPOSE[vertical];
  return {
    en: [
      'CCTV cameras in operation.',
      purpose.en,
      retentionDays === null
        ? 'No camera recording is configured.'
        : `Camera stills are kept for ${retentionDays} days unless held for a legal or regulatory reason.`,
    ],
    ur: [
      'سی سی ٹی وی کیمرے زیرِ استعمال ہیں۔',
      purpose.ur,
      retentionDays === null
        ? 'کوئی کیمرہ ریکارڈنگ ترتیب نہیں دی گئی۔'
        : `کیمرے کی تصاویر ${retentionDays} دن تک محفوظ رکھی جاتی ہیں، سوائے اس کے کہ کسی قانونی یا ضابطہ جاتی وجہ سے روکی جائیں۔`,
    ],
  };
}

const when = (value: string) =>
  new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );

/**
 * CAM-3 camera privacy settings, shared by /pharmacy and /restaurant settings.
 * Renders on the server; the two actions are the page's server actions.
 */
export function CameraPrivacyPanel({
  vertical,
  view,
  setRetentionAction,
  revokeGrantAction,
}: {
  vertical: CameraPrivacyVertical;
  view: CameraPrivacyView;
  setRetentionAction: (data: FormData) => void | Promise<void>;
  revokeGrantAction: (data: FormData) => void | Promise<void>;
}) {
  // The notice promises the longest period any gateway keeps a still.
  const retentionDays = view.gateways.length
    ? Math.max(...view.gateways.map((gateway) => gateway.retentionDays))
    : null;
  const signage = cameraSignage(vertical, retentionDays);
  return (
    <div className="space-y-6">
      <SectionCard eyebrow="Signage" title="Camera notice" titleLevel={2}>
        <div className="grid gap-4 md:grid-cols-2">
          <div lang="en" className="space-y-2 rounded-md border border-border-subtle p-4 text-sm">
            {signage.en.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div
            lang="ur"
            dir="rtl"
            className="space-y-2 rounded-md border border-border-subtle p-4 text-base leading-loose"
          >
            {signage.ur.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard eyebrow="Retention" title="Retention days" titleLevel={2}>
        {view.gateways.length === 0 ? (
          <p className="text-sm text-text-muted">No active camera gateway is enrolled.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {view.gateways.map((gateway) => (
              <form
                key={gateway.id}
                action={setRetentionAction}
                className="rounded-md border border-border-subtle p-4"
              >
                <input type="hidden" name="gatewayId" value={gateway.id} />
                <p className="font-semibold text-text-strong">{gateway.name}</p>
                <label className="mt-2 block text-sm font-medium text-text-strong">
                  Retention days for {gateway.name}
                  <Input
                    name="days"
                    type="number"
                    min={RETENTION.min}
                    max={RETENTION.max}
                    defaultValue={gateway.retentionDays}
                    required
                  />
                </label>
                <Button className="mt-3" type="submit">
                  Save retention
                </Button>
              </form>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Access" title="Live-view grants" titleLevel={2}>
        {view.grants.length === 0 ? (
          <p className="text-sm text-text-muted">Nobody has opened a live view yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {view.grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-sm text-text-strong">
                  {grant.viewerName} · {grant.cameraName} · opened {when(grant.createdAt)}
                </span>
                {grant.active ? (
                  <form action={revokeGrantAction}>
                    <input type="hidden" name="grantId" value={grant.id} />
                    <Button size="sm" type="submit" variant="destructive">
                      Revoke {grant.viewerName}&apos;s access to {grant.cameraName}
                    </Button>
                  </form>
                ) : (
                  <StatusPill status="Ended" tone="neutral" />
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
