/**
 * Environment for the emulator project. `firebase emulators:exec` exports
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST; everything else the
 * app reads is given a stable dummy so lazy initialisers succeed.
 */
const PROJECT = "plansphere-test";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ??= PROJECT;

process.env.NEXT_PUBLIC_FIREBASE_API_KEY ??= "fake-api-key";
process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??= `${PROJECT}.firebaseapp.com`;
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= PROJECT;
process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??= "1";
process.env.NEXT_PUBLIC_FIREBASE_APP_ID ??= "1:1:web:test";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.EMAIL_PROVIDER = "console";
process.env.NEXT_PUBLIC_FIREBASE_EMULATOR = "1";
process.env.RATE_LIMIT_DISABLED = "1";
