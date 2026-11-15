import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { DEFAULT_PROFILE_HEALTH_CONFIG } from '@/lib/pharmacy/business-profile-health';
import { MarketingActionForm } from './action-form';

const control =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const CHECKS = [
  ['primaryCategoryIsPharmacy', 'Primary category is Pharmacy'],
  ['phoneListed', 'Phone number listed'],
  ['websiteOrOrderLinkListed', 'Website or ordering link listed'],
  ['descriptionPresent', 'Business description present'],
  ['holidayHoursSet', 'Holiday hours set'],
] as const;

function NumberField({
  name,
  label,
  defaultValue,
  min = 0,
  max,
  required = true,
}: {
  name: string;
  label: string;
  defaultValue?: number;
  min?: number;
  max: number;
  required?: boolean;
}) {
  return (
    <label className="block text-sm">
      {label}
      <Input
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={defaultValue}
        required={required}
        className="mt-1 min-h-11"
      />
    </label>
  );
}

/** Google Business Profile health and review reply drafts. Nothing here posts to Google. */
export function ProfilePanel({ branchId }: { branchId: string }) {
  return (
    <SectionCard title="Google Business Profile" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          Check your profile against a short checklist and draft replies to reviews. DevFathom does
          not connect to Google and never posts: you copy each reviewed reply and post it yourself.
        </p>
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <section aria-labelledby="profile-health-heading" className="min-w-0 space-y-3">
            <h3 id="profile-health-heading" className="text-sm font-medium">
              Profile health checklist
            </h3>
            <MarketingActionForm
              branchId={branchId}
              operation="profile-health"
              label="Check profile"
            >
              <fieldset className="space-y-2">
                <legend className="text-sm">What your profile shows today</legend>
                {CHECKS.map(([name, label]) => (
                  <label key={name} className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" name={name} className="size-5" />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField
                  name="hoursConfirmedDaysAgo"
                  label="Days since hours confirmed (blank if unsure)"
                  max={3650}
                  required={false}
                />
                <NumberField name="photoCount" label="Photos on profile" max={100000} />
                <NumberField name="unansweredReviews" label="Unanswered reviews" max={100000} />
              </div>
              <details className="border-t border-border-subtle pt-3">
                <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  Checklist targets (estimates — adjust for your branch)
                </summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <NumberField
                    name="maximumHoursAgeDays"
                    label="Re-confirm hours every (days)"
                    min={1}
                    max={365}
                    defaultValue={DEFAULT_PROFILE_HEALTH_CONFIG.maximumHoursAgeDays}
                  />
                  <NumberField
                    name="minimumPhotos"
                    label="Target photo count"
                    max={500}
                    defaultValue={DEFAULT_PROFILE_HEALTH_CONFIG.minimumPhotos}
                  />
                  <NumberField
                    name="maximumUnansweredReviews"
                    label="Unanswered reviews allowed"
                    max={1000}
                    defaultValue={DEFAULT_PROFILE_HEALTH_CONFIG.maximumUnansweredReviews}
                  />
                </div>
              </details>
            </MarketingActionForm>
          </section>
          <section aria-labelledby="review-reply-heading" className="min-w-0 space-y-3">
            <h3 id="review-reply-heading" className="text-sm font-medium">
              Review reply draft
            </h3>
            <MarketingActionForm branchId={branchId} operation="review-reply" label="Draft reply">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  Star rating
                  <select name="rating" className={control} defaultValue="5">
                    {[5, 4, 3, 2, 1].map((rating) => (
                      <option key={rating} value={rating}>
                        {rating} {rating === 1 ? 'star' : 'stars'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Tone
                  <select name="tone" className={control} defaultValue="FRIENDLY">
                    <option value="FRIENDLY">Friendly</option>
                    <option value="FORMAL">Formal</option>
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                Reviewer first name (optional)
                <Input name="reviewerFirstName" maxLength={40} className="mt-1 min-h-11" />
              </label>
              <p className="text-sm text-text-muted">
                Do not paste the review. Only the rating band and tone go to the AI provider, when
                AI is enabled; otherwise a reviewed template is used. Replies never mention
                medicines or confirm someone was a customer.
              </p>
            </MarketingActionForm>
          </section>
        </div>
      </div>
    </SectionCard>
  );
}
