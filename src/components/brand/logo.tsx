import { cn } from '@/lib/utils';

interface LogoProps {
  className?: string;
  variant?: 'orange' | 'white' | 'dark' | 'auto';
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const sizeMap = {
  sm: { icon: 'h-7 w-7', text: 'text-sm' },
  md: { icon: 'h-8 w-8', text: 'text-base' },
  lg: { icon: 'h-10 w-10', text: 'text-xl' },
};

const fillMap = {
  orange: '#FF4C29',
  white: '#FFFFFF',
  dark: '#17191C',
  auto: 'currentColor',
};

export function Logo({
  className,
  variant = 'orange',
  showText = true,
  size = 'md',
}: LogoProps) {
  const fill = fillMap[variant];
  const s = sizeMap[size];

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <svg
        viewBox="270 270 540 540"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={cn('shrink-0', s.icon)}
      >
        <path
          d="M405 651.522V405L270 525.443V763.043C270 788.987 291.013 810 316.957 810H554.557L675 675H428.478C415.565 675 405 664.435 405 651.522Z"
          fill={fill}
        />
        <path
          d="M675 428.478V675L810 554.557V405V316.957C810 291.013 788.987 270 763.043 270H675H525.443L405 405H651.522C664.435 405 675 415.565 675 428.478Z"
          fill={fill}
        />
        <path
          d="M704.348 704.348H798.261C804.717 704.348 810 709.63 810 716.087V810H716.087C709.63 810 704.348 804.717 704.348 798.261V704.348Z"
          fill={fill}
        />
      </svg>
      {showText && (
        <span
          className={cn(
            'font-display font-bold tracking-tight',
            s.text,
            variant === 'auto' && 'text-foreground'
          )}
        >
          Company
        </span>
      )}
    </div>
  );
}

export function LogoIcon({
  className,
  variant = 'orange',
}: {
  className?: string;
  variant?: 'orange' | 'white' | 'dark' | 'auto';
}) {
  const fill = fillMap[variant];

  return (
    <svg
      viewBox="270 270 540 540"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M405 651.522V405L270 525.443V763.043C270 788.987 291.013 810 316.957 810H554.557L675 675H428.478C415.565 675 405 664.435 405 651.522Z"
        fill={fill}
      />
      <path
        d="M675 428.478V675L810 554.557V405V316.957C810 291.013 788.987 270 763.043 270H675H525.443L405 405H651.522C664.435 405 675 415.565 675 428.478Z"
        fill={fill}
      />
      <path
        d="M704.348 704.348H798.261C804.717 704.348 810 709.63 810 716.087V810H716.087C709.63 810 704.348 804.717 704.348 798.261V704.348Z"
        fill={fill}
      />
    </svg>
  );
}
