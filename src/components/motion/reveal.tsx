'use client';

import { motion, useReducedMotion } from 'motion/react';
import { easeOutExpo } from '@/lib/motion';

/**
 * Reveal — fades + lifts its children into view on scroll.
 * Honors prefers-reduced-motion (renders statically).
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 16,
  once = true,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once, margin: '-60px' }}
      transition={{ duration: 0.55, ease: easeOutExpo, delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Stagger — orchestrates a cascade for nested <StaggerItem>s.
 */
export function Stagger({
  children,
  className,
  stagger = 0.07,
  delayChildren = 0,
  once = true,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
  delayChildren?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once, margin: '-60px' }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: stagger, delayChildren } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  className,
  y = 16,
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: easeOutExpo } },
      }}
    >
      {children}
    </motion.div>
  );
}
