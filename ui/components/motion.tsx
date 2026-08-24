"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

// Brand easing lifted from the film: cubic-bezier(.16,1,.3,1).
const EASE = [0.16, 1, 0.3, 1] as const;

// Entrance fade-up — the film's signature reveal.
export function FadeUp({
  children,
  delay = 0,
  y = 14,
  className,
  ...rest
}: { children: ReactNode; delay?: number; y?: number; className?: string } & HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: EASE, delay }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// Staggered container — children reveal one after another.
export function Stagger({
  children,
  className,
  gap = 0.06,
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
}) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { staggerChildren: gap } } }}
      className={className}
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
  children: ReactNode;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// A card that lifts on hover with the brand's teal shadow.
export function LiftCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -3, boxShadow: "var(--shadow-lift)" }}
      transition={{ duration: 0.32, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
