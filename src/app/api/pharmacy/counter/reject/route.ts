import { pharmacyCounterRoute } from '@/server/routers/pharmacy-offline';

export const runtime = 'nodejs';
export const POST = pharmacyCounterRoute('reject');
