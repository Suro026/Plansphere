import type { Page, PageRequest, Unsubscribe } from "../models/common";
import type { UpdateUser, User, UserRole } from "../models/user";

/**
 * Accounts and profiles.
 *
 * Note what is *not* here: no `setRole`, no `createStaff`. Granting a role
 * above `student` happens on the server, through an API route that sets a
 * custom claim on the Auth token. Exposing it as a repository method would
 * imply the client could call it, and it cannot — Firestore rules reject any
 * client write that touches `role`.
 */
export interface UserRepository {
  getById(id: string): Promise<User | null>;

  getByEmail(email: string): Promise<User | null>;

  /**
   * Resolves several emails at once, for matching team members entered by
   * email to the accounts they later created. Emails are matched lowercased.
   * Missing emails are simply absent from the returned map.
   */
  findIdsByEmails(emails: string[]): Promise<Map<string, string>>;

  /**
   * Creates the profile document for a newly signed-up student.
   *
   * The account itself is created through the auth service; this writes the
   * `users/{uid}` document. It always writes `role: "student"` — the rules
   * reject anything else from a client.
   */
  createStudentProfile(input: {
    id: string;
    email: string;
    name: string;
    phone?: string;
    studentId?: string;
    college: string;
    department?: string;
    year?: number;
    emailVerified: boolean;
  }): Promise<User>;

  update(id: string, changes: UpdateUser): Promise<void>;

  /** Called after the user follows the verification link. */
  markEmailVerified(id: string): Promise<void>;

  list(options?: PageRequest & { role?: UserRole; festId?: string; search?: string }): Promise<Page<User>>;

  /** Live view of the staff list, for the super admin's staff screen. */
  subscribeToStaff(
    onChange: (users: User[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  countByRole(): Promise<Record<UserRole, number>>;
}
