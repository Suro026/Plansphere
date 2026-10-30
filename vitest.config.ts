import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Two projects:
 *
 *   unit      — pure domain logic and React components, jsdom, no network.
 *               `npm test`
 *   emulator  — repositories, security rules and the API route transactions
 *               against the Firebase emulators. Must run inside
 *               `firebase emulators:exec` so the emulators are up:
 *               `npm run test:emulator`
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    globals: false,
    // The emulator files each clear Firestore, so files must not run at the
    // same time; `npm run test:emulator` also passes --no-file-parallelism.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["tests/unit/**/*.test.ts", "tests/components/**/*.test.tsx"],
          setupFiles: ["tests/setup/jsdom.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "emulator",
          environment: "node",
          include: ["tests/emulator/**/*.test.ts"],
          setupFiles: ["tests/setup/emulator.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
