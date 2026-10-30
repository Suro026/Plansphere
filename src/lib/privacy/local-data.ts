/**
 * Personal data this app keeps in the browser, and how it is removed.
 *
 * Signing out of a shared computer must not leave the last person's registrations, teammates and ticket codes in
 * `localStorage` for the next person to open. The cache is keyed by account id, so removing one account's copy can
 * never remove another's.
 */

/** Where `useMyEntries` keeps a signed-in student's entries (registrations, teams, ticket codes) so the pass opens offline. */
export const ENTRIES_CACHE_KEY = "plansphere.entries.v1";

export const entriesCacheKey = (uid: string): string => `${ENTRIES_CACHE_KEY}.${uid}`;

/**
 * Removes the cached entries of exactly one account. Storage can be blocked (private windows, quota, policies), and a
 * failure here must never get in the way of signing out or in, so it is swallowed.
 */
export const clearUserLocalData = (uid: string): void => {
  if (!uid) return;
  try {
    window.localStorage.removeItem(entriesCacheKey(uid));
  } catch {
    // Nothing more can be done from here.
  }
};
