import type { Unsubscribe } from "../models/common";
import type { CreateNotification, Notification } from "../models/notification";

/**
 * In-app notifications.
 *
 * `subscribeForUser` is the hook the Expo app will attach push delivery to in
 * Phase 2 — the collection and the shapes stay identical, only the presentation
 * changes.
 */
export interface NotificationRepository {
  listForUser(userId: string, limit?: number): Promise<Notification[]>;

  subscribeForUser(
    userId: string,
    onChange: (notifications: Notification[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  unreadCount(userId: string): Promise<number>;

  /** Server-side only; the rules reject notification writes from clients. */
  create(input: CreateNotification): Promise<Notification>;

  createMany(inputs: CreateNotification[]): Promise<number>;

  markRead(id: string): Promise<void>;

  markAllRead(userId: string): Promise<number>;
}
