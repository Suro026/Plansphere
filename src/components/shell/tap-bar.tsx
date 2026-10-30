import Link from "next/link";
import type { Icon } from "@phosphor-icons/react";

export interface TapBarItem {
  href: string;
  label: string;
  icon: Icon;
  active: boolean;
}

/**
 * The phone bottom tap bar (`.tapbar`/`.tapitem` in globals.css) — previously
 * hand-rolled identically in `student-shell.tsx` and `volunteer-shell.tsx`.
 * Same markup, same classes, same active-icon-weight behavior; each shell
 * just builds its own `items` array (it already knows its own routes and
 * `usePathname()` match logic) and renders this instead.
 */
export const TapBar = ({ items, label }: { items: readonly TapBarItem[]; label: string }) => (
  <nav className="tapbar fixed inset-x-0 bottom-0 z-40 sm:hidden" aria-label={label}>
    {items.map((item) => {
      const Icon = item.icon;
      return (
        <Link key={item.href} href={item.href} className="tapitem" aria-current={item.active ? "page" : undefined}>
          <span className="tapdot">
            <Icon size={19} weight={item.active ? "fill" : "regular"} />
          </span>
          {item.label}
        </Link>
      );
    })}
  </nav>
);
