import { RepositoryError, type RepositoryErrorCode } from "@/core/models/common";

/**
 * Calls the app's own API routes with the signed-in user's ID token.
 *
 * Used by repositories for the handful of writes that must run on the server —
 * registration (transactional capacity), staff creation, publishing results,
 * generating certificates. From a screen's point of view these are ordinary
 * repository methods; that they cross an HTTP boundary is an implementation
 * detail, which is what lets the Expo app call the very same endpoints.
 *
 * `firebaseAuth`/`appCheckToken` are dynamically imported rather than
 * imported at the top: this module is pulled in from ~24 files across every
 * area of the app (any form, any mutation), so a static import here would put
 * the Firebase client SDK on the first-load JS of every page that has so much
 * as a sign-in form, whether or not a call has actually been made yet.
 */
let firebaseClientPromise: Promise<typeof import("@/data/firebase/client")> | null = null;
const loadFirebaseClient = () => {
  if (!firebaseClientPromise) firebaseClientPromise = import("@/data/firebase/client");
  return firebaseClientPromise;
};
let appCheckPromise: Promise<typeof import("@/data/firebase/app-check")> | null = null;
const loadAppCheck = () => {
  if (!appCheckPromise) appCheckPromise = import("@/data/firebase/app-check");
  return appCheckPromise;
};

const STATUS_TO_CODE: Record<number, RepositoryErrorCode> = {
  400: "invalid-argument",
  401: "permission-denied",
  403: "permission-denied",
  404: "not-found",
  409: "already-exists",
  422: "failed-precondition",
  429: "unavailable",
  503: "unavailable",
};

export interface ApiErrorBody {
  error?: string;
  code?: string;
  details?: Record<string, string>;
}

export class ApiClientError extends RepositoryError {
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(status: number, body: ApiErrorBody) {
    super(
      STATUS_TO_CODE[status] ?? (status >= 500 ? "unavailable" : "unknown"),
      body.error ?? `Request failed (${status})`,
      body,
    );
    this.name = "ApiClientError";
    this.status = status;
    this.details = body.details;
  }
}

export const api = async <T>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: unknown; auth?: boolean } = {},
): Promise<T> => {
  const { body, auth: withAuth = true, headers, ...rest } = init;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");

  if (withAuth) {
    const { firebaseAuth } = await loadFirebaseClient();
    const user = firebaseAuth().currentUser;
    if (!user) throw new RepositoryError("permission-denied", "Sign in to continue.");
    requestHeaders.set("Authorization", `Bearer ${await user.getIdToken()}`);
  }

  // App Check proves the call came from the real app; absent when App Check
  // is not configured, in which case the server monitors rather than refuses.
  const { appCheckToken } = await loadAppCheck();
  const attestation = await appCheckToken();
  if (attestation) requestHeaders.set("X-Firebase-AppCheck", attestation);

  let response: Response;

  try {
    response = await fetch(path, {
      ...rest,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new RepositoryError(
      "unavailable",
      "Could not reach the server. Check your connection and try again.",
      error,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new ApiClientError(response.status, (parsed as ApiErrorBody) ?? {});
  }

  return parsed as T;
};

/**
 * Multipart upload to /api/uploads. Same auth and App Check headers as
 * `api()`, but the body is FormData and the browser sets the boundary.
 */
export const apiUpload = async <T>(path: string, file: File, field = "file"): Promise<T> => {
  const [{ firebaseAuth }, { appCheckToken }] = await Promise.all([loadFirebaseClient(), loadAppCheck()]);
  const user = firebaseAuth().currentUser;
  if (!user) throw new RepositoryError("permission-denied", "Sign in to continue.");
  const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}` });
  const attestation = await appCheckToken();
  if (attestation) headers.set("X-Firebase-AppCheck", attestation);

  const form = new FormData();
  form.append(field, file, file.name);

  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers, body: form });
  } catch (error) {
    throw new RepositoryError("unavailable", "Could not reach the server. Check your connection and try again.", error);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new ApiClientError(response.status, (parsed as ApiErrorBody) ?? {});
  return parsed as T;
};
