'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { MarketingActionForm } from './action-form';

const PROFILE_ITEMS = [
  ['name', 'Business name matches storefront'],
  ['hours', 'Regular and holiday hours are current'],
  ['phone', 'Phone number reaches this branch'],
  ['category', 'Primary category describes the business'],
  ['website', 'Website and directions links work'],
] as const;

export function BusinessProfilePanel({ branchId }: { branchId: string }) {
  const storageKey = `pharmacy-business-profile-health:${branchId}`;
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [checkedItems, setCheckedItems] = useState<string[]>([]);
  const [photoAge, setPhotoAge] = useState('');
  const [photoTarget, setPhotoTarget] = useState('30');
  const age = Number(photoAge);
  const target = Number(photoTarget);
  const hasPhotoValues = photoAge !== '' || photoTarget !== '30';
  const photoValuesValid =
    photoAge !== '' &&
    photoTarget !== '' &&
    Number.isInteger(age) &&
    Number.isInteger(target) &&
    age >= 0 &&
    target >= 1;
  const photoNeedsAttention = photoValuesValid && age > target;

  useEffect(() => {
    queueMicrotask(() => {
      let stored: string | null;
      try {
        stored = localStorage.getItem(storageKey);
      } catch {
        setStorageUnavailable(true);
        return;
      }
      try {
        const saved = JSON.parse(stored ?? 'null') as {
          checkedItems?: unknown;
          photoAge?: unknown;
          photoTarget?: unknown;
        } | null;
        if (Array.isArray(saved?.checkedItems))
          setCheckedItems(
            saved.checkedItems.filter((item): item is string => typeof item === 'string')
          );
        if (typeof saved?.photoAge === 'string') setPhotoAge(saved.photoAge);
        if (typeof saved?.photoTarget === 'string') setPhotoTarget(saved.photoTarget);
      } catch {
        // Treat malformed device-local data as an empty checklist.
      } finally {
        setStorageLoaded(true);
      }
    });
  }, [storageKey]);

  useEffect(() => {
    if (!storageLoaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ checkedItems, photoAge, photoTarget }));
    } catch {
      queueMicrotask(() => setStorageUnavailable(true));
    }
  }, [checkedItems, photoAge, photoTarget, storageKey, storageLoaded]);

  return (
    <SectionCard title="Google Business Profile health" titleLevel={2}>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4" aria-labelledby="profile-checklist-title">
          <div>
            <h3 id="profile-checklist-title" className="font-medium">
              Owner checklist
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              Check the live profile manually. DevFathom does not change or publish profile data.
              {!storageUnavailable && ' Your progress is saved on this device for this branch.'}
            </p>
            {storageUnavailable && (
              <p role="alert" className="mt-1 text-sm text-text-body">
                Progress could not be saved on this device. Keep this page open or record your
                checks manually.
              </p>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className="sr-only">Profile health checks</legend>
            {PROFILE_ITEMS.map(([key, label]) => (
              <label key={key} className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={checkedItems.includes(key)}
                  onChange={(event) =>
                    setCheckedItems((current) =>
                      event.target.checked
                        ? [...new Set([...current, key])]
                        : current.filter((item) => item !== key)
                    )
                  }
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Days since latest photo
              <Input
                value={photoAge}
                onChange={(event) => setPhotoAge(event.target.value)}
                type="number"
                min="0"
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm">
              Your photo freshness target (days)
              <Input
                value={photoTarget}
                onChange={(event) => setPhotoTarget(event.target.value)}
                type="number"
                min="1"
                className="mt-1 min-h-11"
              />
            </label>
          </div>
          {hasPhotoValues && !photoValuesValid && (
            <p role="alert" className="text-sm text-text-body">
              Enter whole numbers: zero or more days since the latest photo and a target of at least
              one day.
            </p>
          )}
          {photoValuesValid && (
            <p role="status" className="text-sm text-text-body">
              {photoNeedsAttention
                ? 'Photo check needs attention against your configured target.'
                : 'Photo check is within your configured target.'}
            </p>
          )}
        </section>
        <section className="space-y-4" aria-labelledby="reply-draft-title">
          <div>
            <h3 id="reply-draft-title" className="font-medium">
              AI review reply draft
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              Creates copy only. Review it, then post manually in Google Business Profile. Nothing
              is auto-posted.
            </p>
          </div>
          <MarketingActionForm
            branchId={branchId}
            operation="review-reply"
            label="Generate reply draft"
          >
            <label className="block text-sm">
              Rating
              <select
                name="rating"
                defaultValue="5"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3"
              >
                {[5, 4, 3, 2, 1].map((rating) => (
                  <option key={rating} value={rating}>
                    {rating} stars
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Review text
              <textarea
                name="review"
                required
                maxLength={2000}
                rows={5}
                className="mt-1 w-full rounded-md border border-input bg-surface-raised p-3 focus-visible:outline-2 focus-visible:outline-ring"
              />
            </label>
            <label className="block text-sm">
              Tone
              <select
                name="tone"
                defaultValue="WARM"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3"
              >
                <option value="WARM">Warm</option>
                <option value="FORMAL">Formal</option>
              </select>
            </label>
          </MarketingActionForm>
        </section>
      </div>
    </SectionCard>
  );
}
