import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges class names, letting a later Tailwind utility override an earlier one. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

/** `1,204` — Indian-locale grouping is what the design's figures use. */
export const formatCount = (value: number): string => new Intl.NumberFormat("en-IN").format(value);

/** `68.4%` */
export const formatPercent = (numerator: number, denominator: number, digits = 1): string =>
  denominator === 0 ? "—" : `${((numerator / denominator) * 100).toFixed(digits)}%`;

/** `13 Feb` / `13 Feb 2026` from a `YYYY-MM-DD` calendar date, without timezone drift. */
export const formatCalendarDate = (
  value: string | undefined,
  options: { year?: boolean } = {},
): string => {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
};

/** `12–14 Feb` or `27 Feb – 1 Mar` for a fest's span. */
export const formatDateRange = (start: string, end: string): string => {
  if (!start) return "—";
  if (!end || end === start) return formatCalendarDate(start);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) {
    return `${sd}–${ed} ${formatCalendarDate(start).split(" ")[1]}`;
  }
  return `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`;
};

/** `09:02` from a Date, in the viewer's zone. */
export const formatClock = (date: Date | undefined | null): string =>
  date ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date) : "—";

/** `09:02:41` */
export const formatClockSeconds = (date: Date | undefined | null): string =>
  date
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date)
    : "—";

/** `9 min ago`, `2 h ago`, `Yesterday`, else a short date. */
export const formatRelative = (date: Date | undefined | null, now: Date = new Date()): string => {
  if (!date) return "—";
  const diff = Math.max(0, now.getTime() - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
};

/** `Team of 2–4` / `Solo` */
export const formatTeamSize = (eventType: "solo" | "team", size: { min: number; max: number }): string =>
  eventType === "solo" ? "Solo" : size.min === size.max ? `Team of ${size.max}` : `Team of ${size.min}–${size.max}`;

/** Two-letter initials for an avatar fallback. */
export const initials = (name: string | undefined | null): string =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** URL-safe slug from a title. */
export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** Reads a `?next=` style redirect safely — only same-origin relative paths. */
export const safeRedirect = (value: string | null | undefined, fallback: string): string => {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
};
