import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MedicationCard } from './medication-card';

const card = {
  id: 'capture_1',
  medicineName: 'Metformin',
  strength: '500 mg',
  dosageForm: 'Tablet',
  directionsEnglish: 'Take one tablet once daily',
  directionsUrdu: 'روزانہ ایک گولی لیں',
  quantityDispensed: 30,
  reminderAt: new Date('2026-09-28T09:00:00.000Z'),
  expectedExhaustionAt: new Date('2026-10-01T09:00:00.000Z'),
  channel: 'WHATSAPP',
};

describe('RX-07 bilingual medication card', () => {
  it('renders all required medicine and refill fields in English and Urdu', () => {
    render(<MedicationCard card={card} />);
    const article = screen.getByRole('article', { name: 'Metformin medication card' });
    const english = within(article).getByRole('region', { name: 'English' });
    const urdu = within(article).getByRole('region', { name: 'اردو' });

    expect(english).toHaveAttribute('dir', 'ltr');
    expect(urdu).toHaveAttribute('dir', 'rtl');
    expect(urdu).toHaveAttribute('lang', 'ur');
    const urduLayout = urdu.parentElement;
    expect(urduLayout).toHaveClass('md:border-s', 'md:ps-6');
    expect(urduLayout).not.toHaveAttribute('dir');
    expect(urduLayout).not.toHaveClass('md:border-l', 'md:pl-6');
    for (const value of [
      'Metformin',
      '500 mg',
      'Tablet',
      'Take one tablet once daily',
      'روزانہ ایک گولی لیں',
      '30',
    ]) {
      expect(within(article).getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(within(article).getByText('Refill date')).toBeDefined();
    expect(within(article).getByText('دوبارہ حاصل کرنے کی تاریخ')).toBeDefined();
  });

  it('labels both printable and downloadable actions', () => {
    render(<MedicationCard card={card} />);
    expect(screen.getByRole('button', { name: 'Print card' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download card' })).toBeEnabled();
  });
});
