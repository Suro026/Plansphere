"use client";

import * as React from "react";
import Link from "next/link";
import {
  Bell,
  BellRinging,
  Certificate,
  Check,
  Checks,
  ClockCountdown,
  CreditCard,
  ArrowUUpLeft,
  Bank,
  Envelope,
  FlagCheckered,
  Megaphone,
  PencilSimpleLine,
  Play,
  Prohibit,
  Ticket,
  Trophy,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { NOTIFICATION_LABELS, type Notification, type NotificationType } from "@/core/models/notification";
import { useAuth, useRepositories } from "@/components/providers";
import { useLive } from "@/components/admin/hooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Sheet, SheetContent } from "@/components/ui/overlays";
import { EmptyState, Tag } from "@/components/ui/primitives";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn, formatRelative } from "@/lib/utils";

/* ───────────── data ───────────── */

/** Live inbox for the signed-in account: newest first, capped by the repository. */
export const useNotifications = () => {
  const { session } = useAuth();
  const repos = useRepositories();
  const live = useLive<Notification[]>(
    (onChange, onError) => (session ? repos.notifications.subscribeForUser(session.uid, onChange, onError) : () => undefined),
    [session?.uid],
  );
  const items = React.useMemo(() => live.data ?? [], [live.data]);
  const unread = items.filter((n) => !n.read).length;

  const markRead = React.useCallback(
    async (id: string) => {
      await repos.notifications.markRead(id).catch(() => undefined);
    },
    [repos],
  );
  // The live subscription reflects both writes; no local state to reconcile.
  const markAllRead = React.useCallback(async () => {
    if (!session) return 0;
    return repos.notifications.markAllRead(session.uid).catch(() => 0);
  }, [repos, session]);

  return { items, unread, loading: session ? live.data === null : false, markRead, markAllRead };
};

/* ───────────── presentation ───────────── */

const ICONS: Record<NotificationType, Icon> = {
  registration_confirmed: Ticket,
  registration_cancelled: Prohibit,
  payment_required: CreditCard,
  refund_update: ArrowUUpLeft,
  payment_account: Bank,
  team_invite: UsersThree,
  team_update: UsersThree,
  waitlist_promoted: ClockCountdown,
  event_reminder: BellRinging,
  event_updated: PencilSimpleLine,
  event_cancelled: Prohibit,
  attendance_recorded: Check,
  certificate_issued: Certificate,
  results_published: Trophy,
  announcement: Megaphone,
  match_starting: Play,
  tournament_final_started: FlagCheckered,
  champion_declared: Trophy,
};

export const NotificationRow = ({ item, onOpen, compact }: { item: Notification; onOpen: (item: Notification) => void; compact?: boolean }) => {
  const IconFor = ICONS[item.type] ?? Envelope;
  const inner = (
    <>
      <span className={cn("mt-[3px] grid h-7 w-7 flex-none place-items-center rounded-full", item.read ? "text-neutral-500 shadow-[inset_0_0_0_1px_var(--color-divider)]" : "text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]")}>
        <IconFor size={15} weight={item.read ? "regular" : "fill"} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className={cn("truncate text-[13.5px]", !item.read && "font-medium")}>{item.title}</span>
          <span className="whitespace-nowrap text-[11px] text-neutral-500">{formatRelative(item.createdAt)}</span>
        </span>
        {item.body ? <span className={cn("mt-0.5 block text-[12.5px] text-neutral-300", compact && "line-clamp-2")}>{item.body}</span> : null}
        {!compact ? (
          <span className="mt-1.5 block">
            <Tag tone={item.read ? "neutral" : "outline"}>{NOTIFICATION_LABELS[item.type]}</Tag>
          </span>
        ) : null}
      </span>
    </>
  );
  const cls = cn(
    "flex w-full items-start gap-3 rounded-md px-2.5 py-2.5 text-left text-inherit no-underline transition-colors",
    "hover:bg-[color-mix(in_srgb,var(--color-text)_5%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    !item.read && "bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]",
  );
  return item.link ? (
    <Link href={item.link} className={cls} onClick={() => onOpen(item)}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={() => onOpen(item)}>
      {inner}
    </button>
  );
};

const InboxHeader = ({ count, loading, unread, onMarkAll, compact }: { count: number; loading: boolean; unread: number; onMarkAll: () => void; compact?: boolean }) => (
  <div className="mb-2 flex items-center justify-between gap-3">
    <span className="text-[12.5px] text-neutral-500">{loading ? "Loading…" : unread ? `${unread} unread` : count ? "All caught up" : ""}</span>
    <div className="flex items-center gap-1">
      {unread > 0 ? (
        <Button variant="ghost" size="sm" onClick={onMarkAll}>
          <Checks size={15} aria-hidden /> Mark all read
        </Button>
      ) : null}
      {compact ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/notifications">See all</Link>
        </Button>
      ) : null}
    </div>
  </div>
);

const Inbox = ({ items, loading, unread, onMarkAll, onOpen, compact }: { items: Notification[]; loading: boolean; unread: number; onMarkAll: () => void; onOpen: (n: Notification) => void; compact?: boolean }) => (
  <>
    <InboxHeader count={items.length} loading={loading} unread={unread} onMarkAll={onMarkAll} compact={compact} />
    {loading ? null : items.length === 0 ? (
      <EmptyState title="Nothing yet" body="Registrations, team invitations, waitlist promotions, results, certificates and organizer announcements show up here." />
    ) : (
      <div className={cn("-mx-1 flex flex-col", compact && "max-h-[60dvh] overflow-y-auto")}>
        {(compact ? items.slice(0, 12) : items).map((n) => (
          <NotificationRow key={n.id} item={n} onOpen={onOpen} compact={compact} />
        ))}
      </div>
    )}
  </>
);

/* ───────────── the bell ───────────── */

/**
 * The bell at the end of the nav. Opening it does not mark anything read:
 * a row is read when it is opened, or all at once by the button. Phones get
 * a bottom sheet, wider screens a dialog.
 */
export const NotificationBell = ({ className }: { className?: string }) => {
  const { session } = useAuth();
  const { items, unread, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = React.useState(false);
  const wide = useMediaQuery("(min-width: 640px)");

  if (!session) return null;

  // Rows with a link are <Link>s and navigate themselves; this just closes
  // the panel and marks the row read.
  const onOpen = (n: Notification) => {
    if (!n.read) void markRead(n.id);
    setOpen(false);
  };

  const trigger = (
    <button
      type="button"
      className={cn("btn btn-ghost btn-icon relative", className)}
      aria-label={unread ? `${unread} unread notifications` : "Notifications"}
      onClick={() => setOpen(true)}
    >
      <Bell size={18} weight={unread ? "fill" : "regular"} />
      {unread ? (
        <span className="absolute -right-0.5 -top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-accent px-1 text-[10px] font-medium leading-none text-bg" aria-hidden>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </button>
  );

  const body = <Inbox items={items} loading={loading} unread={unread} onMarkAll={() => void markAllRead()} onOpen={onOpen} compact />;

  return wide ? (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger}
      <DialogContent title="Notifications">{body}</DialogContent>
    </Dialog>
  ) : (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger}
      <SheetContent title="Notifications">{body}</SheetContent>
    </Sheet>
  );
};

/** The full page (`/notifications`): same rows, the latest 100, grouped by day. */
export const NotificationCenter = () => {
  const { items, unread, loading, markRead, markAllRead } = useNotifications();
  const onOpen = (n: Notification) => {
    if (!n.read) void markRead(n.id);
  };
  const today = new Date().toDateString();
  const groups = React.useMemo(() => {
    const t: Notification[] = [];
    const earlier: Notification[] = [];
    for (const n of items) (n.createdAt.toDateString() === today ? t : earlier).push(n);
    return { today: t, earlier };
  }, [items, today]);

  return (
    <>
      <InboxHeader count={items.length} loading={loading} unread={unread} onMarkAll={() => void markAllRead()} />
      {loading ? null : items.length === 0 ? (
        <EmptyState title="Nothing yet" body="Registrations, team invitations, waitlist promotions, results, certificates and organizer announcements show up here." />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.today.length ? (
            <section>
              <div className="kick mb-1.5">Today</div>
              <div className="-mx-1 flex flex-col">{groups.today.map((n) => <NotificationRow key={n.id} item={n} onOpen={onOpen} />)}</div>
            </section>
          ) : null}
          {groups.earlier.length ? (
            <section>
              <div className="kick mb-1.5">Earlier</div>
              <div className="-mx-1 flex flex-col">{groups.earlier.map((n) => <NotificationRow key={n.id} item={n} onOpen={onOpen} />)}</div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
};
