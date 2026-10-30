/**
 * Runs the demo seeder or cleaner.
 *
 *   npm run demo:seed     # needs `npm run demo:emulators` running in another terminal
 *   npm run demo:clean
 *
 * The TypeScript is bundled on the fly with esbuild (already a dependency of
 * the build tooling) so it can import the app's real route handlers and
 * repositories through the `@/` alias. It always runs under the emulator
 * environment from env.mjs; the scripts themselves also refuse any other target.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { demoEnv } from "./env.mjs";

const command = process.argv[2];
if (command !== "seed" && command !== "clean") {
  console.error("Usage: node scripts/demo/run.mjs <seed|clean>");
  process.exit(1);
}

const root = process.cwd();
const outDir = resolve(root, ".demo-build");
mkdirSync(outDir, { recursive: true });
const outfile = resolve(outDir, "main.cjs");

await build({
  entryPoints: [resolve(root, "scripts/demo/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  packages: "external",
  tsconfig: resolve(root, "tsconfig.json"),
  sourcemap: "inline",
  logLevel: "warning",
});

const result = spawnSync(process.execPath, ["--enable-source-maps", outfile], {
  stdio: "inherit",
  env: demoEnv({ DEMO_COMMAND: command, DEMO_SCALE: process.env.DEMO_SCALE ?? "1" }),
});
process.exit(result.status ?? 1);
