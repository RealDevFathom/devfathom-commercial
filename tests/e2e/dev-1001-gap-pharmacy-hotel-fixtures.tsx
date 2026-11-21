import type { ComponentProps, ReactNode } from 'react';

import { HotelExtrasCatalog } from '@/components/hotel/extras-catalog';
import {
  HotelFunctionSpacesPanel,
  type HotelFunctionSpacesView,
} from '@/components/hotel/function-spaces-panel';
import { HotelInventoryPanel, type HotelInventoryView } from '@/components/hotel/inventory-panel';
import {
  HotelJourneyTemplatesEditor,
  type HotelJourneyView,
} from '@/components/hotel/journey-templates-editor';
import { PharmacyCounterComputersConsole } from '@/components/pharmacy/counter-computers';
import { PharmacyCustomerOrderingConsole } from '@/components/pharmacy/customer-ordering-console';
import { DeliveryEvidenceForm } from '@/components/pharmacy/delivery-evidence-form';
import { ShelfLabelPrintPanel } from '@/components/pharmacy/inventory/shelf-label-print-panel';
import { PackingSlipPrintButton } from '@/components/pharmacy/inventory/transfers/packing-slip-print-button';
import { PharmacyPrinterSettingsConsole } from '@/components/pharmacy/printer-settings';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { hotelDepartmentOptions, hotelExtraRecurrenceOptions } from '@/lib/hotel/extras';
import {
  HOTEL_JOURNEY_CHANNEL_LABELS,
  HOTEL_JOURNEY_LANGUAGE_LABELS,
  HOTEL_JOURNEY_MOMENT_KINDS,
  HOTEL_JOURNEY_MOMENT_LABELS,
  HOTEL_JOURNEY_PLACEHOLDERS,
  HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
} from '@/lib/hotel/journey-templates';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

/** All records below are synthetic, local-only display fixtures. No action is submitted. */
const at = new Date('2026-11-20T09:00:00Z');
const selection = {
  userId: 'fixture-user',
  organizationId: 'fixture-org',
  branchId: 'fixture-property',
};
const branches = [
  { id: 'fixture-pharmacy-main', name: 'Garden pharmacy', code: 'GDN', city: 'Lahore' },
  { id: 'fixture-pharmacy-river', name: 'Riverside pharmacy', code: 'RIV', city: 'Lahore' },
];
const standardRoomType = {
  id: 'fixture-standard-room',
  organizationId: selection.organizationId,
  branchId: selection.branchId,
  code: 'STD',
  name: 'Standard room',
  nameUr: null,
  inventoryKind: 'ROOM',
  bedsPerRoom: null,
  description: 'An example private room.',
  baseAdults: 2,
  maxAdults: 2,
  maxChildren: 1,
  bedConfig: '1 king',
  amenities: [],
  images: [],
  upgradeRank: 0,
  sort: 0,
  active: true,
  createdAt: at,
  updatedAt: at,
  _count: { rooms: 1 },
};
const sharedRoomType = {
  ...standardRoomType,
  id: 'fixture-shared-room',
  code: 'SHARED',
  name: 'Shared room',
  inventoryKind: 'BED',
  bedsPerRoom: 2,
  bedConfig: '2 single beds',
  _count: { rooms: 0 },
};
const room = {
  id: 'fixture-room-101',
  organizationId: selection.organizationId,
  branchId: selection.branchId,
  roomTypeId: standardRoomType.id,
  inventoryKind: 'ROOM',
  number: '101',
  floor: '1',
  features: [],
  connectingRoomId: null,
  genderPolicy: 'ANY',
  status: 'VACANT_DIRTY',
  statusChangedAt: at,
  statusChangedBy: selection.userId,
  active: true,
  createdAt: at,
  updatedAt: at,
  roomType: {
    id: standardRoomType.id,
    code: 'STD',
    name: 'Standard room',
    inventoryKind: 'ROOM',
    bedsPerRoom: null,
  },
  connectingRoom: null,
  beds: [],
  blocks: [],
};
const inventory = {
  roomTypes: {
    roomTypes: [standardRoomType, sharedRoomType],
    kindOptions: [
      { value: 'ROOM', label: 'Room', description: 'Sold as a whole room.', enabled: true },
      {
        value: 'BED',
        label: 'Bed in a shared room',
        description: 'Sold one bed at a time.',
        enabled: true,
      },
      { value: 'UNIT', label: 'Unit', description: 'A self-contained unit.', enabled: false },
    ],
    roomLimit: { max: 50, used: 1 },
  },
  rooms: {
    rooms: [room],
    statusOptions: [
      { value: 'VACANT_CLEAN', label: 'Vacant, clean', housekeeping: true },
      { value: 'VACANT_DIRTY', label: 'Vacant, dirty', housekeeping: true },
      { value: 'INSPECTED', label: 'Inspected', housekeeping: true },
      { value: 'OUT_OF_ORDER', label: 'Out of order', housekeeping: false },
      { value: 'OUT_OF_SERVICE', label: 'Out of service', housekeeping: false },
    ],
    blockKindOptions: [
      { value: 'OUT_OF_ORDER', label: 'Out of order', description: 'Repair needed.' },
      { value: 'OUT_OF_SERVICE', label: 'Out of service', description: 'Temporarily unavailable.' },
    ],
    genderPolicyOptions: [
      { value: 'ANY', label: 'No restriction' },
      { value: 'MALE', label: 'Men only' },
      { value: 'FEMALE', label: 'Women only' },
    ],
  },
} as HotelInventoryView;

const spaces: HotelFunctionSpacesView = {
  branchId: selection.branchId,
  timezone: 'Asia/Karachi',
  enabled: true,
  spaces: [
    {
      id: 'fixture-hall',
      branchId: selection.branchId,
      name: 'Example Hall',
      nameUr: null,
      layouts: [
        { layout: 'Theatre', capacity: 120 },
        { layout: 'Banquet', capacity: 80 },
      ],
      pricing: { hourlyMinor: 250000 },
      setupMinutes: 30,
      teardownMinutes: 30,
      active: true,
      updatedAt: at,
      maxCapacity: 120,
    },
  ],
  bookings: [],
  kindOptions: [
    { value: 'HOLD', label: 'Tentative hold' },
    { value: 'FUNCTION', label: 'Confirmed function' },
  ],
};

const extras: ComponentProps<typeof HotelExtrasCatalog>['initial'] = {
  extras: [],
  departmentOptions: hotelDepartmentOptions,
  recurrenceOptions: hotelExtraRecurrenceOptions,
};
const journey: HotelJourneyView = {
  branchId: selection.branchId,
  templates: [],
  canApprove: true,
  quietHours: { startMinute: 1320, endMinute: 420 },
  propertyTimezone: 'Asia/Karachi',
  moments: Object.entries(HOTEL_JOURNEY_MOMENT_LABELS).map(([value, label]) => ({
    value: value as HotelJourneyView['moments'][number]['value'],
    label,
    kind: HOTEL_JOURNEY_MOMENT_KINDS[value as keyof typeof HOTEL_JOURNEY_MOMENT_KINDS],
    placeholders: HOTEL_JOURNEY_PLACEHOLDERS[value as keyof typeof HOTEL_JOURNEY_PLACEHOLDERS],
  })),
  channels: Object.entries(HOTEL_JOURNEY_CHANNEL_LABELS).map(([value, label]) => ({
    value: value as HotelJourneyView['channels'][number]['value'],
    label,
  })),
  languages: Object.entries(HOTEL_JOURNEY_LANGUAGE_LABELS).map(([value, label]) => ({
    value: value as HotelJourneyView['languages'][number]['value'],
    label,
  })),
  statusLabels: HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
};

export const gapPharmacyHotelQueryData: Record<string, unknown> = {
  'pharmacySales.counterBranches': { branches },
  'pharmacySales.counterReceiptFormat': { layout: DEFAULT_RECEIPT_LAYOUT, revision: 1 },
  'pharmacySales.refundAccess': { authorized: true },
  'pharmacyPrinting.bridges': [],
  'pharmacyOffline.counters': [
    {
      id: 'fixture-counter',
      name: 'Garden till',
      status: 'ACTIVE',
      revokedAt: null,
      lastSeenAt: '2026-11-20T08:55:00Z',
      enrolledAt: '2026-11-01T09:00:00Z',
      receiptNumbersLeft: 100,
      offlineUnitsLeft: 40,
      failedOfflineSales: 0,
    },
  ],
  'pharmacyOffline.preparationPlan': { lots: [], limit: 100 },
  'pharmacyOrdering.branches': {
    branches,
    currency: 'PKR',
    customer: { id: 'fixture-customer-a' },
  },
  'pharmacyOrdering.catalog': [
    {
      medicineId: 'fixture-otc-medicine',
      packLevelId: 'fixture-otc-pack',
      productName: 'Example vitamin tablets',
      brandName: 'Example vitamins',
      presentation: 'Tablet',
      packLabel: 'Bottle of 30',
      availablePacks: 20,
      unitPriceMinor: 45000,
    },
  ],
  'pharmacyOrdering.mine': [],
  'pharmacyOrdering.staffQueue': [
    {
      id: 'fixture-delivery-order',
      branchId: branches[0].id,
      branch: branches[0],
      customer: { id: 'fixture-customer-a', displayName: 'Amina Example' },
      status: 'PACKING',
      fulfillment: 'DELIVER',
      addressLine: '12 Example Street',
      city: 'Lahore',
      counterSaleId: null,
      runner: null,
      reservationExpiresAt: '2026-11-20T18:00:00Z',
      lines: [
        {
          id: 'fixture-order-line',
          quantity: 1,
          lineTotalMinor: 45000,
          medicine: { productName: 'Example vitamin tablets', brandName: 'Example vitamins' },
        },
      ],
      events: [{ id: 'fixture-order-event', kind: 'PACKING', occurredAt: '2026-11-20T09:00:00Z' }],
      deliveryEvidence: [],
    },
  ],
  'pharmacyOrdering.customers': [
    { id: 'fixture-customer-a', displayName: 'Amina Example', phoneLast4: '0001' },
    { id: 'fixture-customer-b', displayName: 'Bilal Example', phoneLast4: '0002' },
  ],
  'pharmacyOrdering.runners': [
    { id: 'fixture-runner-a', name: 'Amina Example' },
    { id: 'fixture-runner-b', name: 'Bilal Example' },
  ],
  'hotelProperty.inventory.roomTypes.list': inventory.roomTypes,
  'hotelProperty.inventory.rooms.list': inventory.rooms,
  'hotelProperty.inventory.rooms.history': [],
  'hotelProperty.spaces.list': spaces,
  'hotelProperty.extras.list': extras,
  'hotelProperty.journeyTemplates.list': journey,
};

export const gapPharmacyHotelScreens: Record<string, ReactNode> = {
  'pharmacy-devices': (
    <>
      <PageHeader eyebrow="PHARMACY SETTINGS" heading="Counter computers" />
      <PharmacyCounterComputersConsole canManage organizationId="fixture-org" />
    </>
  ),
  'pharmacy-printing': (
    <>
      <PageHeader eyebrow="PHARMACY SETTINGS" heading="Printers and labels" />
      <PharmacyPrinterSettingsConsole canSave />
      <ShelfLabelPrintPanel
        title="Shelf labels"
        rows={[
          {
            inventoryLotId: 'fixture-label-lot',
            code: '1000000000000001',
            name: 'Example tablets',
            strength: '500 mg',
            packMrpMinor: 45000,
            stripMrpMinor: 15000,
            expiry: '2027-06',
            batchNumber: 'EXAMPLE-001',
            defaultCount: 2,
            unavailableReason: null,
          },
        ]}
      />
      <SectionCard title="Transfer packing slip" titleLevel={2}>
        <PackingSlipPrintButton
          slip={{
            reference: 'TR-EXAMPLE-001',
            status: 'DISPATCHED',
            fromBranch: branches[0].name,
            toBranch: branches[1].name,
            allocatedBy: 'Fixture Owner',
            approvedBy: 'Example manager',
            dispatchedBy: 'Fixture Owner',
            dispatchedAt: '2026-11-20T09:00:00Z',
            lines: [
              {
                medicineName: 'Example tablets',
                batchNumber: 'EXAMPLE-001',
                expiresAt: '2027-06-30',
                sourceLocation: 'Main store',
                destinationLocation: 'Riverside store',
                quantityUnits: 20,
                sealedPacks: 2,
                looseUnits: 0,
                unitsPerPack: 10,
              },
            ],
          }}
        />
      </SectionCard>
    </>
  ),
  'pharmacy-orders': (
    <>
      <PageHeader eyebrow="PHARMACY CUSTOMERS" heading="Customer orders" />
      <PharmacyCustomerOrderingConsole />
      <SectionCard title="Delivery evidence" titleLevel={2}>
        <DeliveryEvidenceForm
          branchId={branches[0].id}
          orderId="fixture-delivery-order"
          currency="PKR"
        />
      </SectionCard>
    </>
  ),
  'hotel-inventory': (
    <>
      <PageHeader eyebrow="HOTEL SETTINGS" heading="Rooms and beds" />
      <HotelInventoryPanel initial={inventory} selection={selection} />
    </>
  ),
  'hotel-extras': (
    <>
      <PageHeader eyebrow="HOTEL SETTINGS" heading="Extra charges" />
      <HotelExtrasCatalog initial={extras} selection={selection} />
    </>
  ),
  'hotel-function-spaces': (
    <>
      <PageHeader eyebrow="HOTEL SETTINGS" heading="Function spaces" />
      <HotelFunctionSpacesPanel initial={spaces} selection={selection} />
    </>
  ),
  'hotel-journey': (
    <>
      <PageHeader eyebrow="HOTEL SETTINGS" heading="Guest messages" />
      <HotelJourneyTemplatesEditor initial={journey} selection={selection} />
    </>
  ),
};

export const gapPharmacyHotelScreenSources = {
  'pharmacy-devices': ['src/components/pharmacy/counter-computers.tsx'],
  'pharmacy-printing': [
    'src/components/pharmacy/printer-settings.tsx',
    'src/components/pharmacy/inventory/shelf-label-print-panel.tsx',
    'src/components/pharmacy/inventory/transfers/packing-slip-print-button.tsx',
  ],
  'pharmacy-orders': [
    'src/components/pharmacy/customer-ordering-console.tsx',
    'src/components/pharmacy/delivery-evidence-form.tsx',
  ],
  'hotel-inventory': ['src/components/hotel/inventory-panel.tsx'],
  'hotel-extras': ['src/components/hotel/extras-catalog.tsx'],
  'hotel-function-spaces': ['src/components/hotel/function-spaces-panel.tsx'],
  'hotel-journey': ['src/components/hotel/journey-templates-editor.tsx'],
};

/** Real UI preparation for the screenshot runner; no mutation/submit action. */
export const gapPharmacyHotelPreparation = {
  'pharmacy-orders': { button: 'Add', summary: 'Delivery custody and reconciliation' },
  'hotel-inventory': { button: 'Status of room 101' },
  'hotel-function-spaces': { button: 'Book Example Hall' },
};
