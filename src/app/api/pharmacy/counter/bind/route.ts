import {
  bindPharmacyCounterBrowser,
  unbindPharmacyCounterBrowser,
} from '@/server/routers/pharmacy-offline-bind';

export const runtime = 'nodejs';
export const POST = bindPharmacyCounterBrowser;
export const DELETE = unbindPharmacyCounterBrowser;
