import {
  doc,
  getCountFromServer,
  getDocs,
  limit as limitTo,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import { notificationSchema, type CreateNotification, type Notification } from "@/core/models/notification";
import type { NotificationRepository } from "@/core/repositories/notification-repository";
import { COLLECTIONS, firestore } from "../client";
import { guard } from "../mapping";
import { col, parseDocs, sortBy, subscribeList } from "../query-helpers";

const notifications = () => col(COLLECTIONS.notifications);

export class FirestoreNotificationRepository implements NotificationRepository {
  listForUser(userId: string, limit = 30): Promise<Notification[]> {
    return guard("Loading notifications", async () => {
      const snapshot = await getDocs(query(notifications(), where("userId", "==", userId)));
      return sortBy(parseDocs(notificationSchema, snapshot.docs, COLLECTIONS.notifications), [(n) => n.createdAt, "desc"]).slice(0, limit);
    });
  }

  subscribeForUser(userId: string, onChange: (items: Notification[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(notifications(), where("userId", "==", userId)),
      notificationSchema,
      COLLECTIONS.notifications,
      (items) => onChange(sortBy(items, [(n) => n.createdAt, "desc"]).slice(0, 100)),
      onError,
    );
  }

  unreadCount(userId: string): Promise<number> {
    return guard("Counting notifications", async () => {
      const snapshot = await getCountFromServer(
        query(notifications(), where("userId", "==", userId), where("read", "==", false)),
      );
      return snapshot.data().count;
    });
  }

  /** Server-only. The rules deny notification creation from clients. */
  create(_input: CreateNotification): Promise<Notification> {
    void _input;
    return Promise.reject(new Error("Notifications are created server-side"));
  }

  createMany(_inputs: CreateNotification[]): Promise<number> {
    void _inputs;
    return Promise.reject(new Error("Notifications are created server-side"));
  }

  markRead(id: string): Promise<void> {
    return guard("Updating notification", async () => {
      await updateDoc(doc(notifications(), id), {
        read: true,
        readAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  }

  markAllRead(userId: string): Promise<number> {
    return guard("Updating notifications", async () => {
      const snapshot = await getDocs(
        query(notifications(), where("userId", "==", userId), where("read", "==", false), limitTo(400)),
      );

      if (snapshot.empty) return 0;

      const batch = writeBatch(firestore());
      for (const item of snapshot.docs) {
        batch.update(item.ref, { read: true, readAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
      await batch.commit();

      return snapshot.size;
    });
  }
}
