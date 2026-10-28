'use client';

import { Download, Printer } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';

export type MedicationCardData = {
  id: string;
  medicineName: string;
  strength: string;
  dosageForm: string;
  directionsEnglish: string;
  directionsUrdu: string;
  quantityDispensed: number;
  reminderAt: Date;
  expectedExhaustionAt: Date;
  channel: string;
};

const englishDate = new Intl.DateTimeFormat('en-PK', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const urduDate = new Intl.DateTimeFormat('ur-PK', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!
  );
}

function downloadableHtml(card: MedicationCardData): string {
  const refillEnglish = englishDate.format(card.reminderAt);
  const refillUrdu = urduDate.format(card.reminderAt);
  const row = (label: string, value: string) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(card.medicineName)} medication card</title><style>body{font-family:system-ui,sans-serif;color:CanvasText;background:Canvas;margin:2rem}.card{max-width:760px;margin:auto;border:1px solid GrayText;border-radius:16px;padding:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.ur{direction:rtl;text-align:right}dl{display:grid;gap:12px}dt{font-size:12px;color:GrayText}dd{font-weight:600;margin:2px 0 0}@media(max-width:600px){.grid{grid-template-columns:1fr}}@media print{body{margin:0}.card{border:0}}</style></head><body><article class="card"><h1>${escapeHtml(card.medicineName)}</h1><div class="grid"><section lang="en" dir="ltr"><h2>Medication</h2><dl>${row('Medicine', card.medicineName)}${row('Strength', card.strength)}${row('Form', card.dosageForm)}${row('Directions', card.directionsEnglish)}${row('Quantity dispensed', String(card.quantityDispensed))}${row('Refill date', refillEnglish)}</dl></section><section class="ur" lang="ur" dir="rtl"><h2>ادویات کی معلومات</h2><dl>${row('دوا', card.medicineName)}${row('طاقت', card.strength)}${row('شکل', card.dosageForm)}${row('ہدایات', card.directionsUrdu)}${row('فراہم کردہ مقدار', String(card.quantityDispensed))}${row('دوبارہ حاصل کرنے کی تاریخ', refillUrdu)}</dl></section></div></article></body></html>`;
}

function CardField({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="font-mono text-[0.65rem] tracking-wide text-text-muted uppercase">{label}</dt>
      <dd className="mt-1 font-medium text-text-strong">{value}</dd>
    </div>
  );
}

export function MedicationCard({ card }: { card: MedicationCardData }) {
  const [printTarget, setPrintTarget] = useState(false);

  function print() {
    setPrintTarget(true);
    window.setTimeout(() => {
      window.print();
      setPrintTarget(false);
    }, 0);
  }

  function download() {
    const blob = new Blob([downloadableHtml(card)], { type: 'text/html;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${card.medicineName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-medication-card.html`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <article
      aria-label={`${card.medicineName} medication card`}
      className={cn(
        'medication-card rounded-lg border border-border-default bg-card p-5 shadow-xs',
        printTarget && 'medication-card-print-target'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-4">
        <div>
          <p className="font-mono text-xs tracking-wide text-text-muted uppercase">
            Medication card · ادویات کا کارڈ
          </p>
          <h3 className="mt-1 font-display text-xl font-semibold text-text-strong">
            {card.medicineName}
          </h3>
        </div>
        <StatusPill status="captured" label="Captured · not sent" className="text-text-strong" />
      </div>

      <div className="grid gap-6 py-5 md:grid-cols-2">
        <section lang="en" dir="ltr" aria-labelledby={`card-en-${card.id}`}>
          <h4 id={`card-en-${card.id}`} className="font-display font-semibold text-text-strong">
            English
          </h4>
          <dl className="mt-3 grid gap-3">
            <CardField label="Medicine" value={card.medicineName} />
            <CardField label="Strength" value={card.strength} />
            <CardField label="Form" value={card.dosageForm} />
            <CardField label="Directions" value={card.directionsEnglish} />
            <CardField label="Quantity dispensed" value={card.quantityDispensed} />
            <CardField label="Refill date" value={englishDate.format(card.reminderAt)} />
          </dl>
        </section>
        <div className="border-t border-border-subtle pt-5 md:border-t-0 md:border-s md:pt-0 md:ps-6">
          <section lang="ur" dir="rtl" aria-labelledby={`card-ur-${card.id}`}>
            <h4 id={`card-ur-${card.id}`} className="font-display font-semibold text-text-strong">
              اردو
            </h4>
            <dl className="mt-3 grid gap-3">
              <CardField label="دوا" value={card.medicineName} />
              <CardField label="طاقت" value={card.strength} />
              <CardField label="شکل" value={card.dosageForm} />
              <CardField label="ہدایات" value={card.directionsUrdu} />
              <CardField label="فراہم کردہ مقدار" value={card.quantityDispensed} />
              <CardField
                label="دوبارہ حاصل کرنے کی تاریخ"
                value={urduDate.format(card.reminderAt)}
              />
            </dl>
          </section>
        </div>
      </div>

      <div className="medication-card-actions flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
        <p className="text-xs text-text-muted">
          Reminder via {card.channel.toLowerCase()} · expected completion{' '}
          {englishDate.format(card.expectedExhaustionAt)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={print}>
            <Printer aria-hidden />
            Print card
          </Button>
          <Button type="button" variant="secondary" className="h-11" onClick={download}>
            <Download aria-hidden />
            Download card
          </Button>
        </div>
      </div>
    </article>
  );
}
