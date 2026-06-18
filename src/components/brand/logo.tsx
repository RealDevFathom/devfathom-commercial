import { cn } from '@/lib/utils';

type LogoVariant = 'brand' | 'white' | 'dark' | 'auto';

interface LogoProps {
  className?: string;
  variant?: LogoVariant;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
  textClassName?: string;
}

const sizeMap = {
  sm: { icon: 'h-7 w-7', text: 'text-sm' },
  md: { icon: 'h-8 w-8', text: 'text-base' },
  lg: { icon: 'h-10 w-10', text: 'text-xl' },
};

/* The DevFathom mark — a connected forward chevron: a top block descending to
   a right-hand tip, then a longer arm stepping down to the lower-left, drawn
   as chunky rounded "bead" segments, with a detached node square resting in
   the chevron's mouth. Reads as forward motion descending into depth — a
   fathom. The node carries the single brass accent in the full-colour lockup. */

const MARK_VIEWBOX = '34 33 148 166';

function MarkPaths({ fill, nodeFill }: { fill: string; nodeFill?: string }) {
  return (
    <>
      <path
        d="M116 57 L155 97 L110 137 L75 175"
        fill="none"
        stroke={fill}
        strokeWidth="22"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x="98" y="39" width="38" height="36" rx="12" fill={fill} />
      <rect x="135" y="77" width="41" height="41" rx="13" fill={fill} />
      <rect x="90" y="118" width="41" height="38" rx="13" fill={fill} />
      <rect x="56" y="156" width="37" height="37" rx="12" fill={fill} />
      <rect x="40" y="81" width="35" height="34" rx="11" fill={nodeFill ?? fill} />
    </>
  );
}

export function FathomMark({
  className,
  variant = 'brand',
}: {
  className?: string;
  variant?: LogoVariant;
}) {
  // Full-colour app-icon lockup: Abyss field · Paper mark · Brass node.
  if (variant === 'brand') {
    return (
      <svg
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={cn('shrink-0', className)}
        aria-hidden="true"
      >
        <rect width="64" height="64" rx="14" fill="#0C2E2C" />
        <svg x="15" y="12" width="34" height="40" viewBox={MARK_VIEWBOX} fill="none">
          <MarkPaths fill="#F7F5EF" nodeFill="#BC8850" />
        </svg>
      </svg>
    );
  }

  // One-colour silhouettes (currentColor / reversed white / ink).
  const fill = variant === 'white' ? '#FFFFFF' : variant === 'dark' ? '#0C2E2C' : 'currentColor';
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <MarkPaths fill={fill} />
    </svg>
  );
}

export function Logo({
  className,
  variant = 'brand',
  showText = true,
  size = 'md',
  textClassName,
}: LogoProps) {
  const s = sizeMap[size];

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <FathomMark className={s.icon} variant={variant} />
      {showText && (
        // Wordmark — uniform-weight Oxanium (the logo face). No Dev/Fathom contrast.
        <span
          className={cn(
            'font-display font-semibold tracking-tight',
            s.text,
            variant === 'white' && 'text-white',
            variant === 'dark' && 'text-[#0C2E2C]',
            (variant === 'brand' || variant === 'auto') && 'text-foreground',
            textClassName
          )}
        >
          DevFathom
        </span>
      )}
    </div>
  );
}

/* Back-compat alias — existing call sites import `LogoIcon`. */
export function LogoIcon({
  className,
  variant = 'brand',
}: {
  className?: string;
  variant?: LogoVariant;
}) {
  return <FathomMark className={className} variant={variant} />;
}
