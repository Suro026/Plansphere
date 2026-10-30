import * as React from "react";
import { Check } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

/**
 * The small, stateless building blocks the design canvas is made of.
 *
 * Each one maps to a Nocturne class in globals.css. Kept in a single file
 * because none of them carries behaviour — they are named layout so a screen
 * reads like the design it came from.
 */

/* ───────────── tag ───────────── */

type TagTone = "accent" | "neutral" | "outline" | "danger" | "live";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
  /** Prepends the check glyph the design uses for confirmed states. */
  check?: boolean;
}

export const Tag = ({ tone = "neutral", check, className, children, ...props }: TagProps) => (
  <span className={cn("tag", `tag-${tone}`, className)} {...props}>
    {check ? <Check size={12} weight="bold" aria-hidden /> : null}
    {children}
  </span>
);

/* ───────────── kick (small caps label) ───────────── */

export const Kick = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("kick", className)} {...props} />
);

/* ───────────── metarow (key / value) ───────────── */

export interface MetaRowProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  children: React.ReactNode;
  /** Highlights the value in the accent's light step — "17 seats left". */
  emphasis?: boolean;
  /** Renders the value in the mono ticket/certificate face. */
  mono?: boolean;
}

export const MetaRow = ({ label, children, emphasis, mono, className, ...props }: MetaRowProps) => (
  <div className={cn("metarow", className)} {...props}>
    <span>{label}</span>
    <span className={cn(emphasis && "text-accent-300", mono && "code")}>{children}</span>
  </div>
);

export const MetaList = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col", className)} {...props} />
);

/* ───────────── kpi strip ───────────── */

export const KpiStrip = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex overflow-x-auto scrollbar-none border-y border-divider",
      className,
    )}
    {...props}
  />
);

export interface KpiProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A plain number counts up on mount/change; anything else (a string, "—", a formatted ReactNode) renders as-is. */
  value: React.ReactNode | number;
  label: React.ReactNode;
}

/**
 * Renders a plain number's real, final, `en-IN`-grouped value directly — no
 * hooks, no client component, nothing that can fail to render in a Server
 * Component (this is what every consumer actually sees, including with
 * JavaScript disabled). `data-countup` is a pure enhancement hook: the
 * root-level `CountUpController` (mounted once in layout.tsx, the same way
 * `Providers` is) finds it after hydration and animates from 0 up to this
 * same value — see count-up.tsx for why it lives there instead of inline.
 */
export const Kpi = ({ value, label, className, ...props }: KpiProps) => (
  <div className={cn("kpi min-w-[128px]", className)} {...props}>
    <div className="kpin" {...(typeof value === "number" ? { "data-countup": value } : {})}>
      {typeof value === "number" ? new Intl.NumberFormat("en-IN").format(value) : value}
    </div>
    <div className="kpil">{label}</div>
  </div>
);

/* ───────────── progress bar ───────────── */

export interface BarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0–1 */
  value: number;
  height?: number;
}

export const Bar = ({ value, height = 4, className, style, ...props }: BarProps) => {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <div
      className={cn("bar", className)}
      style={{ height, ...style }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...props}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
};

/* ───────────── panel / note / card ───────────── */

export const Panel = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("panel", className)} {...props} />
);

export interface NoteProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
}

export const Note = ({ title, className, children, ...props }: NoteProps) => (
  <div className={cn("note", className)} {...props}>
    {title ? <div className="note-title">{title}</div> : null}
    {children}
  </div>
);

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("card elev-sm", className)} {...props} />
);

/* ───────────── timeline ───────────── */

export const Timeline = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("timeline", className)} {...props} />
);

export interface TimelineItemProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  meta?: React.ReactNode;
  live?: boolean;
}

export const TimelineItem = ({ title, meta, live, className, ...props }: TimelineItemProps) => (
  <div className={cn("timeline-item", className)} data-live={live || undefined} {...props}>
    <div className="text-[13px]">{title}</div>
    {meta ? <div className="text-[11.5px] text-neutral-500">{meta}</div> : null}
  </div>
);

/* ───────────── placeholder artwork ───────────── */

export interface PlaceholderProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
  /** Real artwork, when there is one. Falls back to the striped block. */
  src?: string | null;
  alt?: string;
  /** Lighten-blends a photograph into the ground, per the design system. */
  lighten?: boolean;
}

export const Artwork = ({ label, src, alt = "", lighten = true, className, style, ...props }: PlaceholderProps) => {
  if (src) {
    return (
      <div className={cn("overflow-hidden bg-surface", className)} style={style} {...props}>
        {/*
          Not next/image: this renders any https:// URL a fest/event admin
          pasted in, not only Supabase/Firebase uploads (see httpsUrlSchema
          and ImageUploadField's allowUrl fallback). next/image requires
          every remote hostname to be allow-listed in next.config.ts; the
          only way to satisfy that for an arbitrary admin-pasted URL is a
          wildcard hostname pattern, which turns the image optimizer into an
          open proxy for whatever URL is pasted — a worse trade than the
          bytes this would save. `loading="lazy"` gets the deferred-loading
          behaviour without that risk.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element -- see above: arbitrary remote hostnames next/image cannot allow-list safely */}
        <img src={src} alt={alt} className={cn("h-full w-full object-cover", lighten && "lighten")} loading="lazy" decoding="async" />
      </div>
    );
  }

  // The label is a design-time annotation; it never renders in production.
  const showLabel = Boolean(label) && process.env.NODE_ENV !== "production";
  return (
    <div className={cn("ph", className)} style={style} aria-hidden {...props}>
      {showLabel ? (
        <div className="px-2.5 py-2 font-mono text-[10px] leading-none tracking-[0.04em] text-neutral-500">
          {label}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Generated hero artwork for pages without a photograph: a quiet field of
 * accent-tinted "crowd" dots that fades into the ground. Pure SVG, no asset,
 * decorative only.
 */
export const HeroField = ({ className, seed = 7 }: { className?: string; seed?: number }) => {
  const dots: Array<{ x: number; y: number; r: number; o: number }> = [];
  let v = seed;
  const rnd = () => ((v = (v * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 260; i += 1) {
    const x = rnd() * 1200;
    const y = 120 + rnd() * 360 + (x / 1200) * -40;
    dots.push({ x, y, r: 1.2 + rnd() * 2.6, o: 0.18 + rnd() * 0.5 });
  }
  return (
    <svg className={className} viewBox="0 0 1200 470" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      <defs>
        <radialGradient id="hero-glow" cx="78%" cy="40%" r="60%">
          <stop offset="0%" stopColor="var(--color-accent-fill)" stopOpacity="0.28" />
          <stop offset="60%" stopColor="var(--color-accent-fill)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--color-bg)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hero-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-bg)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--color-bg)" stopOpacity="1" />
        </linearGradient>
      </defs>
      <rect width="1200" height="470" fill="var(--color-bg)" />
      <rect width="1200" height="470" fill="url(#hero-glow)" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="var(--color-accent-fill)" opacity={d.o} />
      ))}
      <rect y="300" width="1200" height="170" fill="url(#hero-fade)" />
    </svg>
  );
};

/* ───────────── reveal / animated list ───────────── */

export interface RevealProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Stagger offset in ms — pass `index * 45` from a list, capped by the caller. */
  delay?: number;
  /** "rise" (fade + 6px translateY, the default, for cards/sections) or "fade" (opacity only, for table rows — some engines animate `transform` on `tr` inconsistently). */
  variant?: "rise" | "fade";
}

/**
 * Fades an element in once on mount — the landing page's own entrance
 * language (`--animate-rise`/`--animate-fade-in` in globals.css), reused for
 * product-page section/card reveals. `prefers-reduced-motion` needs no
 * handling here: the global rule in globals.css's `@layer base` already
 * forces every animation's duration to ~0 for every element, unconditionally.
 */
export const Reveal = ({ delay = 0, variant = "rise", style, className, ...props }: RevealProps) => (
  <div
    className={cn(variant === "rise" ? "animate-rise" : "animate-fade-in", className)}
    style={{ animationDelay: delay ? `${delay}ms` : undefined, animationFillMode: "backwards", ...style }}
    {...props}
  />
);

export interface AnimatedListProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Stagger step in ms between each direct child. */
  stagger?: number;
  /** Caps the stagger so a long list finishes appearing quickly. */
  maxDelay?: number;
  variant?: "rise" | "fade";
  /** The wrapper element — `"tbody"` for a `<table>`'s rows, `"div"` (default) for a card grid. */
  as?: "div" | "tbody";
  children?: React.ReactNode;
}

/**
 * Staggers each direct child's entrance — for card grids and list rows
 * (explore results, "my events", certificates, a staff/volunteer roster).
 * Clones each child rather than wrapping it in an extra element, so it never
 * changes a CSS Grid's item count; `as="tbody"` renders the wrapper itself as
 * a `<tbody>` so it stays valid inside a `<table>`.
 */
export const AnimatedList = ({ stagger = 45, maxDelay = 360, variant = "rise", as = "div", className, children, ...props }: AnimatedListProps) => {
  const kids = React.Children.map(children, (child, i) => {
    if (!React.isValidElement<{ className?: string; style?: React.CSSProperties }>(child)) return child;
    const delay = Math.min(i * stagger, maxDelay);
    return React.cloneElement(child, {
      className: cn(child.props.className, variant === "rise" ? "animate-rise" : "animate-fade-in"),
      style: { animationDelay: `${delay}ms`, animationFillMode: "backwards", ...child.props.style },
    });
  });
  const Wrapper = as;
  return (
    <Wrapper className={className} {...props}>
      {kids}
    </Wrapper>
  );
};

/* ───────────── table ───────────── */

export const TableWrap = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("table-wrap", className)} {...props} />
);

/**
 * The `.table` shell every admin/platform list was hand-rolling directly
 * (`<div className="table-wrap"><table className="table">...`) — same
 * markup and classes, just one place to touch. Callers keep writing their
 * own `<thead>`/`<tbody>` content; this only removes the repeated wrapper.
 */
export const Table = React.forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, children, ...props }, ref) => (
    <TableWrap>
      <table ref={ref} className={cn("table", className)} {...props}>
        {children}
      </table>
    </TableWrap>
  ),
);
Table.displayName = "Table";

/* ───────────── skeleton ───────────── */

export const Skeleton = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("skeleton", className)} aria-hidden {...props} />
);

/* ───────────── empty state ───────────── */

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}

export const EmptyState = ({ icon, title, body, action, className, ...props }: EmptyStateProps) => (
  <div
    className={cn(
      "panel flex flex-col items-start gap-2 p-6 text-left",
      className,
    )}
    {...props}
  >
    {icon ? <div className="mb-1 text-accent">{icon}</div> : null}
    <div className="text-[15px] font-medium">{title}</div>
    {body ? <div className="max-w-[48ch] text-[13px] text-neutral-400">{body}</div> : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
);

/* ───────────── page heading ───────────── */

export interface PageHeadingProps {
  kick?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  size?: "md" | "lg";
}

export const PageHeading = ({ kick, title, sub, actions, className, size = "md" }: PageHeadingProps) => (
  <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
    <div className="min-w-0">
      {kick ? <Kick className="mb-1.5">{kick}</Kick> : null}
      <h2 className={cn("m-0", size === "lg" ? "text-[29px]" : "text-[26px]")}>{title}</h2>
      {sub ? <div className="mt-1 text-[13px] text-neutral-500">{sub}</div> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </div>
);

/* ───────────── status pill for online/offline ───────────── */

export interface StatusBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "accent" | "neutral";
  children: React.ReactNode;
  trailing?: React.ReactNode;
}

export const StatusBanner = ({ tone = "accent", children, trailing, className, ...props }: StatusBannerProps) => (
  <div
    className={cn(
      "flex items-center gap-2 rounded-md px-[11px] py-[9px] text-[12.5px]",
      tone === "accent" ? "shadow-[inset_0_0_0_1px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_var(--color-divider)]",
      className,
    )}
    role="status"
    {...props}
  >
    <span
      className={cn("h-[7px] w-[7px] flex-none rounded-full", tone === "accent" ? "bg-accent" : "bg-neutral-600")}
      aria-hidden
    />
    <span className="flex-1">{children}</span>
    {trailing ? <span className="text-accent-300">{trailing}</span> : null}
  </div>
);
