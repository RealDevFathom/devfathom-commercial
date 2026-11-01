import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';

// WP-G1 growth seed. Idempotent. Seeds one GrowthSettings row (schema defaults)
// and the eight default message templates for every DEMO PHARMACY organization
// and nothing else. Templates are deliberately generic retail copy: none names
// a medicine, drug or prescription, and the refill reminder is a utility nudge
// (keep your item aside) with no discount — Meta's utility-message lane, not a
// promotion. Every body carries the STOP opt-out line the renderer requires.

const DEFAULT_LANGUAGE = 'ur-en';

/// key → bilingual (Urdu-English) body. {{var}} placeholders are filled at send
/// time by the renderer (WP-G4); a missing variable fails rendering rather than
/// leaking a raw placeholder, so each body only uses variables its campaign kind
/// supplies.
const DEFAULT_TEMPLATES: ReadonlyArray<{ key: string; body: string }> = [
  {
    key: 'birthday_offer',
    body: 'Salaam {{name}}! {{business}} ki taraf se salgirah mubarak. {{discount}} off for you till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  },
  {
    // Utility reminder only: names the item, offers to keep it aside, no discount.
    key: 'refill_reminder',
    body: 'Salaam {{name}}, reminder from {{business}}: your {{product}} may be running low. Reply to reserve it and we will keep it aside for you. Reply STOP to opt out.',
  },
  {
    key: 'winback',
    body: 'Salaam {{name}}, we have missed you at {{business}}! {{discount}} off your next visit till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  },
  {
    key: 'slow_day',
    body: 'Salaam {{name}}! Aaj {{business}} par {{discount}} off, sirf today till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  },
  {
    key: 'holiday',
    body: 'Salaam {{name}}! {{business}} wishes you a happy holiday. {{discount}} off till {{expires}}. Code {{code}}. Reply STOP to opt out.',
  },
  {
    key: 'review_request',
    body: 'Salaam {{name}}, shukriya for visiting {{business}}. Please share your feedback here: {{reviewUrl}}. Reply STOP to opt out.',
  },
  {
    key: 'referral',
    body: 'Salaam {{name}}! Apne doston ko {{business}} par bulayein with your code {{referralCode}} — aap dono ko faida. Reply STOP to opt out.',
  },
  {
    key: 'generic',
    body: 'Salaam {{name}}, a message from {{business}}. Reply STOP to opt out.',
  },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seedGrowthForDemoPharmacies(): Promise<void> {
  const demoPharmacies = await prisma.organization.findMany({
    where: { vertical: 'PHARMACY', isDemo: true },
    select: { id: true, displayName: true },
  });

  if (demoPharmacies.length === 0) {
    console.log('🌱 Growth seed: no demo pharmacies found; nothing to seed.');
    return;
  }

  for (const org of demoPharmacies) {
    await prisma.$transaction(async (tx) => {
      // Match seed.ts: run as a platform admin scoped to this organization so the
      // RLS session setting both satisfies the isolation policy and fills the
      // organizationId column default on every inserted row.
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_platform_admin', 'true', true),
                set_config('app.current_organization_id', $1, true)`,
        org.id
      );

      await tx.growthSettings.upsert({
        where: { organizationId: org.id },
        update: {},
        create: { organizationId: org.id },
      });

      for (const template of DEFAULT_TEMPLATES) {
        await tx.messageTemplate.upsert({
          where: {
            organizationId_key_language: {
              organizationId: org.id,
              key: template.key,
              language: DEFAULT_LANGUAGE,
            },
          },
          update: { body: template.body },
          create: {
            organizationId: org.id,
            key: template.key,
            language: DEFAULT_LANGUAGE,
            body: template.body,
          },
        });
      }
    });

    console.log(
      `  ✓ ${org.displayName} (${org.id}): 1 GrowthSettings + ${DEFAULT_TEMPLATES.length} templates`
    );
  }

  console.log(`🌱 Growth seed complete for ${demoPharmacies.length} demo pharmacy org(s).`);
}

async function run(): Promise<void> {
  try {
    await seedGrowthForDemoPharmacies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Growth demo seed failed.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

void run();
