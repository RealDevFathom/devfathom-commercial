import { z } from 'zod';
const text = z.string().trim().min(1).max(200);
const optional = z.string().trim().max(200).default('');
export const workspaceRequestSchema = z
  .object({
    vertical: z.enum(['pharmacy', 'restaurant', 'hotel']),
    companyName: text,
    ownerName: text,
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    phone: text,
    address: text,
    city: optional,
    branchName: optional,
    province: optional,
    ntn: optional,
    licenceCategory: optional,
    licenceNumber: optional,
    validUntil: optional,
    issuingAuthority: optional,
    pharmacistName: optional,
    pharmacistRegistration: optional,
    branches: z.enum(['1', '2 to 5', '6 or more']).default('1'),
    channels: z
      .array(z.enum(['Dine-in', 'Takeaway', 'Delivery']))
      .max(3)
      .default([]),
    businessDayCloses: optional,
    propertyMode: z.enum(['Hotel', 'Hostel', 'Apartments', 'Resort', 'Venue']).default('Hotel'),
    rooms: optional,
    checkIn: optional,
    checkOut: optional,
    authorized: z.literal('on'),
  })
  .superRefine((data, ctx) => {
    const requireField = (key: keyof typeof data) => {
      if (!data[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'This field is required.' });
    };
    if (data.vertical === 'pharmacy') {
      for (const key of [
        'branchName',
        'province',
        'city',
        'licenceCategory',
        'licenceNumber',
        'validUntil',
        'pharmacistName',
        'pharmacistRegistration',
      ] as const)
        requireField(key);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(data.validUntil) ||
        !Number.isFinite(Date.parse(data.validUntil)) ||
        data.validUntil < new Date().toISOString().slice(0, 10)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['validUntil'],
          message: 'Enter a valid, unexpired licence date.',
        });
    }
    if (data.vertical === 'restaurant') {
      requireField('branchName');
      requireField('businessDayCloses');
      if (!data.channels.length)
        ctx.addIssue({
          code: 'custom',
          path: ['channels'],
          message: 'Choose at least one order channel.',
        });
    }
    if (data.vertical === 'hotel') {
      requireField('city');
      requireField('rooms');
      requireField('checkIn');
      requireField('checkOut');
      if (!/^\d+$/.test(data.rooms) || Number(data.rooms) < 1 || Number(data.rooms) > 100000)
        ctx.addIssue({
          code: 'custom',
          path: ['rooms'],
          message: 'Enter a room count between 1 and 100000.',
        });
    }
    for (const key of ['businessDayCloses', 'checkIn', 'checkOut'] as const) {
      if (data[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[key]))
        ctx.addIssue({ code: 'custom', path: [key], message: 'Enter a valid time.' });
    }
  });
