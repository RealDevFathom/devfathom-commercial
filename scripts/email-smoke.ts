// Send a single test email through Brevo to confirm the integration works.
//
// Run with:
//   bunx tsx scripts/email-smoke.ts you@example.com
// Falls back to BREVO_SENDER_EMAIL (the account owner) when no recipient given.
// First: loads .env.local and .env (real environment wins) before anything below reads it.
import '../prisma/load-env';

import { sendEmail } from '../src/lib/email';

async function main() {
  const to = process.argv[2] ?? process.env.BREVO_SENDER_EMAIL;
  if (!to) {
    console.error('❌ Pass a recipient: bunx tsx scripts/email-smoke.ts you@example.com');
    process.exit(1);
  }

  const result = await sendEmail({
    to: { email: to },
    subject: 'DevFathom email is working ✅',
    text: 'This is a Brevo transactional email smoke test from DevFathom.',
    html: `
      <div style="font-family: sans-serif; line-height: 1.6;">
        <h2 style="margin:0 0 8px;">DevFathom email is live</h2>
        <p>This is a Brevo transactional email smoke test. If you're reading this, the integration works.</p>
      </div>
    `,
  });

  console.log(`✅ Sent to ${to} — messageId=${result.messageId}`);
}

main().catch((e) => {
  console.error('❌ Failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
