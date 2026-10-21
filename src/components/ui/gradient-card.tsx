import * as React from "react";
import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A gradient card: badge, title, description, a call to action and a large
 * faint illustration in the corner.
 *
 * Adapted from the supplied `gradient-card` component to Plansphere:
 *   - tints come from the brand ramp (mint / sage / stone / white) instead of
 *     orange / purple / teal;
 *   - the corner art is an icon passed in as `icon`, not a remote image URL, so
 *     the card loads nothing extra;
 *   - the hover lift is plain CSS (and switched off for reduced motion), so the
 *     card needs no animation library;
 *   - the call to action is a `next/link` stretched over the whole card, so the
 *     entire card is one keyboard-focusable link.
 */
const cardVariants = cva(
  "group relative flex h-full min-h-[230px] w-full flex-col justify-between overflow-hidden rounded-2xl border border-divider p-7 shadow-sm transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-within:ring-2 focus-within:ring-accent",
  {
    variants: {
      gradient: {
        mint: "bg-linear-to-br from-accent-fill/80 to-accent-fill/20",
        sage: "bg-linear-to-br from-accent-800 to-accent-900/30",
        stone: "bg-linear-to-br from-neutral-900/70 to-surface",
        white: "bg-linear-to-br from-surface to-neutral-900/30",
      },
    },
    defaultVariants: {
      gradient: "stone",
    },
  },
);

export interface GradientCardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof cardVariants> {
  badgeText: string;
  /** Any CSS colour for the badge dot, e.g. "#50675b". */
  badgeColor: string;
  title: string;
  description: string;
  ctaText: string;
  ctaHref: string;
  /** Decorative corner illustration (an icon). Hidden from assistive tech. */
  icon?: React.ReactNode;
}

const GradientCard = React.forwardRef<HTMLDivElement, GradientCardProps>(
  ({ className, gradient, badgeText, badgeColor, title, description, ctaText, ctaHref, icon, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ gradient }), className)} {...props}>
      {icon ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-6 -right-4 text-text opacity-[0.07] transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3 motion-reduce:transition-none motion-reduce:group-hover:transform-none [&>svg]:h-40 [&>svg]:w-40"
        >
          {icon}
        </div>
      ) : null}

      <div className="relative z-10 flex h-full flex-col">
        <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full bg-surface/70 px-3 py-1 text-[12px] font-medium text-neutral-200 backdrop-blur-sm">
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: badgeColor }} />
          {badgeText}
        </div>

        <div className="flex-grow">
          <h3 className="mb-2 font-display text-[24px] font-medium leading-[1.05] tracking-[-0.05em] text-text">{title}</h3>
          <p className="max-w-[280px] text-[13px] leading-[1.6] text-neutral-300">{description}</p>
        </div>

        <Link
          href={ctaHref}
          className="mt-6 inline-flex w-fit items-center gap-2 text-[13px] font-semibold text-text no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          {ctaText}
          <ArrowRight
            aria-hidden="true"
            className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1 motion-reduce:transition-none"
          />
        </Link>
      </div>
    </div>
  ),
);
GradientCard.displayName = "GradientCard";

export { GradientCard, cardVariants };
