import { Logo } from '@/components/brand/logo';
import { StatusPill } from '@/components/ui/status-pill';
import { verticalCopy, type LoginVertical } from './vertical';
import pharmacyStyles from '@/components/pharmacy/auth-screens.module.css';

export function LoginHero({
  vertical = 'default',
  registration = false,
}: {
  vertical?: LoginVertical;
  registration?: boolean;
}) {
  const copy = verticalCopy[vertical];
  const lines = registration
    ? vertical === 'pharmacy'
      ? ['Licensed before the', 'first sale.']
      : vertical === 'restaurant'
        ? ['Ready before the', 'first service.']
        : vertical === 'hotel'
          ? ['Your property.', 'Your next step.']
          : ['A workspace for', 'your next step.']
    : copy.lines;
  const content = (
    <>
      <div className="flex items-center justify-between gap-5">
        <Logo variant="white" size="lg" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{copy.tag}</span>
      </div>
      <div
        className={
          vertical === 'pharmacy'
            ? pharmacyStyles.introduction
            : registration
              ? 'mt-16'
              : 'my-20 xl:my-24'
        }
      >
        <p
          className={`text-text-on-accent font-semibold leading-[0.94] tracking-[-0.065em] ${registration ? 'text-[clamp(2.4rem,3.3vw,3.5rem)]' : 'text-[clamp(3rem,4.8vw,5.5rem)]'}`}
        >
          {lines.map((line, index) => (
            <span
              key={line}
              className={`block ${index === lines.length - 1 ? 'text-accent-brand' : ''}`}
            >
              {line}
            </span>
          ))}
        </p>
        {!registration && (
          <p className="mt-7 max-w-sm text-sm leading-7 text-text-on-accent">{copy.description}</p>
        )}
      </div>
      {registration ? <SetupGuide vertical={vertical} /> : <Sample vertical={vertical} />}
    </>
  );
  return (
    <aside
      className="fieldbook-login-hero studio-auth-hero"
      aria-label={
        vertical === 'pharmacy'
          ? registration
            ? 'What registration covers'
            : 'DevFathom for pharmacies'
          : undefined
      }
    >
      {vertical === 'pharmacy' && registration ? (
        <div className={pharmacyStyles.registrationHeroInner}>{content}</div>
      ) : (
        content
      )}
    </aside>
  );
}

function SetupGuide({ vertical }: { vertical: LoginVertical }) {
  if (vertical === 'default' || vertical === 'agency') {
    return (
      <p className="mt-10 text-sm leading-7 text-text-on-accent">
        Choose your workspace type, or ask your workspace admin for an account invitation.
      </p>
    );
  }
  const steps =
    vertical === 'pharmacy'
      ? [
          ['Legal business and province', 'The name on the licence, where you trade and your NTN.'],
          [
            'Premises and licences',
            'The drug sale licence, its validity and the pharmacist on record.',
          ],
          ['Owner account', 'You, as the first admin. Staff join later by invite.'],
        ]
      : vertical === 'restaurant'
        ? [
            [
              'The restaurant and how it serves',
              'Your name, your branches, and whether guests dine in, take away or order delivery.',
            ],
            ['First branch', 'Its address, and the hour your business day closes.'],
            ['Owner contact', 'You, as the first admin. Managers join later by invite.'],
          ]
        : [
            [
              'Property mode',
              'Hotel, hostel, apartments, resort or venue. Tell us how you operate.',
            ],
            ['Property facts', 'Name, address, city and proposed operating times.'],
            ['Owner contact', 'Your details for the setup review and account invitation.'],
          ];
  const nextSteps =
    vertical === 'pharmacy'
      ? [
          ['Branches and locations', 'Each branch with its fridge, safe and quarantine shelves.'],
          [
            'Medicine catalogue and opening stock',
            'What you sell, and the batches and expiry dates already on the shelf.',
          ],
          ['Devices and documents', 'Counter devices, receipts and fiscal invoices.'],
          ['Parallel run', 'A trial beside your current system before the counter goes live.'],
        ]
      : vertical === 'restaurant'
        ? [
            ['Menu and prices', 'What you sell, and what it costs.'],
            ['Tax and tenders', 'The tax you charge and the ways guests pay.'],
            ['Tills and kitchen screens', 'Each one enrolled to a branch with a one-time secret.'],
            [
              'Staff PINs',
              'Your team unlocks tills with a 4 to 8 digit PIN. Approvals take a manager’s.',
            ],
          ]
        : [
            ['Operating details', 'Confirm your property information and proposed times.'],
            ['Setup review', 'Agree the scope of your property workspace with a DevFathom admin.'],
            ['Owner invitation', 'Set up your account securely after approval.'],
            ['Activation', 'Your admin confirms when the workspace is ready.'],
          ];
  return (
    <div
      className={`mt-10 space-y-7 text-sm ${vertical === 'pharmacy' ? pharmacyStyles.setupGuide : ''}`}
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-on-accent">
        This form
      </p>
      {steps.map(([title, detail]) => (
        <div key={title} className="border-s-2 border-accent-brand ps-4">
          <p className="font-semibold text-text-on-accent">{title}</p>
          <p className="mt-1 text-xs leading-6 text-text-on-accent">{detail}</p>
        </div>
      ))}
      <p className="pt-6 font-mono text-[10px] uppercase tracking-widest text-text-on-accent">
        {vertical === 'hotel' ? 'Before activation' : 'After activation'}
      </p>
      {nextSteps.map(([title, detail]) => (
        <div
          key={title}
          data-after-activation={vertical === 'pharmacy' || undefined}
          className="border-s border-border-strong ps-4"
        >
          <p className="font-semibold text-text-on-accent">{title}</p>
          <p className="mt-1 text-xs leading-6 text-text-on-accent">{detail}</p>
        </div>
      ))}
    </div>
  );
}

function Sample({ vertical }: { vertical: LoginVertical }) {
  if (vertical === 'default' || vertical === 'agency' || vertical === 'hotel')
    return (
      <p className="mt-auto pt-12 text-xs leading-6 text-text-on-accent">
        {vertical === 'hotel'
          ? 'Property details → Setup review → Account invitation'
          : 'DevFathom · Your team’s workspace'}
      </p>
    );
  const pharmacy = vertical === 'pharmacy';
  const rows = pharmacy
    ? [
        ['Paracetamol 500 mg tablets', 'BATCH 24K118 · EXP 03/27', '2 strips'],
        ['Amoxicillin 250 mg/5 ml syrup', 'BATCH AX0931 · EXP 11/26', '1 bottle'],
        ['Oral rehydration salts', 'BATCH OR2207 · EXP 08/27', '3 sachets'],
      ]
    : [
        ['2 × Chicken karahi, half', '', 'Cooking'],
        ['4 × Garlic naan', '', 'Ready'],
        ['1 × Mint raita', '', 'New'],
      ];
  return (
    <div className={`mt-auto max-w-sm pt-6 ${pharmacy ? pharmacyStyles.sample : ''}`}>
      <div className="rounded-[var(--radius-xl)] border border-border-subtle bg-surface-card p-5 text-text-strong">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
              {pharmacy ? 'Counter' : 'Kitchen display'}
            </p>
            <p className="mt-2 text-sm font-semibold text-text-strong">
              {pharmacy ? 'Receipt 0418' : 'KOT 0412'}
            </p>
            {!pharmacy && <p className="mt-2 text-xs text-text-muted">Table 12, dine-in</p>}
          </div>
          {pharmacy ? (
            <StatusPill status="Paid" tone="success" />
          ) : (
            <span className="font-mono text-[10px] text-text-muted">6 min</span>
          )}
        </div>
        {rows.map(([name, detail, status]) => (
          <div
            key={name}
            className={`mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-4 text-xs ${pharmacy ? pharmacyStyles.sampleRow : ''}`}
          >
            <div>
              <p className="font-semibold text-text-strong">{name}</p>
              {detail && <p className="mt-2 font-mono text-[10px] text-text-muted">{detail}</p>}
            </div>
            <span className="shrink-0 font-mono text-[10px]">{status}</span>
          </div>
        ))}
        {pharmacy && (
          <p className="mt-4 text-xs leading-5 text-text-muted">
            Each line was allocated from the earliest expiry on the shelf.
          </p>
        )}
      </div>
      <p className="mt-3 text-xs text-text-on-accent">Sample data</p>
    </div>
  );
}
